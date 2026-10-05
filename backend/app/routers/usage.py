"""Daily message limits for signed-in accounts.

The browser asks for one message before each question it sends to the on-device AI.
Only the count is stored, never the question.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.plans import entitlements_for
from app.quota import local_day, take_message, used_on
from app.routers.account import require_user, same_origin

router = APIRouter()


class UsageRequest(BaseModel):
    timezone: str | None = Field(default=None, max_length=64)  # IANA name, e.g. "Europe/London"


class Usage(BaseModel):
    used: int
    limit: int | None  # None: no daily limit


@router.post("/message", response_model=Usage, dependencies=[Depends(same_origin)])
def use_message(body: UsageRequest, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Counts one message for today, or answers 429 when the plan's daily limit is used up."""
    limit = entitlements_for(user).daily_messages
    day = local_day(body.timezone)
    counted = take_message(db, user, day, limit)
    used = used_on(db, user, day)
    if not counted:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, {"message": "Daily message limit reached.", "used": used, "limit": limit})
    return Usage(used=used, limit=limit)
