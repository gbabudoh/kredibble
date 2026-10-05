"""Database access for user accounts (PostgreSQL in production; SQLite works for tests).

Only identity and plan data lives here. Chats, questions and documents never reach the server.
"""
from collections.abc import Iterator
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: datetime) -> datetime:
    """SQLite returns naive datetimes; PostgreSQL returns aware ones. Compare them as UTC."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _make_engine(url: str):
    if not url:
        return None
    if url.startswith("sqlite"):
        sqlite = create_engine(url, connect_args={"check_same_thread": False})
        # SQLite ignores foreign keys (and so ON DELETE CASCADE) unless asked, unlike PostgreSQL.
        event.listen(sqlite, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
        return sqlite
    return create_engine(url, pool_pre_ping=True)


engine = _make_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False) if engine else None


def accounts_enabled() -> bool:
    return SessionLocal is not None


def get_db() -> Iterator[Session]:
    if SessionLocal is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Accounts are not set up on this server.")
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
