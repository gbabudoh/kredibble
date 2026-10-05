import re
from datetime import timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import ratelimit
from app.db import Base, SessionLocal, engine
from app.main import app
from app.models import AuthSession, DailyUsage, EmailToken, User
from app.routers import account

BACKEND = Path(__file__).resolve().parents[1]
PASSWORD = "a long enough password"


@pytest.fixture(scope="module", autouse=True)
def database():
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    command.upgrade(cfg, "head")
    yield
    command.downgrade(cfg, "base")


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    ratelimit.reset()
    with SessionLocal() as db:
        for table in (DailyUsage, EmailToken, AuthSession, User):
            db.query(table).delete()
        db.commit()
    sent = []
    monkeypatch.setattr(account, "send_email", lambda to, subject, body: sent.append({"to": to, "subject": subject, "body": body}))
    return sent


@pytest.fixture
def client():
    return TestClient(app)


def register(client, email="Founder@Example.com", **extra):
    return client.post("/api/v1/account/register", json={"email": email, "password": PASSWORD, "user_type": "founder", **extra})


def link_token(mail, param):
    return re.search(rf"\?{param}=([\w-]+)", mail["body"]).group(1)


def test_migration_matches_models():
    with engine.connect() as connection:
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []


def test_signed_out_session(client):
    data = client.get("/api/v1/account/me").json()
    assert data["enabled"] is True and data["account"] is None
    assert data["entitlements"]["plan"] == "guest"


def test_register_signs_in_and_sends_verification(client, clean):
    response = register(client, display_name="  Ada  ")
    assert response.status_code == 201
    assert response.json() == {"email": "founder@example.com", "display_name": "Ada", "user_type": "founder", "plan": "free", "email_verified": False}

    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Path=/api" in cookie and "SameSite=lax" in cookie
    assert client.get("/api/v1/account/me").json()["account"]["email"] == "founder@example.com"

    [mail] = clean
    assert mail["to"] == "founder@example.com"
    assert "http://testserver/?verify=" in mail["body"]


def test_session_token_and_password_are_stored_hashed(client):
    register(client)
    token = client.cookies.get(account.COOKIE_NAME)
    with SessionLocal() as db:
        user = db.query(User).one()
        assert PASSWORD not in user.password_hash
        assert db.query(AuthSession).one().token_hash != token


@pytest.mark.parametrize("body", [
    {"email": "not-an-email", "password": PASSWORD},
    {"email": "a@example.com", "password": "short"},
    {"email": "a@example.com", "password": PASSWORD, "user_type": "admin"},
])
def test_register_validates_input(client, body):
    assert client.post("/api/v1/account/register", json=body).status_code == 422


def test_duplicate_email_rejected(client):
    register(client)
    assert register(TestClient(app), email="FOUNDER@example.com").status_code == 409


def test_login_logout(client):
    register(client)
    other = TestClient(app)
    assert other.post("/api/v1/account/login", json={"email": "founder@example.com", "password": "wrong password!"}).status_code == 401
    assert other.post("/api/v1/account/login", json={"email": "nobody@example.com", "password": PASSWORD}).status_code == 401
    assert other.post("/api/v1/account/login", json={"email": "FOUNDER@example.com", "password": PASSWORD}).status_code == 200
    assert other.get("/api/v1/account/me").json()["account"] is not None

    assert other.post("/api/v1/account/logout").status_code == 204
    assert other.get("/api/v1/account/me").json()["account"] is None
    assert client.get("/api/v1/account/me").json()["account"] is not None  # other browser still signed in


def test_login_is_rate_limited(client):
    register(client)
    for _ in range(8):
        client.post("/api/v1/account/login", json={"email": "founder@example.com", "password": "wrong password!"})
    response = client.post("/api/v1/account/login", json={"email": "founder@example.com", "password": PASSWORD})
    assert response.status_code == 429


