import json
import os
import sys
import tempfile

# Configure the app before it is imported: fixed secret, one test user, small upload cap.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.security import hash_password  # noqa: E402

TEST_EMAIL = "audit-team@sme-workspace.com"
TEST_PASSWORD = "correct horse battery staple"

os.environ["DEBUG"] = "false"
os.environ["SECRET_KEY"] = "test-secret-key-that-is-long-enough-0123456789"
os.environ["MAX_UPLOAD_BYTES"] = str(64 * 1024)
# Accounts use a throwaway SQLite file; tests/test_account.py builds it with the real migration.
TEST_DB = os.path.join(tempfile.mkdtemp(prefix="kredibble-test-"), "accounts.sqlite")
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB}"
os.environ["PUBLIC_BASE_URL"] = "http://testserver"
os.environ["SMTP_HOST"] = ""
os.environ["SESSION_COOKIE_SECURE"] = "false"  # the test client talks plain HTTP to "testserver"
os.environ["KREDIBBLE_USERS"] = json.dumps({
    "Audit-Team@SME-Workspace.com": {
        "password_hash": hash_password(TEST_PASSWORD, iterations=1_000),
        "workgroup": "Finance",
    }
})
