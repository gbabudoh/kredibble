"""Opt-in, anonymous usage metrics.

The web client sends these only when the user turns "Share anonymous usage metrics" on.
The schema is the privacy guarantee: every field is an enum, a bounded number or a
pattern-checked identifier, and unknown fields are rejected, so an event cannot carry
prompt text, document content or answers, even by mistake.
"""
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.routers.auth import CurrentUser, get_current_user

router = APIRouter()

Intent = Literal["chat", "qa", "summary", "extract", "compliance", "general"]
Status = Literal["grounded", "warning", "abstained", "general", "none"]
IssueKind = Literal[
    "invalid-citation", "no-citation", "unverified-quote", "unsupported-number", "unsupported-sentence",
    "off-topic", "unverified-rows", "unverified-findings", "failed-checks",
]
Reason = Literal["wrong", "not-in-document", "citation", "incomplete", "off-topic", "other"]


class MetricEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["answer", "feedback"]
    intent: Intent
    status: Status = "none"
    issues: List[IssueKind] = Field(default_factory=list, max_length=8)
    rating: Optional[Literal["up", "down"]] = None
    reasons: List[Reason] = Field(default_factory=list, max_length=6)
    model: str = Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")
    registry_version: str = Field(pattern=r"^[0-9a-f]{12}$")
    latency_ms: int = Field(ge=0, le=3_600_000)
    tokens_per_sec: Optional[float] = Field(default=None, ge=0, le=10_000)


_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    path = Path(settings.METRICS_DB)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS events (
            received_at TEXT NOT NULL, kind TEXT NOT NULL, intent TEXT NOT NULL, status TEXT NOT NULL,
            issues TEXT NOT NULL, rating TEXT, reasons TEXT NOT NULL, model TEXT NOT NULL,
            registry_version TEXT NOT NULL, latency_ms INTEGER NOT NULL, tokens_per_sec REAL)"""
    )
    return conn


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
async def record(event: MetricEvent):
    if not settings.METRICS_ENABLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Metrics collection is disabled.")
    row = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat(), event.kind, event.intent, event.status,
        ",".join(event.issues), event.rating, ",".join(event.reasons), event.model, event.registry_version,
        event.latency_ms, event.tokens_per_sec,
    )
    with _lock, _connect() as conn:
        conn.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)", row)


@router.get("/summary")
async def summary(user: CurrentUser = Depends(get_current_user)):
    """Aggregates for improving prompts and templates. Authenticated users only."""
    with _lock, _connect() as conn:
        def rows(sql):
            return conn.execute(sql).fetchall()

        by_intent = rows(
            "SELECT intent, status, COUNT(*), CAST(AVG(latency_ms) AS INTEGER) FROM events "
            "WHERE kind='answer' GROUP BY intent, status ORDER BY intent, status"
        )
        ratings = rows("SELECT intent, rating, COUNT(*) FROM events WHERE kind='feedback' GROUP BY intent, rating")
        reasons = {}
        for (value,) in rows("SELECT reasons FROM events WHERE kind='feedback' AND rating='down'"):
            for reason in filter(None, value.split(",")):
                reasons[reason] = reasons.get(reason, 0) + 1
        issues = {}
        for (value,) in rows("SELECT issues FROM events WHERE kind='answer'"):
            for issue in filter(None, value.split(",")):
                issues[issue] = issues.get(issue, 0) + 1
        total = rows("SELECT COUNT(*) FROM events")[0][0]

    return {
        "events": total,
        "answers": [{"intent": i, "status": s, "count": c, "avg_latency_ms": l} for i, s, c, l in by_intent],
        "feedback": [{"intent": i, "rating": r, "count": c} for i, r, c in ratings],
        "down_reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
        "issues": dict(sorted(issues.items(), key=lambda kv: -kv[1])),
    }
