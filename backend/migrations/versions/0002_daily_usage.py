"""Daily message counts per account

Revision ID: 0002_daily_usage
Revises: 0001_accounts
Create Date: 2026-10-05
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_daily_usage"
down_revision = "0001_accounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "daily_usage",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("messages", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("daily_usage")
