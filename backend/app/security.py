"""Password hashing and JWT helpers.

Generate a hash for KREDIBBLE_USERS with:
    python -m app.security hash-password
"""
import base64
import getpass
import hashlib
import hmac
import secrets
import sys
from datetime import datetime, timedelta, timezone

import jwt

PBKDF2_ALGORITHM = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 600_000


def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return "$".join([
        PBKDF2_ALGORITHM,
        str(iterations),
        base64.b64encode(salt).decode(),
        base64.b64encode(digest).decode(),
    ])


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_b64, digest_b64 = encoded.split("$")
        if algorithm != PBKDF2_ALGORITHM:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iterations))
    return hmac.compare_digest(candidate, expected)


def create_access_token(claims: dict, secret: str, algorithm: str, expires: timedelta) -> str:
    payload = {**claims, "exp": datetime.now(timezone.utc) + expires}
    return jwt.encode(payload, secret, algorithm=algorithm)


def decode_access_token(token: str, secret: str, algorithm: str) -> dict:
    return jwt.decode(token, secret, algorithms=[algorithm], options={"require": ["exp", "sub"]})


if __name__ == "__main__":
    if sys.argv[1:] != ["hash-password"]:
        print("usage: python -m app.security hash-password")
        sys.exit(2)
    first = getpass.getpass("Password: ")
    if first != getpass.getpass("Repeat: "):
        print("Passwords do not match.")
        sys.exit(1)
    print(hash_password(first))
