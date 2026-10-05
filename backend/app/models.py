"""Account tables. Identity, plan and sign-in state only: no chat or document content."""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, utcnow

# Who the account is for. Chosen at sign-up; picks the default workspace (and on the free plan,
# the one workspace allowed besides Personal Vault; see app/plans.py).
USER_TYPES = ("personal", "founder", "micro_business", "sme", "enterprise", "institution", "charity")

# What the account pays for (limits in app/plans.py). Everyone starts on free.
PLANS = ("free", "pro", "business", "enterprise")


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(80))
    user_type: Mapped[str] = mapped_column(String(32), default="personal")
    plan: Mapped[str] = mapped_column(String(32), default="free")
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    sessions: Mapped[list["AuthSession"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    email_tokens: Mapped[list["EmailToken"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)


class AuthSession(Base):
    """A signed-in browser. The cookie holds a random token; only its SHA-256 is stored."""
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="sessions")


class DailyUsage(Base):
    """Messages sent per account per day (the user's local calendar day). Counts only, no content."""
    __tablename__ = "daily_usage"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    messages: Mapped[int] = mapped_column(Integer, default=0)


class EmailToken(Base):
    """One-time link token for email verification or password reset (stored hashed)."""
    __tablename__ = "email_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String(16))  # "verify" | "reset"
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="email_tokens")
