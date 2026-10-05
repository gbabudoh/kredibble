# KREDIBBLE TECHNOLOGIES | TECHNICAL WHITEPAPER
## Privacy Architecture: How Edge Inference Supports GDPR and HIPAA Programmes

> This document describes technical controls. It is not legal advice, and deploying Kredibble does not on its own make an organisation compliant. Customers should validate it with their DPO, privacy counsel or HIPAA security officer.

### Executive Summary
Typical SaaS LLM deployments send prompts and documents to a third-party cloud for inference. That creates processor relationships, cross-border transfers and retention questions for personal data (PII) and protected health information (PHI).

Kredibble runs open-weight models inside the user's browser with WebLLM and WebGPU. Inference, document parsing and conversation storage all happen on the endpoint. **The Kredibble server never receives prompt text, document contents or model outputs from the web client.**

### 1. Data flows

| Data | Where it is processed | Leaves the device? |
|---|---|---|
| Prompts and model responses | Browser (WebLLM, Web Worker) | No |
| Uploaded documents | Browser (pdf.js / File API) | No |
| Chat history | Browser IndexedDB (plaintext) | No |
| Model weights and WebGPU kernels | Downloaded once from Hugging Face / GitHub, cached in the browser | Inbound download only. No user data is sent. |
| Login credentials | Kredibble API (`/api/v1/auth/login`) | Yes, to the customer's or Kredibble's API host |
| Dictation audio (optional) | Browser speech service (Google in Chrome, Microsoft in Edge) | **Yes.** Users are warned before first use. Disable dictation by policy where this is unacceptable. |

### 2. GDPR considerations (EU/UK)
* **Data minimisation (Art. 5(1)(c)):** The server doesn't receive conversation or document content, so it holds no such personal data.
* **Erasure (Art. 17):** Conversation data exists only in the user's browser. One click in the app erases all local history, and clearing site data removes everything, including cached models.
* **International transfers (Chapter V):** No content is transferred for inference. Model downloads are inbound and carry no personal data. Dictation, if enabled, is a transfer to the browser vendor and should be assessed separately.
* **Customer responsibilities:** Endpoint security, device encryption (e.g. BitLocker/FileVault, since IndexedDB isn't encrypted by Kredibble yet), and access to shared machines.

### 3. HIPAA Security Rule considerations (US healthcare)
* **Transmission security (§ 164.312(e)):** PHI in prompts and documents isn't transmitted to Kredibble for inference. Whether a Business Associate Agreement is needed depends on the full deployment (hosting, support access, logs). Customers should confirm this with counsel rather than assume it isn't needed.
* **Access control (§ 164.312(a)):** The API issues signed, expiring JWTs (HS256) for configured users with PBKDF2-hashed passwords. Device-level access control stays the customer's responsibility, because local history is readable by anyone with access to the browser profile.
* **Audit controls (§ 164.312(b)):** The API can log authentication events and request metadata. It never receives conversation content, so it can't log it.
* **Encryption at rest (§ 164.312(a)(2)(iv)):** Not yet provided by the application for local history. Rely on full-disk encryption until in-app encryption ships.

### 4. AI output risk
Small on-device models can be wrong. Kredibble reduces this by grounding answers in the loaded document, asking for page citations, disclosing when only part of a document was read, and stripping active content from responses. Outputs should still be reviewed by a qualified person before they inform legal, financial or clinical decisions.

### 5. Roadmap items affecting this document
* Encryption at rest for local history (WebCrypto AES-GCM).
* Self-hosted model weights for air-gapped networks.
* Retrieval with verifiable, quote-checked citations.
* Optional on-device speech recognition.
