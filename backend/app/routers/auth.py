from datetime import timedelta

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr

from app.config import settings
from app.security import create_access_token, decode_access_token, hash_password, verify_password

router = APIRouter()
bearer = HTTPBearer(auto_error=False)

# Verified against when the email is unknown, so response time does not reveal which accounts exist.
_DUMMY_HASH = hash_password("timing-equaliser", iterations=600_000)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    workgroup: str
    user_email: str


class CurrentUser(BaseModel):
    email: str
    workgroup: str


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> CurrentUser:
    if credentials is None:
        raise _unauthorized("Not authenticated.")
    try:
        claims = decode_access_token(credentials.credentials, settings.SECRET_KEY, settings.ALGORITHM)
    except jwt.PyJWTError:
        raise _unauthorized("Invalid or expired token.")
    if claims["sub"] not in settings.KREDIBBLE_USERS:
        raise _unauthorized("Account no longer exists.")
    return CurrentUser(email=claims["sub"], workgroup=claims.get("workgroup", "Default"))


@router.post("/login", response_model=TokenResponse)
async def login(credentials: LoginRequest):
    email = credentials.email.lower()
    user = settings.KREDIBBLE_USERS.get(email)
    password_ok = verify_password(credentials.password, user["password_hash"] if user else _DUMMY_HASH)
    if not user or not password_ok:
        raise _unauthorized("Invalid email or password.")

    workgroup = user.get("workgroup", "Default")
    token = create_access_token(
        {"sub": email, "workgroup": workgroup},
        settings.SECRET_KEY,
        settings.ALGORITHM,
        timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    return TokenResponse(access_token=token, token_type="bearer", workgroup=workgroup, user_email=email)


@router.get("/me", response_model=CurrentUser)
async def me(user: CurrentUser = Depends(get_current_user)):
    return user
