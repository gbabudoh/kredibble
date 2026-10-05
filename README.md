# 🛡️ Kredibble | DataPrivate Enterprise AI Platform

> **Private AI for enterprises and SMEs.**
> Open-weight language models run inside the user's browser on WebGPU (via [WebLLM](https://github.com/mlc-ai/web-llm)). Prompts and documents are processed on the user's device and are not sent to Kredibble servers.

---

## 🌟 What it does today

- **On-device inference**: Chat runs on a WebLLM model loaded into the browser's GPU memory, in a Web Worker so the UI stays responsive. Responses stream token by token.
- **Right-sized models**: Defaults to Qwen2.5 1.5B Instruct (~1.6 GB VRAM). Llama 3.2 1B/3B, Qwen2.5 3B and Phi-3.5 mini can be picked in *Engine Diagnostics*. f16 weights are used when the GPU supports `shader-f16`, f32 otherwise.
- **In-browser document reading**: PDFs (via pdf.js) and TXT/MD/CSV/JSON are parsed in the browser. Nothing is uploaded.
- **Retrieval over the whole document (RAG)**: Documents are split into passages that never cross a page and remember their section heading. Each question searches all of them with **BM25 keyword search** (headings weighted) plus **on-device semantic search** (`snowflake-arctic-embed-s`, in its own worker). Results are fused, each search method's top hits are guaranteed a slot, and the best passages that fit the 4k-token window go to the model, labelled `[S1]…[S6]`. On a 15-page test contract, the right passage was retrieved for 12/12 questions (keyword only: 9/12, semantic only: 11/12).
- **Summaries**: "Summarise this…" samples passages evenly across the whole document instead of searching.
- **Grounded, checkable answers**: The model must answer only from the sources, cite them, copy figures exactly, and say "I can't find that in the document" otherwise. Document lookups run at temperature 0, so answers are repeatable.
- **Intent routing**: A TF-IDF + logistic-regression router trained in Python (scikit-learn) and run on-device decides each message's task: document Q&A, summary, extraction, compliance check, or a general question. Held-out accuracy is 93.8%, and the remaining misses fall back to document Q&A. A message only skips the document ("general") when the router is confident *and* the question shares almost no vocabulary with the document; a test enforces that no held-out document question reaches that bar.
- **Structured extraction**: "Extract all amounts and durations" produces a table (category, clause, value, context, source).
  - **Figures** (amounts, percentages, durations, dates) are found by pattern matching and labelled with their clause heading. No model is involved, so every value is verbatim and the table is instant. (Asking the 1.5B model to label figures was tested and produced worse labels.) On the test contract: 9/9 correct in 0.7s.
  - **Text facts** (parties, obligations) use WebLLM's grammar-constrained decoding against a Pydantic schema, with each row's source restricted to the real labels. Each value must be found in a source, and the source label is re-derived from where it's found.
