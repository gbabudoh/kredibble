# Kredibble Enterprise Deployment Guide

How to install and run **Kredibble** on corporate networks and SME subnets.

## 1. Architecture in one paragraph
The **browser** does the AI work. It downloads an open-weight model once, runs it on the GPU via WebGPU, parses documents locally and stores history in IndexedDB. The **FastAPI server** hosts the web app, handles login, and offers an optional authenticated document-parsing API for integrations. The web client never sends prompts, documents or answers to the server.

## 2. Requirements

### 2.1 Server
* Docker Engine 20.10+, or Python 3.11+ and Node.js 20+ to build from source.
* Minimal resources (1 vCPU, 512 MB–1 GB RAM). There is no GPU on the server.

### 2.2 Client endpoints
* **Browser:** Chrome or Edge 121+ with *Use graphics acceleration when available* enabled.
* **GPU memory** (shared or dedicated) by model:

| Model | Approx. VRAM |
|---|---|
| Llama 3.2 1B | 0.9–1.1 GB |
| Qwen2.5 1.5B (default) | 1.6–1.9 GB |
| Llama 3.2 3B / Qwen2.5 3B | 2.3–3.0 GB |
| Phi-3.5 mini | 3.7–5.5 GB |

Integrated GPUs (Intel Iris Xe, AMD Radeon 680M) are fine for the 1B–1.5B models. 3B+ models need a recent integrated GPU with plenty of system RAM, or a dedicated GPU.

### 2.3 Network / firewall
On first use, each browser downloads model files. Allow HTTPS to:
* `huggingface.co` and its CDN hosts (`cdn-lfs.huggingface.co`, `cdn-lfs-us-1.hf.co`, `*.hf.co`): model weights
* `raw.githubusercontent.com`: WebGPU model libraries (`.wasm`)

After that, files are served from the browser cache and inference needs no network. For networks without internet access, host the models yourself (section 5).

## 3. Configuration
Copy `.env.example` to `.env` and set:
* `SECRET_KEY`: required, 32+ characters. The server refuses to start without it unless `DEBUG=true`.
* `KREDIBBLE_USERS`: JSON map of users with PBKDF2 hashes. Generate a hash with `cd backend && python -m app.security hash-password`.
* `ALLOWED_ORIGINS`: the public URL(s) of your deployment.

Never commit `.env`.

## 4. Run

### Docker (production)
```bash
cp .env.example .env   # then edit
docker compose up -d --build
```
Put the container behind a TLS-terminating reverse proxy. WebGPU and service workers need HTTPS on any host other than `localhost`.

### From source (development)
```powershell
.\run_dev.ps1          # Windows
```
```bash
./run_dev.sh           # Linux / macOS
```
Then open `http://127.0.0.1:8000`.

## 5. Self-hosted models (air-gapped networks)
1. On a machine with internet access, mirror the models:
   ```bash
   cd frontend && npm ci
   node scripts/fetch-models.mjs --out ../models                                   # default model, f16 + f32, plus embedder
   node scripts/fetch-models.mjs --out ../models --models qwen3.5-2b,qwen3.5-4b         # several models
   ```
   Include `--precision f32` (on by default) for GPUs without `shader-f16`.
2. Copy the `models/` folder to the server.
3. Set `MODELS_DIR` to that folder (in Docker, mount it and set `MODELS_DIR=/models`), and set `MODEL_SOURCES=[]` so the security policy forbids any other download host.

The app then offers only the mirrored models and fetches them from `/models` on your own server. Browsers still cache them after the first load.

## 6. User accounts (PostgreSQL)
Accounts hold an email, a password hash, a display name, a user type and a plan. Chats, questions and documents never reach the server. Without `DATABASE_URL` the app runs signed-out only and hides the account controls.

1. Create a database and a user for it (as the `postgres` superuser, e.g. in `psql -U postgres`):
   ```sql
   CREATE USER kredibble WITH PASSWORD 'choose-a-strong-password';
   CREATE DATABASE kredibble OWNER kredibble;
   ```
2. In `.env`, set `DATABASE_URL=postgresql+psycopg://kredibble:choose-a-strong-password@localhost:5432/kredibble`.
3. Create the tables, and run this again after every upgrade:
   ```bash
   cd backend && alembic upgrade head
   ```
4. Email: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` and `MAIL_FROM` for your mail server (port 587 with `SMTP_STARTTLS=true`, or port 465 with `SMTP_SSL=true` and `SMTP_STARTTLS=false`), and `PUBLIC_BASE_URL` to the site's public address so links in emails work. Until `SMTP_HOST` is set, emails are written to the server log instead, which is enough for local testing.
5. Restart the server.

Plans and daily limits are defined in `backend/app/plans.py` (guest 5 messages a day, Free 30, Pro 300, Business and Enterprise no daily limit). Days follow each user's own time zone. Until payments are connected, change an account's plan from `backend/`:
```bash
python -m app.admin set-plan someone@example.com pro      # free | pro | business | enterprise
python -m app.admin show someone@example.com
```
The AI runs in the browser, so limits are enforced by the web client; the server counts signed-in users' messages. Without `DATABASE_URL` there are no plans and nothing is limited.

Sessions are httpOnly cookies scoped to `/api`, marked `Secure` except on plain-HTTP `localhost`. Sign-in, sign-up and reset requests are rate-limited per process; with several workers, add a limit at the reverse proxy too.

### Payments (Stripe)
Customers pay on Stripe Checkout and change or cancel in the Stripe customer portal; card details never reach this server. Prices: Pro $5 a month or $48 a year, Business $9 a seat a month or $86 a year (USD, set in `backend/app/billing.py`).

1. In `.env`, set `STRIPE_SECRET_KEY` (start with the `sk_test_...` key).
2. From `backend/`, run `python -m app.billing setup`. It creates the Pro and Business products, the four prices (found by lookup key, so no price ids go in `.env`) and a customer-portal configuration. Run it again after switching to the live key.
3. Webhook: in Stripe Dashboard > Developers > Webhooks, add `https://YOUR-DOMAIN/api/v1/billing/webhook` with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`. Locally, use the Stripe CLI instead: `stripe listen --forward-to localhost:8000/api/v1/billing/webhook`.
4. Restart the server. Test with card `4242 4242 4242 4242`, any future date and any CVC.

`PUBLIC_BASE_URL` must be the address customers use: Stripe sends them back there after paying. A customer whose card fails keeps their plan while Stripe retries; when the subscription ends they return to Free. Deleting an account cancels its subscription first. Without `STRIPE_SECRET_KEY`, the upgrade buttons explain that online payment is not set up and `python -m app.admin set-plan` still works.

## 7. Anonymous metrics (optional)
Users can opt in to sharing anonymous usage metrics. Events contain no text, only task type, check results, ratings, reason codes, model and speed, and are stored in SQLite at `METRICS_DB` (default `backend/data/metrics.sqlite`). In Docker, mount a volume at `/workspace/backend/data` to keep them across restarts. To refuse metrics entirely, set `METRICS_ENABLED=false`. Aggregates are at `GET /api/v1/metrics/summary`, which requires login.

## 8. Policy recommendations
* Disable browser dictation by policy where speech must not leave the device (it uses Google/Microsoft cloud services).
* Enforce full-disk encryption on endpoints, and encourage users to set a passphrase (Engine Diagnostics → Privacy lock). Without one, local chat history is stored unencrypted.
* On shared machines, train users to use **Erase all local chat history** in *Engine Diagnostics*.
