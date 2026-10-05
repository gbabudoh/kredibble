"""User accounts: registration, sign-in, email verification, password reset, deletion.

Sessions are server-side: the browser holds a random token in an httpOnly cookie and the
database stores only its SHA-256, so signing out or resetting a password revokes it.
The server knows who someone is and which plan they are on, never what they ask the AI.
"""
import hashlib
import secrets
from datetime import timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal, accounts_enabled, as_utc, get_db, utcnow
from app.mailer import send_email
from app.models import USER_TYPES, AuthSession, EmailToken, User
from app.ratelimit import client_ip, limit
from app.security import hash_password, verify_password

router = APIRouter()

COOKIE_NAME = "kredibble_session"
VERIFY_TTL = timedelta(hours=48)
RESET_TTL = timedelta(hours=1)
PASSWORD_MIN, PASSWORD_MAX = 10, 128

# Verified against when the email is unknown, so response time does not reveal which accounts exist.
_DUMMY_HASH = hash_password("timing-equaliser")


# --- request / response models ----------------------------------------------

def _check_password(value: str) -> str:
    if not PASSWORD_MIN <= len(value) <= PASSWORD_MAX:
        raise ValueError(f"Use {PASSWORD_MIN} to {PASSWORD_MAX} characters.")
    return value


def _check_user_type(value: str) -> str:
    if value not in USER_TYPES:
        raise ValueError(f"Must be one of: {', '.join(USER_TYPES)}.")
    return value


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: str | None = Field(default=None, max_length=80)
    user_type: str = "personal"

    _password = field_validator("password")(_check_password)
    _user_type = field_validator("user_type")(_check_user_type)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(max_length=PASSWORD_MAX)


class UpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=80)
    user_type: str | None = None

    @field_validator("user_type")
    @classmethod
    def _valid_type(cls, value: str | None) -> str | None:
        return None if value is None else _check_user_type(value)


class TokenRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class ResetRequest(TokenRequest):
    password: str

    _password = field_validator("password")(_check_password)


class EmailRequest(BaseModel):
    email: EmailStr


class PasswordRequest(BaseModel):
    password: str = Field(max_length=PASSWORD_MAX)


class Account(BaseModel):
    email: str
    display_name: str | None
    user_type: str
    plan: str
    email_verified: bool


class SessionState(BaseModel):
    enabled: bool
    account: Account | None


def _account(user: User) -> Account:
    return Account(
        email=user.email,
        display_name=user.display_name,
        user_type=user.user_type,
        plan=user.plan,
        email_verified=user.email_verified_at is not None,
    )


# --- helpers ----------------------------------------------------------------

def _sha256(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def same_origin(request: Request) -> None:
    """Rejects state-changing requests sent by other websites (CSRF), on top of SameSite cookies."""
    origin = request.headers.get("origin")
    if origin is None:
        return  # not sent by a browser fetch (curl, tests, server-to-server)
    own = f"{request.url.scheme}://{request.headers.get('host', '')}"
    if origin not in (own, settings.PUBLIC_BASE_URL, *settings.ALLOWED_ORIGINS):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Request from an unknown origin.")


def _cookie_secure(request: Request) -> bool:
    local_http = request.url.scheme == "http" and request.url.hostname in ("localhost", "127.0.0.1")
    return settings.SESSION_COOKIE_SECURE and not local_http


def _start_session(db: Session, user: User, request: Request, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(user_id=user.id, token_hash=_sha256(token), expires_at=utcnow() + timedelta(days=settings.SESSION_DAYS)))
    db.commit()
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=settings.SESSION_DAYS * 86400,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="lax",
        path="/api",
    )


def _end_session(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/api")


def current_user(request: Request, db: Session) -> User | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == _sha256(token)))
    if session is None:
        return None
    if as_utc(session.expires_at) <= utcnow():
        db.delete(session)
        db.commit()
        return None
    return session.user


def require_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = current_user(request, db)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please sign in.")
    return user


def _issue_email_token(db: Session, user: User, purpose: str, ttl: timedelta) -> str:
    # One live link per purpose: a new email invalidates the previous link.
    db.execute(delete(EmailToken).where(EmailToken.user_id == user.id, EmailToken.purpose == purpose))
    token = secrets.token_urlsafe(32)
    db.add(EmailToken(user_id=user.id, purpose=purpose, token_hash=_sha256(token), expires_at=utcnow() + ttl))
    db.commit()
    return token


def _consume_email_token(db: Session, token: str, purpose: str) -> User:
    record = db.scalar(select(EmailToken).where(EmailToken.token_hash == _sha256(token), EmailToken.purpose == purpose))
    if record is None or record.used_at is not None or as_utc(record.expires_at) <= utcnow():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This link is invalid or has expired. Request a new one.")
    record.used_at = utcnow()
    return record.user


