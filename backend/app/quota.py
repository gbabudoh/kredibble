"""Daily message counting (counts only, never content). Days follow the user's own time zone."""
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from app.models import DailyUsage, User


def local_day(tz_name: str | None) -> date:
    """Today in the given IANA time zone (e.g. "Europe/London"); UTC if missing or unknown."""
    try:
        tz = ZoneInfo(tz_name) if tz_name else timezone.utc
    except (ZoneInfoNotFoundError, ValueError):
        tz = timezone.utc
    return datetime.now(tz).date()


def used_on(db: Session, user: User, day: date) -> int:
    return db.scalar(select(DailyUsage.messages).where(DailyUsage.user_id == user.id, DailyUsage.day == day)) or 0


def take_message(db: Session, user: User, day: date, limit: int | None) -> bool:
    """Counts one message for `day` unless `limit` is reached. Safe when two tabs send at once."""
    dialect = {"postgresql": postgresql, "sqlite": sqlite}[db.get_bind().dialect.name]
    db.execute(dialect.insert(DailyUsage).values(user_id=user.id, day=day, messages=0).on_conflict_do_nothing())
    query = update(DailyUsage).where(DailyUsage.user_id == user.id, DailyUsage.day == day)
    if limit is not None:
        query = query.where(DailyUsage.messages < limit)
    counted = db.execute(query.values(messages=DailyUsage.messages + 1)).rowcount == 1
    db.commit()
    return counted
