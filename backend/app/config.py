import logging
import secrets
from pathlib import Path
from typing import Dict, List

from pydantic import model_validator
from pydantic_settings import BaseSettings

logger = logging.getLogger("kredibble")


class Settings(BaseSettings):
    # App General Settings
    PROJECT_NAME: str = "Kredibble Core Platform"
    DEBUG: bool = False
    HOST: str = "127.0.0.1"
    PORT: int = 8000

    # Origins allowed to call the API from a browser
    ALLOWED_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://kredibble.com",
    ]

    # JWT. SECRET_KEY must be supplied via environment outside DEBUG.
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 8

    # Users as JSON: {"alice@corp.com": {"password_hash": "...", "workgroup": "Finance"}}
    # Hashes come from `python -m app.security hash-password`.
    KREDIBBLE_USERS: Dict[str, Dict[str, str]] = {}

    # Server-side parsing is optional (the web client parses in-browser).
    MAX_UPLOAD_BYTES: int = 25 * 1024 * 1024

    # Opt-in anonymous metrics (no content; see routers/metrics.py). Clients only send
    # events when the user enables sharing; set METRICS_ENABLED=false to refuse them.
    METRICS_ENABLED: bool = True
    METRICS_DB: str = "data/metrics.sqlite"

    # Self-hosted model mirror (filled by frontend/scripts/fetch-models.mjs). When set, the
    # server serves it at /models and the web client downloads models from here only.
    MODELS_DIR: str = ""

    # Hosts the browser may fetch model weights and WebGPU kernels from (CSP connect-src).
    # Self-hosted / air-gapped deployments serve models from this server and set this to [].
    MODEL_SOURCES: List[str] = [
        "https://huggingface.co",
        "https://*.huggingface.co",
        "https://*.hf.co",
        "https://raw.githubusercontent.com",
    ]

    model_config = {
        # Found wherever the server is started from: project root first, then backend/.
        "env_file": (str(Path(__file__).resolve().parents[2] / ".env"), str(Path(__file__).resolve().parents[1] / ".env")),
        "case_sensitive": True,
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def _normalise_users(self) -> "Settings":
        self.KREDIBBLE_USERS = {email.lower(): user for email, user in self.KREDIBBLE_USERS.items()}
        return self

    @model_validator(mode="after")
    def _require_secret(self) -> "Settings":
        if len(self.SECRET_KEY) >= 32:
            return self
        if not self.DEBUG:
            raise ValueError(
                "SECRET_KEY must be set to at least 32 characters when DEBUG is false. "
                "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
            )
        self.SECRET_KEY = secrets.token_urlsafe(48)
        logger.warning("DEBUG mode: using an ephemeral SECRET_KEY; tokens will not survive restarts.")
        return self


settings = Settings()