def test_verify_email(client, clean):
    register(client)
    token = link_token(clean[0], "verify")
    assert client.post("/api/v1/account/verify-email", json={"token": token}).status_code == 204
    assert client.get("/api/v1/account/me").json()["account"]["email_verified"] is True
    assert client.post("/api/v1/account/verify-email", json={"token": token}).status_code == 400  # one-time


def test_resend_replaces_previous_link(client, clean):
    register(client)
    first = link_token(clean[0], "verify")
    assert client.post("/api/v1/account/resend-verification").status_code == 204
    second = link_token(clean[1], "verify")
    assert client.post("/api/v1/account/verify-email", json={"token": first}).status_code == 400
    assert client.post("/api/v1/account/verify-email", json={"token": second}).status_code == 204


def test_expired_link_rejected(client, clean):
    register(client)
    with SessionLocal() as db:
        db.query(EmailToken).update({EmailToken.expires_at: account.utcnow() - timedelta(minutes=1)})
        db.commit()
    assert client.post("/api/v1/account/verify-email", json={"token": link_token(clean[0], "verify")}).status_code == 400


def test_password_reset_signs_out_other_browsers(client, clean):
    register(client)
    anonymous = TestClient(app)
    assert anonymous.post("/api/v1/account/forgot-password", json={"email": "nobody@example.com"}).status_code == 204
    assert len(clean) == 1  # nothing sent for unknown addresses, same response
    assert anonymous.post("/api/v1/account/forgot-password", json={"email": "founder@example.com"}).status_code == 204
    token = link_token(clean[1], "reset")

    response = anonymous.post("/api/v1/account/reset-password", json={"token": token, "password": "a brand new password"})
    assert response.status_code == 200
    assert response.json()["email_verified"] is True
    assert client.get("/api/v1/account/me").json()["account"] is None  # old session revoked
    assert anonymous.post("/api/v1/account/login", json={"email": "founder@example.com", "password": "a brand new password"}).status_code == 200


def test_update_profile(client):
    assert client.post("/api/v1/account/me", json={"display_name": "Ada"}).status_code == 401
    register(client)
    response = client.post("/api/v1/account/me", json={"display_name": "Ada L", "user_type": "charity"})
    assert response.json()["display_name"] == "Ada L" and response.json()["user_type"] == "charity"
    assert client.post("/api/v1/account/me", json={"user_type": "admin"}).status_code == 422


def test_delete_account(client):
    register(client)
    assert client.post("/api/v1/account/delete", json={"password": "wrong password!"}).status_code == 403
    assert client.post("/api/v1/account/delete", json={"password": PASSWORD}).status_code == 204
    assert client.get("/api/v1/account/me").json()["account"] is None
    with SessionLocal() as db:
        assert db.query(User).count() == 0
        assert db.query(AuthSession).count() == 0
        assert db.query(EmailToken).count() == 0


def test_cross_site_requests_rejected(client):
    response = client.post("/api/v1/account/register", json={"email": "x@example.com", "password": PASSWORD}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    response = client.post("/api/v1/account/register", json={"email": "x@example.com", "password": PASSWORD}, headers={"Origin": "http://testserver"})
    assert response.status_code == 201


@pytest.mark.parametrize("url,secure", [
    ("http://localhost:8000/", False),
    ("http://127.0.0.1:8000/", False),
    ("https://kredibble.com/", True),
    ("http://kredibble.com/", True),  # behind a TLS-terminating proxy
])
def test_cookie_secure_flag(monkeypatch, url, secure):
    monkeypatch.setattr(account.settings, "SESSION_COOKIE_SECURE", True)
    scheme, rest = url.split("://")
    host = rest.split("/")[0]
    request = Request({"type": "http", "scheme": scheme, "server": (host.split(":")[0], int(host.split(":")[1]) if ":" in host else (443 if scheme == "https" else 80)),
                       "path": "/", "headers": [(b"host", host.encode())]})
    assert account._cookie_secure(request) is secure
