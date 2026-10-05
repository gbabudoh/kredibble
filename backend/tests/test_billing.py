import hashlib
import hmac
import json
import time

import pytest
import stripe
from fastapi.testclient import TestClient

from app import billing
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.models import User
from tests.test_account import PASSWORD, clean, database, register  # noqa: F401  (fixtures)

WEBHOOK_SECRET = "whsec_test_secret"


class FakeStripe:
    """Records calls and returns canned Stripe objects (plain dicts behave like StripeObjects here)."""

    def __init__(self):
        self.subscriptions = {}
        self.checkout_sessions = {}
        self.created_sessions = []
        self.cancelled = []

    def subscription(self, sub_id, status="active", key="kredibble_pro_monthly", customer="cus_123", cancel_at_period_end=False):
        self.subscriptions[sub_id] = {
            "id": sub_id, "status": status, "customer": customer, "cancel_at_period_end": cancel_at_period_end,
            "current_period_end": 1_900_000_000, "items": {"data": [{"price": {"lookup_key": key}}]},
        }


@pytest.fixture
def fake(monkeypatch):
    fake = FakeStripe()
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_fake")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setattr(billing, "_price_ids", {})
    monkeypatch.setattr(billing, "_portal_config", None)
    monkeypatch.setattr(stripe.Customer, "create", lambda **kw: {"id": "cus_123"})
    monkeypatch.setattr(stripe.Price, "list", lambda **kw: {"data": [{"id": f"price_{kw['lookup_keys'][0]}"}]})
    monkeypatch.setattr(stripe.checkout.Session, "create",
                        lambda **kw: fake.created_sessions.append(kw) or {"url": "https://checkout.stripe.com/c/pay/cs_test"})
    monkeypatch.setattr(stripe.checkout.Session, "retrieve", lambda sid: fake.checkout_sessions[sid])
    monkeypatch.setattr(stripe.Subscription, "retrieve", lambda sid: fake.subscriptions[sid])
    monkeypatch.setattr(stripe.Subscription, "cancel", lambda sid: fake.cancelled.append(sid))
    monkeypatch.setattr(stripe.billing_portal.Configuration, "list",
                        lambda **kw: {"data": [{"id": "bpc_1", "metadata": {"kredibble": "1"}}]})
    monkeypatch.setattr(stripe.billing_portal.Session, "create",
                        lambda **kw: {"url": f"https://billing.stripe.com/p/session?c={kw.get('configuration')}"})
    return fake


@pytest.fixture
def client():
    return TestClient(app)


def user_id():
    with SessionLocal() as db:
        return db.query(User).one().id


def account(client):
    return client.get("/api/v1/account/me").json()["account"]


def post_event(client, event_type, obj, secret=WEBHOOK_SECRET):
    payload = json.dumps({"id": "evt_1", "object": "event", "type": event_type, "data": {"object": obj}})
    timestamp = int(time.time())
    signature = hmac.new(secret.encode(), f"{timestamp}.{payload}".encode(), hashlib.sha256).hexdigest()
    headers = {"Stripe-Signature": f"t={timestamp},v1={signature}", "Content-Type": "application/json"}
    return client.post("/api/v1/billing/webhook", content=payload, headers=headers)


def subscribe(client, fake, sub_id="sub_1", key="kredibble_pro_monthly"):
    client.post("/api/v1/billing/checkout", json={"plan": "pro", "interval": "month"})
    fake.subscription(sub_id, key=key)
    post_event(client, "customer.subscription.created", {"id": sub_id, "customer": "cus_123"})


def test_billing_off_without_key(client):
    register(client)
    assert client.get("/api/v1/billing/config").json() == {"enabled": False}
    assert client.post("/api/v1/billing/checkout", json={"plan": "pro", "interval": "month"}).status_code == 503


def test_checkout_needs_sign_in(client, fake):
    assert client.post("/api/v1/billing/checkout", json={"plan": "pro", "interval": "month"}).status_code == 401


def test_checkout_creates_customer_and_session(client, fake):
    register(client)
    response = client.post("/api/v1/billing/checkout", json={"plan": "business", "interval": "year"})
    assert response.json() == {"url": "https://checkout.stripe.com/c/pay/cs_test"}
    [session] = fake.created_sessions
    assert session["customer"] == "cus_123" and session["client_reference_id"] == user_id()
    assert session["line_items"] == [{"price": "price_kredibble_business_yearly", "quantity": 1}]
    assert session["success_url"].endswith("/?checkout=success&session_id={CHECKOUT_SESSION_ID}")
    assert account(client)["has_billing"] is True
    assert client.post("/api/v1/billing/checkout", json={"plan": "gold", "interval": "month"}).status_code == 422


