"""Account administration from the command line (run from backend/).

    python -m app.admin show EMAIL
    python -m app.admin set-plan EMAIL free|pro|business|enterprise

Until payments are connected, set-plan is how an account moves between plans.
"""
import sys

from sqlalchemy import select

from app.db import SessionLocal
from app.models import PLANS, User
from app.plans import entitlements_for
from app.quota import local_day, used_on

USAGE = __doc__.strip().splitlines()[2:4]


def main(argv: list[str]) -> int:
    if SessionLocal is None:
        print("DATABASE_URL is not set (see .env.example).")
        return 1
    if len(argv) < 2 or argv[0] not in ("show", "set-plan") or (argv[0] == "set-plan" and len(argv) != 3):
        print("usage:\n" + "\n".join(USAGE))
        return 2
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == argv[1].lower()))
        if user is None:
            print(f"No account for {argv[1]}.")
            return 1
        if argv[0] == "set-plan":
            if argv[2] not in PLANS:
                print(f"Plan must be one of: {', '.join(PLANS)}.")
                return 2
            user.plan = argv[2]
            db.commit()
        limits = entitlements_for(user)
        print(f"{user.email}: plan={user.plan}, type={user.user_type}, verified={user.email_verified_at is not None}")
        print(f"messages today (UTC): {used_on(db, user, local_day(None))} of {limits.daily_messages or 'unlimited'}")
        print(f"workspaces: {', '.join(limits.workspaces)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
