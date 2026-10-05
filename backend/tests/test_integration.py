import io
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, settings
from app.main import app
from app.security import create_access_token, hash_password, verify_password
from tests.conftest import TEST_EMAIL, TEST_PASSWORD

client = TestClient(app)


@pytest.fixture
def auth_headers():
    response = client.post("/api/v1/auth/login", json={"email": TEST_EMAIL, "password": TEST_PASSWORD})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


# --- health / surface -------------------------------------------------------

def test_health_endpoint():
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_server_side_chat_endpoint_is_gone():
    response = client.post("/api/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})
    assert response.status_code in (404, 405)


@pytest.mark.parametrize("path", ["/..%2Fconfig.py", "/%2e%2e/config.py", "/static/..%2Fconfig.py"])
def test_spa_fallback_does_not_escape_static_dir(path):
    response = client.get(path)
    assert "SECRET_KEY" not in response.text


# --- auth -------------------------------------------------------------------

def test_login_success_is_case_insensitive():
    response = client.post("/api/v1/auth/login", json={"email": TEST_EMAIL.upper(), "password": TEST_PASSWORD})
    assert response.status_code == 200
    data = response.json()
    assert data["workgroup"] == "Finance"
    assert data["user_email"] == TEST_EMAIL


@pytest.mark.parametrize("email,password", [
    (TEST_EMAIL, "wrong-password"),
    ("nobody@sme-workspace.com", TEST_PASSWORD),
    ("audit-team@sme-workspace.com", "SecureKred123!"),  # former hard-coded demo password
])
def test_login_rejects_bad_credentials(email, password):
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 401


def test_me_requires_valid_token(auth_headers):
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/auth/me", headers={"Authorization": "Bearer junk"}).status_code == 401
    response = client.get("/api/v1/auth/me", headers=auth_headers)
    assert response.status_code == 200
    assert response.json() == {"email": TEST_EMAIL, "workgroup": "Finance"}


def test_expired_token_rejected():
    token = create_access_token({"sub": TEST_EMAIL}, settings.SECRET_KEY, settings.ALGORITHM, timedelta(seconds=-1))
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_token_signed_with_other_key_rejected():
    token = create_access_token({"sub": TEST_EMAIL}, "x" * 48, settings.ALGORITHM, timedelta(minutes=5))
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_password_hashing_roundtrip():
    encoded = hash_password("s3cret", iterations=1_000)
    assert verify_password("s3cret", encoded)
    assert not verify_password("other", encoded)
    assert not verify_password("s3cret", "garbage")


def test_production_requires_secret_key():
    with pytest.raises(ValueError):
        Settings(DEBUG=False, SECRET_KEY="short", _env_file=None)
    assert len(Settings(DEBUG=True, SECRET_KEY="", _env_file=None).SECRET_KEY) >= 32


# --- document parsing -------------------------------------------------------

def _upload(name, content, headers=None):
    return client.post("/api/v1/docs/parse", files={"file": (name, io.BytesIO(content), "text/plain")}, headers=headers or {})


def test_parse_requires_auth():
    assert _upload("audit_log.txt", b"hello").status_code == 401


def test_parse_txt(auth_headers):
    response = _upload("audit_log.txt", b"Confidential Corporate Audit Log 2026: All systems compliant.", auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert data["filename"] == "audit_log.txt"
    assert "Confidential Corporate Audit Log 2026" in data["extracted_text"]


def test_parse_rejects_unsupported_type(auth_headers):
    assert _upload("payload.exe", b"MZ", auth_headers).status_code == 400


def test_parse_rejects_oversized_upload(auth_headers):
    assert _upload("big.txt", b"a" * (settings.MAX_UPLOAD_BYTES + 1), auth_headers).status_code == 413


def test_parse_hides_parser_internals(auth_headers):
    response = _upload("broken.pdf", b"%PDF-1.4 not really a pdf", auth_headers)
    assert response.status_code == 422
    assert response.json()["detail"] == "The document could not be parsed."