def test_webhook_rejects_bad_signature(client, fake):
    assert post_event(client, "customer.subscription.updated", {"id": "sub_1"}, secret="whsec_wrong").status_code == 400


def test_checkout_completed_upgrades_plan(client, fake):
    register(client)
    client.post("/api/v1/billing/checkout", json={"plan": "pro", "interval": "month"})
    fake.subscription("sub_1")
    response = post_event(client, "checkout.session.completed", {"client_reference_id": user_id(), "customer": "cus_123", "subscription": "sub_1"})
    assert response.status_code == 200
    me = client.get("/api/v1/account/me").json()
    assert me["account"]["plan"] == "pro" and me["account"]["subscription_interval"] == "month"
    assert me["entitlements"]["daily_messages"] == 300
    # Already subscribed: changes go through the portal instead of a second checkout.
    assert client.post("/api/v1/billing/checkout", json={"plan": "business", "interval": "month"}).status_code == 409


def test_subscription_lifecycle(client, fake):
    register(client)
    subscribe(client, fake, key="kredibble_pro_yearly")
    assert account(client)["plan"] == "pro"

    fake.subscription("sub_1", key="kredibble_business_monthly")  # switched plan in the portal
    post_event(client, "customer.subscription.updated", {"id": "sub_1", "customer": "cus_123"})
    assert account(client)["plan"] == "business"

    fake.subscription("sub_1", status="past_due", key="kredibble_business_monthly")  # card retrying: keep access
    post_event(client, "customer.subscription.updated", {"id": "sub_1", "customer": "cus_123"})
    assert account(client)["plan"] == "business"

    fake.subscription("sub_1", key="kredibble_business_monthly", cancel_at_period_end=True)
    post_event(client, "customer.subscription.updated", {"id": "sub_1", "customer": "cus_123"})
    assert account(client)["subscription_cancel_at_period_end"] is True

    fake.subscription("sub_1", status="canceled", key="kredibble_business_monthly")
    post_event(client, "customer.subscription.deleted", {"id": "sub_1", "customer": "cus_123"})
    me = account(client)
    assert me["plan"] == "free" and me["subscription_status"] == "canceled"


def test_late_event_for_old_subscription_is_ignored(client, fake):
    register(client)
    subscribe(client, fake, sub_id="sub_new")
    fake.subscription("sub_old", status="canceled")
    post_event(client, "customer.subscription.deleted", {"id": "sub_old", "customer": "cus_123"})
    assert account(client)["plan"] == "pro"


def test_sync_after_checkout(client, fake):
    register(client)
    client.post("/api/v1/billing/checkout", json={"plan": "pro", "interval": "month"})
    fake.subscription("sub_1")
    fake.checkout_sessions["cs_mine"] = {"client_reference_id": user_id(), "customer": "cus_123", "subscription": "sub_1"}
    fake.checkout_sessions["cs_other"] = {"client_reference_id": "someone-else", "customer": "cus_999", "subscription": "sub_9"}
    assert client.post("/api/v1/billing/sync", json={"session_id": "cs_other"}).status_code == 403
    response = client.post("/api/v1/billing/sync", json={"session_id": "cs_mine"})
    assert response.status_code == 200 and response.json()["plan"] == "pro"


def test_portal(client, fake):
    register(client)
    assert client.post("/api/v1/billing/portal").status_code == 404  # no billing yet
    client.post("/api/v1/billing/checkout", json={"plan": "pro", "interval": "month"})
    assert client.post("/api/v1/billing/portal").json()["url"].endswith("c=bpc_1")


def test_deleting_account_cancels_subscription(client, fake):
    register(client)
    subscribe(client, fake)
    assert client.post("/api/v1/account/delete", json={"password": PASSWORD}).status_code == 204
    assert fake.cancelled == ["sub_1"]


def test_failed_cancellation_keeps_account(client, fake, monkeypatch):
    register(client)
    subscribe(client, fake)

    def fail(sid):
        raise stripe.error.APIConnectionError("offline")
    monkeypatch.setattr(stripe.Subscription, "cancel", fail)
    assert client.post("/api/v1/account/delete", json={"password": PASSWORD}).status_code == 502
    assert account(client) is not None
