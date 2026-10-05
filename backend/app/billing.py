"""Stripe billing: prices, subscription sync, and one-time setup.

Card details never reach this server: customers pay on Stripe Checkout and manage or cancel
in the Stripe customer portal. Stripe tells us about changes by webhook; the account's plan
follows the subscription.

One-time setup in each Stripe mode (test, then live), from backend/:
    python -m app.billing setup
creates the Pro and Business products, their four prices (found later by lookup key, so no
price ids go in .env) and a customer-portal configuration.
"""
import sys
from datetime import datetime, timezone

import stripe
from sqlalchemy.orm import Session

from app.config import settings
from app.models import User

CURRENCY = "usd"
PRODUCTS = {"pro": "Kredibble Pro", "business": "Kredibble Business"}
# lookup key: (plan, interval, amount in cents)
PRICES = {
    "kredibble_pro_monthly": ("pro", "month", 500),
    "kredibble_pro_yearly": ("pro", "year", 4800),
    "kredibble_business_monthly": ("business", "month", 900),
    "kredibble_business_yearly": ("business", "year", 8600),
}
# past_due keeps access while Stripe retries the card; it ends as canceled or unpaid if that fails.
ACTIVE_STATUSES = {"active", "trialing", "past_due"}
PORTAL_MARKER = "kredibble"

_price_ids: dict[str, str] = {}
_portal_config: str | None = None


def billing_enabled() -> bool:
    return bool(settings.STRIPE_SECRET_KEY)


def _api() -> None:
    stripe.api_key = settings.STRIPE_SECRET_KEY


def lookup_key(plan: str, interval: str) -> str:
    return f"kredibble_{plan}_{'monthly' if interval == 'month' else 'yearly'}"


def price_id(plan: str, interval: str) -> str:
    key = lookup_key(plan, interval)
    if key not in _price_ids:
        _api()
        found = stripe.Price.list(lookup_keys=[key], active=True, limit=1)["data"]
        if not found:
            raise LookupError(f"Stripe price '{key}' not found. Run: python -m app.billing setup")
        _price_ids[key] = found[0]["id"]
    return _price_ids[key]


def portal_configuration() -> str | None:
    """The portal configuration made by `setup` (None: Stripe's default one)."""
    global _portal_config
    if _portal_config is None:
        _api()
        for config in stripe.billing_portal.Configuration.list(active=True, limit=20)["data"]:
            if (config.get("metadata") or {}).get(PORTAL_MARKER):
                _portal_config = config["id"]
                break
    return _portal_config


def ensure_customer(db: Session, user: User) -> str:
    if not user.stripe_customer_id:
        _api()
        customer = stripe.Customer.create(email=user.email, name=user.display_name or None, metadata={"user_id": user.id})
        user.stripe_customer_id = customer["id"]
        db.commit()
    return user.stripe_customer_id


def has_live_subscription(user: User) -> bool:
    return bool(user.stripe_subscription_id) and user.subscription_status in ACTIVE_STATUSES


def retrieve_subscription(subscription_id: str):
    """Always read the current state from Stripe: webhook events can arrive late or out of order."""
    _api()
    return stripe.Subscription.retrieve(subscription_id)


def sync_subscription(db: Session, user: User, subscription) -> None:
    """Sets the account's plan and billing fields from a Stripe subscription."""
    item = subscription["items"]["data"][0]
    plan, interval, _ = PRICES.get(item["price"].get("lookup_key") or "", (None, None, None))
    status = subscription["status"]
    live = status in ACTIVE_STATUSES and plan is not None
    if not live and user.stripe_subscription_id and user.stripe_subscription_id != subscription["id"]:
        return  # an older subscription ended; the account has moved on to a newer one
    period_end = subscription.get("current_period_end") or item.get("current_period_end")

    user.plan = plan if live else "free"
    user.stripe_subscription_id = subscription["id"] if live else None
    user.subscription_status = status
    user.subscription_interval = interval if live else None
    user.subscription_renews_at = datetime.fromtimestamp(period_end, timezone.utc) if live and period_end else None
    user.subscription_cancel_at_period_end = bool(subscription.get("cancel_at_period_end")) if live else False
    db.commit()


def cancel_now(user: User) -> None:
    """Ends the subscription immediately (account deletion), so no further charges are made."""
    if has_live_subscription(user):
        _api()
        stripe.Subscription.cancel(user.stripe_subscription_id)


# --- one-time setup -----------------------------------------------------------

def setup() -> int:
    if not billing_enabled():
        print("STRIPE_SECRET_KEY is not set in .env.")
        return 1
    _api()
    mode = "TEST" if settings.STRIPE_SECRET_KEY.startswith(("sk_test_", "rk_test_")) else "LIVE"
    print(f"Stripe {mode} mode")

    products = {}
    for plan, name in PRODUCTS.items():
        existing = stripe.Product.search(query=f"metadata['kredibble_plan']:'{plan}'")["data"]
        product = existing[0] if existing else stripe.Product.create(name=name, metadata={"kredibble_plan": plan})
        products[plan] = product["id"]
        print(f"  product  {name}: {product['id']}{' (exists)' if existing else ''}")

    for key, (plan, interval, amount) in PRICES.items():
        existing = stripe.Price.list(lookup_keys=[key], limit=1)["data"]
        if existing:
            price = existing[0]
            if price["unit_amount"] != amount:
                print(f"  NOTE     {key} exists at {price['unit_amount']} cents, not {amount}. Prices cannot be edited: "
                      "create a new one in the Dashboard and move the lookup key to it.")
        else:
            price = stripe.Price.create(
                product=products[plan], currency=CURRENCY, unit_amount=amount,
                recurring={"interval": interval}, lookup_key=key, nickname=key,
            )
        print(f"  price    {key}: {price['id']} ({price['unit_amount'] / 100:.2f} {CURRENCY.upper()} / {interval})")

    if portal_configuration() is None:
        price_ids = {plan: [] for plan in PRODUCTS}
        for key, (plan, interval, _) in PRICES.items():
            price_ids[plan].append(stripe.Price.list(lookup_keys=[key], limit=1)["data"][0]["id"])
        config = stripe.billing_portal.Configuration.create(
            business_profile={"headline": "Manage your Kredibble plan"},
            metadata={PORTAL_MARKER: "1"},
            features={
                "customer_update": {"enabled": True, "allowed_updates": ["email", "address"]},
                "invoice_history": {"enabled": True},
                "payment_method_update": {"enabled": True},
                "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
                "subscription_update": {
                    "enabled": True,
                    "default_allowed_updates": ["price"],
                    "proration_behavior": "create_prorations",
                    "products": [{"product": products[p], "prices": ids} for p, ids in price_ids.items()],
                },
            },
        )
        print(f"  portal   configuration {config['id']}")
    else:
        print(f"  portal   configuration {portal_configuration()} (exists)")
    print("Done. Next: add a webhook endpoint (see DEPLOYMENT.md, section 6).")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] != ["setup"]:
        print("usage: python -m app.billing setup")
        sys.exit(2)
    sys.exit(setup())