PRIVACY_FOOTER = "\n\nKredibble never sees your chats or documents: the AI runs on your own device.\n"


def _send_verification(background: BackgroundTasks, db: Session, user: User) -> None:
    token = _issue_email_token(db, user, "verify", VERIFY_TTL)
    link = f"{settings.PUBLIC_BASE_URL}/?verify={token}"
    background.add_task(
        send_email, user.email, "Confirm your Kredibble email",
        f"Welcome to Kredibble.\n\nConfirm your email address by opening this link:\n{link}\n\n"
        f"The link works for 48 hours. If you did not create an account, you can ignore this email.{PRIVACY_FOOTER}",
    )


# --- endpoints --------------------------------------------------------------

@router.get("/me", response_model=SessionState)
def me(request: Request):
    """Who is signed in on this browser (account is null when signed out)."""
    if not accounts_enabled():
        return SessionState(enabled=False, account=None)
    with SessionLocal() as db:
        user = current_user(request, db)
        return SessionState(enabled=True, account=_account(user) if user else None)


@router.post("/register", response_model=Account, status_code=status.HTTP_201_CREATED, dependencies=[Depends(same_origin)])
def register(body: RegisterRequest, request: Request, response: Response, background: BackgroundTasks, db: Session = Depends(get_db)):
    limit(f"register:{client_ip(request)}", 5, 3600)
    email = body.email.lower()
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists. Sign in instead.")
    user = User(
        email=email,
        password_hash=hash_password(body.password),
        display_name=(body.display_name or "").strip() or None,
        user_type=body.user_type,
    )
    db.add(user)
    db.commit()
    _send_verification(background, db, user)
    _start_session(db, user, request, response)
    return _account(user)


@router.post("/login", response_model=Account, dependencies=[Depends(same_origin)])
def login(body: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower()
    limit(f"login-ip:{client_ip(request)}", 20, 600)
    limit(f"login:{email}", 8, 600)
    user = db.scalar(select(User).where(User.email == email))
    password_ok = verify_password(body.password, user.password_hash if user else _DUMMY_HASH)
    if user is None or not password_ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong email or password.")
    _start_session(db, user, request, response)
    return _account(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(same_origin)])
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == _sha256(token)))
        db.commit()
    _end_session(response)


@router.post("/me", response_model=Account, dependencies=[Depends(same_origin)])
def update(body: UpdateRequest, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if "display_name" in body.model_fields_set:
        user.display_name = (body.display_name or "").strip() or None
    if body.user_type is not None:
        user.user_type = body.user_type
    db.commit()
    return _account(user)


@router.post("/verify-email", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(same_origin)])
def verify_email(body: TokenRequest, db: Session = Depends(get_db)):
    user = _consume_email_token(db, body.token, "verify")
    user.email_verified_at = user.email_verified_at or utcnow()
    db.commit()


@router.post("/resend-verification", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(same_origin)])
def resend_verification(background: BackgroundTasks, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if user.email_verified_at is None:
        limit(f"resend:{user.id}", 3, 3600)
        _send_verification(background, db, user)


@router.post("/forgot-password", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(same_origin)])
def forgot_password(body: EmailRequest, request: Request, background: BackgroundTasks, db: Session = Depends(get_db)):
    """Always succeeds, so the response does not reveal whether an account exists."""
    limit(f"forgot:{client_ip(request)}", 5, 3600)
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user is None:
        return
    token = _issue_email_token(db, user, "reset", RESET_TTL)
    link = f"{settings.PUBLIC_BASE_URL}/?reset={token}"
    background.add_task(
        send_email, user.email, "Reset your Kredibble password",
        f"Someone asked to reset the password for this Kredibble account.\n\n"
        f"Choose a new password here:\n{link}\n\n"
        f"The link works for 1 hour. If this was not you, ignore this email: your password stays the same.{PRIVACY_FOOTER}",
    )


@router.post("/reset-password", response_model=Account, dependencies=[Depends(same_origin)])
def reset_password(body: ResetRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    limit(f"reset:{client_ip(request)}", 10, 3600)
    user = _consume_email_token(db, body.token, "reset")
    user.password_hash = hash_password(body.password)
    user.email_verified_at = user.email_verified_at or utcnow()  # the reset link proved they own the address
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))  # sign out every other browser
    db.commit()
    _start_session(db, user, request, response)
    return _account(user)


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(same_origin)])
def delete_account(body: PasswordRequest, request: Request, response: Response, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Permanently deletes the account, its sessions and pending email links."""
    limit(f"delete:{user.id}", 5, 600)
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Wrong password.")
    db.delete(user)
    db.commit()
    _end_session(response)
