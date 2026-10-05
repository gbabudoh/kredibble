"""Payments: Stripe Checkout to subscribe, the Stripe portal to change or cancel, and the
webhook that keeps each account's plan in step with its subscription."""
import logging

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import billing
from app.config import settings
from app.db import get_db
from app.models import User
from app.routers.account import Account, _account, require_user, same_origin

router = APIRouter()
logger = logging.getLogger("kredibble.billing")


class CheckoutRequest(BaseModel):
    plan: str      # "pro" | "business"
    interval: str  # "month" | "year"


class SyncRequest(BaseModel):
    session_id: str


class RedirectURL(BaseModel):
    url: str


def _require_billing() -> None:
    if not billing.billing_enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Online payment is not set up yet. Contact us to upgrade.")


def _stripe_failed(err: Exception) -> HTTPException:
    logger.exception("Stripe request failed", exc_info=err)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "The payment service did not respond. Please try again in a moment.")


@router.get("/config")
def config():
    return {"enabled": billing.billing_enabled()}


@router.post("/checkout", response_model=RedirectURL, dependencies=[Depends(same_origin)])
def checkout(body: CheckoutRequest, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Starts Stripe Checkout for a plan; the browser goes to the returned URL to pay."""
    _require_billing()
    if body.plan not in billing.PRODUCTS or body.interval not in ("month", "year"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose Pro or Business, monthly or yearly.")
    if billing.has_live_subscription(user):
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have a subscription. Use Manage billing to change it.")
    base = settings.PUBLIC_BASE_URL
    try:
        session = stripe.checkout.Session.create(
            mode="subscription",
            customer=billing.ensure_customer(db, user),
            client_reference_id=user.id,
            line_items=[{"price": billing.price_id(body.plan, body.interval), "quantity": 1}],
            subscription_data={"metadata": {"user_id": user.id}},
            allow_promotion_codes=True,
            success_url=f"{base}/?checkout=success&session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{base}/?checkout=cancelled",
        )
    except LookupError as err:
        logger.error("%s", err)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Online payment is not set up yet. Contact us to upgrade.")
    except stripe.error.StripeError as err:
        raise _stripe_failed(err)
    return RedirectURL(url=session["url"])


@router.post("/portal", response_model=RedirectURL, dependencies=[Depends(same_origin)])
def portal(user: User = Depends(require_user)):
    """Stripe's customer portal: change plan or billing period, update the card, cancel, invoices."""
    _require_billing()
    if not user.stripe_customer_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "There is no billing for this account yet.")
    try:
        params = {"customer": user.stripe_customer_id, "return_url": settings.PUBLIC_BASE_URL}
        configuration = billing.portal_configuration()
        if configuration:
            params["configuration"] = configuration
        session = stripe.billing_portal.Session.create(**params)
    except stripe.error.StripeError as err:
        raise _stripe_failed(err)
    return RedirectURL(url=session["url"])


@router.post("/sync", response_model=Account, dependencies=[Depends(same_origin)])
def sync(body: SyncRequest, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Called on return from Checkout, so the new plan shows at once even if the webhook is slow."""
    _require_billing()
    try:
        billing._api()
        session = stripe.checkout.Session.retrieve(body.session_id)
    except stripe.error.StripeError as err:
        raise _stripe_failed(err)
    if session.get("client_reference_id") != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This payment belongs to another account.")
    if session.get("customer") and not user.stripe_customer_id:
        user.stripe_customer_id = session["customer"]
        db.commit()
    if session.get("subscription"):
        billing.sync_subscription(db, user, billing.retrieve_subscription(session["subscription"]))
    return _account(user)


SUBSCRIPTION_EVENTS = {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}


@router.post("/webhook", include_in_schema=False)
async def webhook(request: Request, db: Session = Depends(get_db)):
    """Stripe events, verified with the endpoint's signing secret. Safe to receive twice."""
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Webhook secret not configured.")
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload, request.headers.get("stripe-signature", ""), settings.STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid signature.")

    obj = event["data"]["object"]
    user = None
    subscription_id = None
    if event["type"] == "checkout.session.completed":
        user = db.get(User, obj.get("client_reference_id") or "")
        if user and obj.get("customer") and not user.stripe_customer_id:
            user.stripe_customer_id = obj["customer"]
            db.commit()
        subscription_id = obj.get("subscription")
    elif event["type"] in SUBSCRIPTION_EVENTS:
        user = db.scalar(select(User).where(User.stripe_customer_id == obj.get("customer")))
        subscription_id = obj.get("id")

    if user and subscription_id:
        try:
            billing.sync_subscription(db, user, billing.retrieve_subscription(subscription_id))
        except stripe.error.StripeError as err:
            raise _stripe_failed(err)  # non-2xx: Stripe retries the event later
    return {"received": True}
