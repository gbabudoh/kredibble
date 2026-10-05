"""Small in-memory rate limiter for sign-in, sign-up and password-reset requests.

Per process: with several server workers each keeps its own counts, which still slows
password guessing. Put a shared limiter (e.g. at the reverse proxy) in front for more.
"""
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status

_hits: dict[str, deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def limit(key: str, max_hits: int, window_seconds: int) -> None:
    """Raises 429 once `key` has been seen `max_hits` times within the window."""
    now = time.monotonic()
    hits = _hits[key]
    while hits and now - hits[0] > window_seconds:
        hits.popleft()
    if len(hits) >= max_hits:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Please wait a few minutes and try again.")
    hits.append(now)


def reset() -> None:
    """Clears all counts (tests)."""
    _hits.clear()
