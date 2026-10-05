import json
import os
import sys

# Configure the app before it is imported: fixed secret, one test user, small upload cap.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.security import hash_password  # noqa: E402

TEST_EMAIL = "audit-team@sme-workspace.com"
TEST_PASSWORD = "correct horse battery staple"

os.environ["DEBUG"] = "false"
os.environ["SECRET_KEY"] = "test-secret-key-that-is-long-enough-0123456789"
os.environ["MAX_UPLOAD_BYTES"] = str(64 * 1024)
os.environ["KREDIBBLE_USERS"] = json.dumps({
    "Audit-Team@SME-Workspace.com": {
        "password_hash": hash_password(TEST_PASSWORD, iterations=1_000),
        "workgroup": "Finance",
    }
})
