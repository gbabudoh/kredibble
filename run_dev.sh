#!/bin/bash
# Kredibble local development launcher (Linux/macOS)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm is required to build the web client (https://nodejs.org)." >&2
  exit 1
fi

echo "[1/2] Building web client..."
(cd "$ROOT/frontend" && { [ -d node_modules ] || npm install; } && npm run build)

# DEBUG=true allows an ephemeral SECRET_KEY for local work only.
export DEBUG=true
export PYTHONPATH="$ROOT/backend"

echo "[2/2] Starting API on http://127.0.0.1:8000  (API docs: /docs)"
echo "Tip: for hot reload of the UI, run 'npm run dev' in frontend/ and open http://localhost:5173/static/"
exec python3 -m uvicorn app.main:app --app-dir "$ROOT/backend" --host 127.0.0.1 --port 8000 --reload