- **Compliance checklists** (GDPR Art. 28 processor terms, HIPAA BAA): each requirement is checked on its own against the passages most related to it. The model must quote its evidence *before* giving a verdict, and "addressed" is accepted only if that quote is really in the source; otherwise the row shows ⚠ Needs review. The table fills in live and can be stopped.
- **Answer verification**: Every document answer is checked against its sources. It looks for citations that don't exist, figures that aren't in the sources, quotes that don't match, and sentences that no source supports. Uncited sentences are matched to sources automatically (dashed chips). A badge shows ✓ or ⚠ with the reason, and every answer has a clickable **Sources** panel showing page, section and passage text.
- **Real telemetry**: Decode speed and time-to-first-token come from WebLLM's own usage stats. VRAM figures are the model's published requirement, not a live measurement.
- **Safe rendering**: Model output is rendered with `marked` + `DOMPurify`. Images and active content are stripped so a malicious document can't make the model exfiltrate data through image URLs.
- **Local history**: Threads are stored in the browser's IndexedDB, and one click erases all of it.
- **Feedback**: 👍/👎 on every answer. 👎 asks why (wrong, made up, citation, incomplete, didn't answer) and lets the user type the correct answer. Feedback is stored in this browser only; *Engine Diagnostics* can export it as JSON, including corrections formatted as candidate eval items, or delete it.
- **Opt-in anonymous metrics** (off by default): task type, check results, ratings, reason codes, model and speed are sent to `/api/v1/metrics`. The schema has no free-text field, every value is an enum, bounded number or pattern-checked ID, and the server rejects unknown fields, so questions, documents and answers cannot be sent. *Engine Diagnostics* shows exactly what an event contains. Aggregates are available at `/api/v1/metrics/summary` (login required).
- **Evaluation**: `evals/gold.json` is an answer key for two fixture documents.
  - `npm test` runs the CI part (retrieval, routing, extraction) against measured baselines, so regressions fail CI.
  - `evals/run-live.mjs` drives the real model in Chrome and scores answers, extraction and compliance.
- **Approved answers as examples** (experimental, **off by default, not yet measured**): when enabled in *Engine Diagnostics*, answers rated 👍 or corrected guide the style of similar answers. The live eval has a `--fewshot` mode that seeds examples from another document, so it measures both the benefit and whether example facts leak into answers. That comparison hasn't been completed yet, so leave this off until it has.

### Known limitations (be upfront with customers)
- **First load downloads model weights** (~0.9–3.7 GB depending on the model) from Hugging Face, plus WebGPU kernels from GitHub. They're cached afterwards. See [DEPLOYMENT.md](DEPLOYMENT.md) for firewall rules.
- **Chat history is not encrypted at rest.** It's plaintext in the browser profile. Encryption with WebCrypto is on the roadmap.
- **Dictation is not on-device.** Chrome and Edge send speech audio to Google/Microsoft for transcription, and users are warned before first use. Read-aloud (text-to-speech) uses the operating system's voices.
- **Small models still misread sources sometimes.** An advisory relevance check flags answers that are less related to the question than the best passage ("may not answer the question"). It was calibrated on only 16 answers from one contract (it caught 7 of 8 off-topic answers with no false alarms), so treat it as a hint, not a guarantee. Larger models (Qwen2.5 3B) do better where the GPU allows it.
- **Compliance results are a review aid, not legal advice.** ❌ means "not found in the passages most related to this requirement", not proof that the clause is absent.
- **Off-topic questions with a document attached** may be answered from general knowledge. Such answers are flagged "⚠ no source citations" rather than blocked. A pre-generation relevance gate was tested and rejected, because it refused too many real questions (see `src/rag/retriever.js`).
- One document at a time. The document index lives in memory and isn't saved with the chat.
- **Scanned PDFs** without a text layer aren't supported (no OCR yet).
- Requires **Chrome or Edge 121+** with hardware acceleration enabled.

---

## 📁 Repository Structure

```text
kredibble/
├── backend/                     # FastAPI: auth, optional parse API, static hosting
│   ├── app/
│   │   ├── main.py              # App factory, security headers, SPA hosting
│   │   ├── config.py            # Settings (env-driven; SECRET_KEY required in prod)
│   │   ├── security.py          # PBKDF2 password hashing, JWT helpers, hash CLI
│   │   ├── registry/            # Source of truth for structured AI behaviour:
│   │   │   ├── schemas.py       #   Pydantic output schemas → JSON Schema for WebLLM
│   │   │   ├── checklists.py    #   GDPR Art. 28 / HIPAA BAA checklists (data, not code)
│   │   │   ├── intents.py       #   intents + router training/held-out data
│   │   │   ├── router.py        #   scikit-learn TF-IDF + logistic regression
│   │   │   └── export.py        #   writes registry.json (served + bundled)
│   │   ├── routers/
│   │   │   ├── auth.py          # /login, /me, get_current_user dependency
│   │   │   └── document.py      # Optional authenticated server-side parsing
│   │   └── static/              # ← build output of frontend/ (generated)
│   ├── tests/
│   ├── requirements.txt
│   └── requirements-dev.txt
├── frontend/                    # Vite web client (vanilla JS)
│   ├── index.html
│   ├── src/
│   │   ├── main.js              # App controller
│   │   ├── engine/              # WebLLM wrapper, worker, model catalog
│   │   ├── rag/                 # chunker, BM25, embedder, hybrid retriever, answer verifier
│   │   ├── intent/              # on-device router (mirrors the scikit-learn model)
│   │   ├── structured/          # extraction + compliance runners (constrained JSON, verified)
│   │   ├── registry/            # registry.json generated by backend/app/registry/export.py
│   │   ├── core/                # IndexedDB store, prompt planner, safe rendering
│   │   └── services/            # In-browser document extraction
│   └── _legacy_react/           # Unbuilt React prototype, kept for reference only
├── Dockerfile                   # Multi-stage: builds web client, then API image
├── docker-compose.yml
├── .env.example
├── DEPLOYMENT.md
├── WHITEPAPER.md
└── EULA.md
```

---

## 🚀 Quick Start

Prerequisites: Python 3.11+, Node.js 20+, Chrome/Edge 121+.

```bash
python verify_env.py
pip install -r backend/requirements-dev.txt
```

**Windows:** `.\run_dev.ps1`  **Linux/macOS:** `./run_dev.sh`

These scripts build the web client and start the API in `DEBUG` mode, which uses an ephemeral secret key. Open **http://127.0.0.1:8000**, then click **Load model** (a one-time download).

UI hot reload: run `npm run dev` in `frontend/` alongside the API and open `http://localhost:5173/static/`.

### Tests
```bash
cd backend && python -m pytest tests      # API: auth, uploads, path traversal
cd frontend && npm test                   # unit tests + CI eval suite against evals/gold.json (Vitest)
```
Open the app with `?debug` to get `window.kredibble` in the console, which helps when inspecting retrieval scores.

### Live evaluation (needs a WebGPU machine)
```bash
./run_dev.sh                                  # app on http://127.0.0.1:8000
cd evals && npm install
node run-live.mjs --model qwen2.5-1.5b        # writes evals/reports/<time>-<model>.json
node run-live.mjs --fewshot --only qa         # the approved-examples experiment
```
Pass `--profile <short path>` to reuse downloaded models between runs. To regenerate fixture text after changing a fixture PDF, run `cd frontend && node ../evals/fixtures/extract-pages.mjs`.

### Changing schemas, checklists or router training data
Edit the Python files in `backend/app/registry/`, then regenerate:
```bash
cd backend && python -m app.registry.export      # retrains router, prints held-out accuracy
```
The export refuses to write if accuracy drops below 90%. A backend test fails if the committed `registry.json` is stale.

### Creating users
```bash
cd backend && python -m app.security hash-password
```
Put the hash into `KREDIBBLE_USERS` in `.env` (see `.env.example`).

---

## 🔒 Privacy & compliance
See [WHITEPAPER.md](WHITEPAPER.md) for how the architecture supports GDPR and HIPAA programmes, and what stays the customer's responsibility. Kredibble is a tool that can support compliance. Using it does not by itself make an organisation compliant.
