"""What each plan includes. The single source of truth: the web client reads it from /account/me.

The AI runs in the user's browser, so these limits are enforced by the client; the server
counts signed-in users' daily messages (routers/usage.py). Workspace ids match
frontend/src/core/personas.js; model keys match frontend/src/engine/models.js.
"""
from pydantic import BaseModel

from app.models import User

WORKSPACE_FOR_USER_TYPE = {
    "personal": "personal_vault",
    "founder": "ideashield",
    "micro_business": "private_ledger",
    "sme": "sme_hub",
    "enterprise": "enterprise_audit",
    "institution": "clinical_judicial",
    "charity": "safeguard_grant",
}
ALL_WORKSPACES = list(WORKSPACE_FOR_USER_TYPE.values())
# Workspaces delivered entirely in the browser; the others are the team / self-hosted tiers.
BROWSER_WORKSPACES = ["personal_vault", "ideashield", "private_ledger", "safeguard_grant"]
# Models every plan may use; the larger ones need Pro or above.
SMALL_MODELS = ["qwen2.5-1.5b", "llama3.2-1b"]


class Entitlements(BaseModel):
    plan: str                       # "guest" when signed out
    daily_messages: int | None      # None: no daily limit
    workspaces: list[str]
    documents: bool
    max_documents: int | None       # attached and searched together; None: no limit
    max_document_pages: int | None  # per document; None: no page limit
    large_models: bool
    save_history: bool
    passphrase_lock: bool
    pii_scan: bool
    pii_redaction: bool
    checklists: bool


GUEST = Entitlements(
    plan="guest", daily_messages=5, workspaces=["personal_vault"], documents=False, max_documents=0, max_document_pages=0,
    large_models=False, save_history=False, passphrase_lock=False, pii_scan=False, pii_redaction=False, checklists=False,
)

_PAID = dict(documents=True, max_document_pages=None, large_models=True, save_history=True,
             passphrase_lock=True, pii_scan=True, pii_redaction=True, checklists=True)

PLANS = {
    "free": Entitlements(
        plan="free", daily_messages=30, workspaces=[], documents=True, max_documents=1, max_document_pages=10,
        large_models=False, save_history=True, passphrase_lock=False, pii_scan=True, pii_redaction=False, checklists=False,
    ),
    "pro": Entitlements(plan="pro", daily_messages=300, workspaces=BROWSER_WORKSPACES, max_documents=3, **_PAID),
    # Business: multi-file search across a team's contracts and policies; no daily limit (fair use).
    "business": Entitlements(plan="business", daily_messages=None, workspaces=ALL_WORKSPACES, max_documents=20, **_PAID),
    "enterprise": Entitlements(plan="enterprise", daily_messages=None, workspaces=ALL_WORKSPACES, max_documents=None, **_PAID),
}


def entitlements_for(user: User | None) -> Entitlements:
    if user is None:
        return GUEST
    plan = PLANS.get(user.plan, PLANS["free"])
    # The workspace for who the account is for is always included, so upgrading never takes it
    # away: Free is Personal Vault plus that one ("1 of your choice"); Pro adds it to the
    # in-browser set (e.g. an SME account keeps Contracts & Meetings on Pro).
    chosen = WORKSPACE_FOR_USER_TYPE.get(user.user_type, "personal_vault")
    base = ["personal_vault"] if plan.plan == "free" else plan.workspaces
    return plan.model_copy(update={"workspaces": list(dict.fromkeys([*base, chosen]))})
