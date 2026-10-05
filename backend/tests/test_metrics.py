import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from tests.conftest import TEST_EMAIL, TEST_PASSWORD

client = TestClient(app)

EVENT = {
    "kind": "answer", "intent": "qa", "status": "warning", "issues": ["no-citation", "off-topic"],
    "model": "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "registry_version": "73b4e0e4f4f4",
    "latency_ms": 15200, "tokens_per_sec": 7.4,
}


@pytest.fixture(autouse=True)
def metrics_db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "METRICS_DB", str(tmp_path / "metrics.sqlite"))
    monkeypatch.setattr(settings, "METRICS_ENABLED", True)


def auth():
    token = client.post("/api/v1/auth/login", json={"email": TEST_EMAIL, "password": TEST_PASSWORD}).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_records_and_summarises_events():
    assert client.post("/api/v1/metrics", json=EVENT).status_code == 204
    feedback = {**EVENT, "kind": "feedback", "issues": [], "rating": "down", "reasons": ["wrong", "citation"]}
    assert client.post("/api/v1/metrics", json=feedback).status_code == 204
    data = client.get("/api/v1/metrics/summary", headers=auth()).json()
    assert data["events"] == 2
    assert data["answers"] == [{"intent": "qa", "status": "warning", "count": 1, "avg_latency_ms": 15200}]
    assert data["down_reasons"] == {"wrong": 1, "citation": 1}
    assert data["issues"] == {"no-citation": 1, "off-topic": 1}


@pytest.mark.parametrize("bad", [
    {**EVENT, "question": "What is the liability cap?"},          # unknown field: no place for content
    {**EVENT, "model": "What is the liability cap in this contract?"},  # free text in an id field
    {**EVENT, "issues": ["The cap is £2.5m"]},                     # not an enum value
    {**EVENT, "reasons": ["the answer said 48 hours"]},
    {**EVENT, "registry_version": "not-a-version"},
    {**EVENT, "latency_ms": -1},
])
def test_schema_rejects_anything_that_could_carry_content(bad):
    assert client.post("/api/v1/metrics", json=bad).status_code == 422


def test_summary_requires_auth():
    assert client.get("/api/v1/metrics/summary").status_code == 401


def test_collection_can_be_disabled(monkeypatch):
    monkeypatch.setattr(settings, "METRICS_ENABLED", False)
    assert client.post("/api/v1/metrics", json=EVENT).status_code == 404
