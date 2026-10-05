"""Billing: Stripe customer and subscription on each account

Revision ID: 0003_billing
Revises: 0002_daily_usage
Create Date: 2026-10-05
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_billing"
down_revision = "0002_daily_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("stripe_customer_id", sa.String(64)))
        batch.add_column(sa.Column("stripe_subscription_id", sa.String(64)))
        batch.add_column(sa.Column("subscription_status", sa.String(32)))
        batch.add_column(sa.Column("subscription_interval", sa.String(8)))
        batch.add_column(sa.Column("subscription_renews_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("subscription_cancel_at_period_end", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index("ix_users_stripe_customer_id", "users", ["stripe_customer_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_stripe_customer_id", table_name="users")
    with op.batch_alter_table("users") as batch:
        for column in ("subscription_cancel_at_period_end", "subscription_renews_at", "subscription_interval",
                       "subscription_status", "stripe_subscription_id", "stripe_customer_id"):
            batch.drop_column(column)
