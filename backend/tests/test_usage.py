from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import admin
from app.db import SessionLocal
from app.main import app
from app.models import DailyUsage, User
from app.plans import BROWSER_WORKSPACES, GUEST, entitlements_for
from app.quota import local_day
from tests.test_account import PASSWORD, clean, database, register  # noqa: F401  (fixtures)


@pytest.fixture
def client():
    return TestClient(app)


def set_plan(email, plan):
    with SessionLocal() as db:
        db.query(User).filter(User.email == email).update({User.plan: plan})
        db.commit()


def send(client, tz="Europe/London"):
    return client.post("/api/v1/usage/message", json={"timezone": tz})


def test_plan_table():
    assert GUEST.daily_messages == 5 and GUEST.workspaces == ["personal_vault"] and not GUEST.documents
    free = entitlements_for(User(plan="free", user_type="founder"))
    assert (free.daily_messages, free.workspaces, free.max_document_pages) == (30, ["personal_vault", "ideashield"], 10)
    assert not free.large_models and not free.checklists and free.pii_scan and not free.pii_redaction
    assert entitlements_for(User(plan="free", user_type="personal")).workspaces == ["personal_vault"]
    pro = entitlements_for(User(plan="pro", user_type="sme"))
    assert pro.daily_messages == 300 and pro.workspaces == BROWSER_WORKSPACES and pro.large_models and pro.checklists
    assert entitlements_for(User(plan="business", user_type="sme")).daily_messages is None
    assert entitlements_for(User(plan="mystery", user_type="founder")).plan == "free"


def test_guests_cannot_take_messages(client):
    assert send(client).status_code == 401


def test_free_plan_daily_limit(client):
    register(client)
    for n in range(1, 31):
        response = send(client)
        assert response.status_code == 200 and response.json() == {"used": n, "limit": 30}
    response = send(client)
    assert response.status_code == 429
    assert response.json()["detail"] == {"message": "Daily message limit reached.", "used": 30, "limit": 30}
    me = client.get("/api/v1/account/me", params={"tz": "Europe/London"}).json()
    assert me["messages_used_today"] == 30 and me["entitlements"]["daily_messages"] == 30


def test_upgrade_raises_limit_and_unlimited_plans(client):
    register(client)
    with SessionLocal() as db:
        user = db.query(User).one()
        db.add(DailyUsage(user_id=user.id, day=local_day("Europe/London"), messages=30))
        db.commit()
    assert send(client).status_code == 429
    set_plan("founder@example.com", "pro")
    assert send(client).json() == {"used": 31, "limit": 300}
    set_plan("founder@example.com", "business")
    assert send(client).json() == {"used": 32, "limit": None}


def test_days_follow_the_users_time_zone(client):
    register(client)
    send(client, "Pacific/Kiritimati")   # UTC+14
    send(client, "Pacific/Pago_Pago")    # UTC-11: always a different calendar day
    send(client, "Not/A_Zone")           # falls back to UTC
    with SessionLocal() as db:
        days = {row.day for row in db.query(DailyUsage).all()}
    assert len(days) >= 2 and all(isinstance(d, date) for d in days)


def test_usage_is_deleted_with_the_account(client):
    register(client)
    send(client)
    client.post("/api/v1/account/delete", json={"password": PASSWORD})
    with SessionLocal() as db:
        assert db.query(DailyUsage).count() == 0


def test_admin_set_plan(client, capsys):
    register(client)
    assert admin.main(["set-plan", "FOUNDER@example.com", "pro"]) == 0
    assert "plan=pro" in capsys.readouterr().out
    assert admin.main(["set-plan", "founder@example.com", "platinum"]) == 2
    assert admin.main(["show", "nobody@example.com"]) == 1
