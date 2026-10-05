// Kredibble web client: on-device chat over WebLLM.
import "./styles.css";
import { LocalLLM, isEngineLost } from "./engine/llm.js";
import { loadModelSource } from "./engine/source.js";
import { MODELS, DEFAULT_MODEL_KEY } from "./engine/models.js";
import { ThreadStore, FeedbackStore, setCipher, hasSealedRecords } from "./core/db.js";
import { createVault, recordCipher, unlockVault } from "./core/vault.js";
import { renderMarkdown, escapeHtml } from "./core/render.js";
import { planTurn, assembleMessages, examplesTokens, ANSWER_MAX_TOKENS } from "./core/prompt.js";
import { extractDocument } from "./services/documents.js";
import { DocumentIndex, chunkIndexText, normalize, retrievalQuery, shouldAbstain } from "./rag/retriever.js";
import { routeMessage } from "./intent/router.js";
import { runExtraction } from "./structured/extract.js";
import { runCompliance } from "./structured/compliance.js";
import { REASONS, buildRecord, documentFingerprint, selectExamples, toEvalCandidates } from "./learning/feedback.js";
import { buildEvent, lastEvent, metricsEnabled, sendEvent, setMetricsEnabled } from "./learning/metrics.js";
import registry from "./registry/registry.json";
import { PII_LABELS, mask, redact, redactPages, scanDocument } from "./privacy/pii.js";
import { Embedder } from "./rag/embedder.js";
import { groundAnswer, describeIssue, relevanceIssue, stripCitations, NOT_FOUND_TEXT } from "./rag/verify.js";

const $ = (id) => document.getElementById(id);

// WebLLM worker errors can arrive as strings or plain objects rather than Error instances.
const errorText = (err) => err?.message || (typeof err === "string" ? err : String(err));


const storage = {
  get(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  },
};

const IDLE_LOCK_MS = 15 * 60 * 1000;

const HERO_PROMPTS = [
  { title: "🌍 General question", desc: "Ask anything — answered on this device", prompt: "What is the capital of the UK?" },
  { title: "📋 NDA review checklist", desc: "Key clauses to check in a mutual NDA", prompt: "Give me a checklist of the key clauses to review in a mutual NDA, with one line on why each matters." },
  { title: "🔒 GDPR data minimisation", desc: "Explain Article 5(1)(c) in plain terms", prompt: "Explain GDPR Article 5(1)(c) data minimisation in plain English, with two practical examples." },
  { title: "📄 Analyse a document", desc: "PDF/TXT read in this browser, never uploaded", action: "pick-file" },
];

class KredibbleApp {
  constructor() {
    this.llm = new LocalLLM();
    this.threads = [];
    this.activeThreadId = null;
    this.activeDoc = null;
    this.docIndex = null;
    this.docFingerprint = null;
    this.feedback = [];
    this.feedbackFormFor = null; // message index with the 👎 form open
    this.useExamples = storage.get("kredibble_fewshot", "off") === "on";
    this.vaultKey = null;
    this.vaultMode = null; // "unlock" | "create" while the passphrase dialog is open
    this.lastActivity = Date.now();
    this.embedder = new Embedder();
    this.semantic = { state: "off", progress: 0 }; // off | loading | indexing | ready | failed
    this.isStreaming = false;
    this.isRecording = false;
    this.recognition = null;
    this.engineState = "idle"; // idle | loading | ready | error | unsupported
    this.modelKey = storage.get("kredibble_model", DEFAULT_MODEL_KEY);
    this.ttsEnabled = storage.get("kredibble_tts", "off") === "on";
    this.renderQueued = false;
  }

  async init() {
    this.applyTheme(storage.get("kredibble_theme", "dark"));
    this.updateTTSButton();
    this.bindEvents();
    this.setupSpeechRecognition();
    const source = await loadModelSource();
    this.llm.setSource(source);
    if (source.selfHosted) this.embedder.appConfig = source.appConfig;
    this.modelSource = source;
    this.populateModelSelect();

    if (this.vaultConfig() || (await hasSealedRecords())) await this.requireUnlock();
    await this.loadThreads();
    this.feedback = await FeedbackStore.all();
    this.startIdleLock();

    await this.llm.probeGPU();
    if (!this.llm.gpu.supported) {
      this.setEngineState("unsupported", `${this.llm.gpu.description}. Use Chrome or Edge 121+ with hardware acceleration enabled.`);
    } else {
      const modelId = this.llm.resolveModelId(this.modelKey);
      if (await this.llm.isCached(modelId)) {
        this.loadModel();
      } else {
        const sizeMB = Math.round(LocalLLM.modelRecord(modelId)?.vram_required_MB ?? 0);
        this.setEngineState("idle", `Model not downloaded yet. One-time download, needs ~${sizeMB} MB of GPU memory.`);
      }
    }
    this.updateDiagnostics();
  }

  // ---------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------
  bindEvents() {
    const actions = {
      "new-chat": () => this.newChat(),
      "toggle-sidebar": () => $("app-sidebar").classList.toggle("collapsed"),
      "toggle-theme": () => this.applyTheme(document.body.classList.contains("theme-dark") ? "light" : "dark"),
      "toggle-tts": () => this.toggleTTS(),
      "show-telemetry": () => this.showDiagnostics(true),
      "hide-telemetry": () => this.showDiagnostics(false),
      "load-model": () => this.loadModel(),
      "clear-model-cache": () => this.clearModelCache(),
      "purge-history": () => this.purgeHistory(),
      "pick-file": () => $("file-upload-input").click(),
      "remove-doc": () => this.setDocument(null),
      "toggle-voice": () => this.toggleVoice(),
      "send": () => {
        if (!this.isStreaming) return this.sendMessage();
        this.stopRequested = true; // also ends multi-step tasks between steps
        this.llm.interrupt();
      },
      "hero-prompt": (el) => this.sendMessage(el.dataset.prompt),
      "select-thread": (el) => this.selectThread(el.dataset.id),
      "delete-thread": (el) => this.deleteThread(el.dataset.id),
      "copy": (el) => this.copyMessage(Number(el.dataset.index)),
      "show-source": (el) => this.showSource(el),
      "feedback-up": (el) => this.rate(Number(el.dataset.index), "up"),
      "feedback-down": (el) => this.openFeedbackForm(Number(el.dataset.index)),
      "feedback-save": (el) => this.saveFeedbackForm(Number(el.dataset.index)),
      "feedback-cancel": () => { this.feedbackFormFor = null; this.renderMessages(); },
      "export-feedback": () => this.exportFeedback(),
      "pii-scan": () => this.scanPersonalData(),
      "pii-download": () => this.downloadRedacted(),
      "vault-set": () => this.openVaultDialog("create"),
      "vault-lock": () => this.lock(),
      "vault-remove": () => this.removePassphrase(),
      "vault-forgot": () => this.eraseLockedData(),
      "vault-cancel": () => this.closeVaultDialog(),
      "clear-feedback": () => this.clearFeedback(),
      "speak": (el) => this.speak(this.getActiveThread().messages[Number(el.dataset.index)]?.content),
    };

    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el || !actions[el.dataset.action]) return;
      e.preventDefault();
      e.stopPropagation();
      actions[el.dataset.action](el);
    });

    $("telemetry-modal").addEventListener("click", (e) => {
      if (e.target.id === "telemetry-modal") this.showDiagnostics(false);
    });

    const textarea = $("chat-textarea");
    textarea.addEventListener("input", () => this.autoGrow(textarea));
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!this.isStreaming) this.sendMessage();
      }
    });

    $("file-upload-input").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) this.handleFile(file);
    });
    document.body.addEventListener("dragover", (e) => e.preventDefault());
    document.body.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) this.handleFile(file);
    });

    $("vault-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitVault();
    });

    $("diag-fewshot").addEventListener("change", (e) => {
      this.useExamples = e.target.checked;
      storage.set("kredibble_fewshot", this.useExamples ? "on" : "off");
    });
    $("diag-metrics").addEventListener("change", (e) => {
      setMetricsEnabled(e.target.checked);
      this.updateLearningDiagnostics();
    });

    $("diag-model-select").addEventListener("change", (e) => {
      this.modelKey = e.target.value;
      storage.set("kredibble_model", this.modelKey);
      this.updateDiagnostics();
    });
  }

  // ---------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------
  setEngineState(state, message = "") {
    this.engineState = state;
    const banner = $("engine-banner");
    const btn = $("engine-banner-btn");
    $("engine-banner-text").textContent = message;
    banner.hidden = state === "ready";
    btn.hidden = state === "loading" || state === "unsupported";
    btn.textContent = state === "error" ? "Retry" : "Load model";
    $("engine-progress").hidden = state !== "loading";

    const labels = { idle: "Not loaded", loading: "Loading…", ready: "On-device", error: "Error", unsupported: "No WebGPU" };
    $("top-status-text").textContent = labels[state];
    this.updateDiagnostics();
  }

  async loadModel() {
    if (this.isStreaming) return;
    if (this.engineState === "loading") {
      // A different model was picked mid-load: switch once the current load finishes.
      this.reloadAfterLoad = true;
      return;
    }
    const modelId = this.llm.resolveModelId(this.modelKey);
    if (this.engineState === "ready" && this.llm.loadedModelId === modelId) return;

    this.setEngineState("loading", "Preparing model…");
    try {
      await this.llm.load(modelId, (report) => {
        $("engine-banner-text").textContent = report.text;
        $("engine-progress-bar").style.width = `${Math.round((report.progress ?? 0) * 100)}%`;
      });
      this.setEngineState("ready");
    } catch (err) {
      console.error("Model load failed:", err);
      this.setEngineState("error", `Could not load model: ${errorText(err)}`);
    }
    if (this.reloadAfterLoad) {
      this.reloadAfterLoad = false;
      if (this.llm.loadedModelId !== this.llm.resolveModelId(this.modelKey)) this.loadModel();
    }
  }

  async clearModelCache() {
    const modelId = this.llm.resolveModelId(this.modelKey);
    if (!confirm(`Remove ${modelId} from this browser's cache? It will need to be downloaded again.`)) return;
    try {
      await this.llm.removeFromCache(modelId);
      if (!this.llm.loadedModelId) this.setEngineState("idle", "Model removed from cache.");
      this.toast("Cached model removed.");
    } catch (err) {
      this.toast(`Could not remove model: ${errorText(err)}`);
    }
  }

  // ---------------------------------------------------------------
  // Documents (parsed in-browser, never uploaded)
  // ---------------------------------------------------------------
  async handleFile(file) {
    $("attached-doc-chip").hidden = false;
    $("attached-doc-name").textContent = file.name;
    $("attached-doc-meta").textContent = "(reading…)";
    try {
      this.setDocument(await extractDocument(file));
    } catch (err) {
      this.setDocument(null);
      this.toast(errorText(err));
    }
  }

  setDocument(doc) {
    this.activeDoc = doc;
    this.docIndex = doc ? new DocumentIndex(doc) : null;
    this.docFingerprint = null;
    if (doc) documentFingerprint(doc.pages).then((fp) => { if (this.activeDoc === doc) this.docFingerprint = fp; }).catch(() => {});
    this.semantic = { state: "off", progress: 0 };
    $("attached-doc-chip").hidden = !doc;
    if (doc) {
      $("attached-doc-name").textContent = doc.filename;
      this.buildSemanticIndex(this.docIndex);
    }
    this.updateDocChip();
  }

  /** Embeds every chunk in the background. Keyword search works immediately; this upgrades it. */
  async buildSemanticIndex(index) {
    if (!this.llm.gpu.supported || !index.chunks.length) return;
    const stillCurrent = () => this.docIndex === index;
    try {
      this.semantic = { state: "loading", progress: 0 };
      this.updateDocChip();
      await this.embedder.load((report) => {
        if (!stillCurrent()) return;
        this.semantic.progress = report.progress ?? 0;
        this.updateDocChip();
      });
      if (!stillCurrent()) return;

      this.semantic = { state: "indexing", progress: 0 };
      this.updateDocChip();
      const vectors = await this.embedder.embedPassages(index.chunks.map(chunkIndexText), (p) => {
        if (!stillCurrent()) return;
        this.semantic.progress = p;
        this.updateDocChip();
      });
      if (!stillCurrent()) return;
      index.setVectors(vectors);
      this.semantic = { state: "ready", progress: 1 };
    } catch (err) {
      console.warn("Semantic indexing failed; keyword search only:", err);
      if (stillCurrent()) this.semantic = { state: "failed", progress: 0 };
    }
    if (stillCurrent()) this.updateDocChip();
  }

  updateDocChip() {
    const doc = this.activeDoc;
    if (!doc) return;
    const pages = `${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`;
    const pct = `${Math.round(this.semantic.progress * 100)}%`;
    const search = {
      off: "keyword search",
      loading: `loading semantic model ${pct}`,
      indexing: `semantic indexing ${pct}`,
      ready: "keyword + semantic search",
      failed: "keyword search (semantic unavailable)",
    }[this.semantic.state];
    $("attached-doc-meta").textContent = `(${pages} · ${this.docIndex.chunks.length} passages · ${search} · stays on this device)`;
  }

  // ---------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------
  async loadThreads() {
    this.threads = await ThreadStore.all();
    if (this.threads.length) this.activeThreadId = this.threads[0].id;
    else this.createThread();
    this.renderThreads();
    this.renderMessages();
  }

  createThread() {
    const now = new Date().toISOString();
    const thread = { id: `thread-${Date.now()}`, title: "New chat", messages: [], createdAt: now, updatedAt: now };
    this.threads.unshift(thread);
    this.activeThreadId = thread.id;
    return thread;
  }

  getActiveThread() {
    return this.threads.find((t) => t.id === this.activeThreadId) || this.threads[0];
  }

  newChat() {
    if (this.isStreaming) return;
    this.createThread();
    this.setDocument(null);
    this.renderThreads();
    this.renderMessages();
    $("chat-textarea").focus();
  }

  selectThread(id) {
    if (this.isStreaming) return;
    this.activeThreadId = id;
    this.renderThreads();
    this.renderMessages();
  }

  async deleteThread(id) {
    if (this.isStreaming) return;
    await ThreadStore.remove(id);
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) {
      if (this.threads.length) this.activeThreadId = this.threads[0].id;
      else this.createThread();
    }
    this.renderThreads();
    this.renderMessages();
  }

  async purgeHistory() {
    if (!confirm("Permanently erase all chat history stored in this browser?")) return;
    await ThreadStore.clear();
    this.threads = [];
    this.createThread();
    this.renderThreads();
    this.renderMessages();
    this.showDiagnostics(false);
    this.toast("Local chat history erased.");
  }

  // ---------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------
  async sendMessage(customText) {
    const textarea = $("chat-textarea");
    const text = (customText ?? textarea.value).trim();
    if (!text || this.isStreaming) return;

    if (this.engineState !== "ready") {
      $("engine-banner").hidden = false;
      $("engine-banner").classList.add("pulse");
      setTimeout(() => $("engine-banner").classList.remove("pulse"), 900);
      this.toast(this.engineState === "loading" ? "Model is still loading…" : "Load a model first.");
      return;
    }

    textarea.value = "";
    this.autoGrow(textarea);

    const thread = this.getActiveThread();
    if (!thread.messages.length) thread.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;

    const time = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    thread.messages.push({ role: "user", content: text, timestamp: time() });

    const route = routeMessage(text, {
      hasDocument: !!this.docIndex,
      documentOverlap: this.docIndex ? this.docIndex.bm25.search(text, 1).weightedCoverage : 0,
    });
    const useDocument = !!this.docIndex && route.intent !== "general";

    let plan;
    try {
      plan = planTurn({
        history: thread.messages,
        withDocument: useDocument,
        docMode: route.intent === "summary" ? "summary" : "search",
        contextWindow: LocalLLM.contextWindow(this.llm.loadedModelId),
      });
    } catch (err) {
      thread.messages.push({ role: "assistant", content: err.message, error: true, timestamp: time() });
      this.renderAll();
      return;
    }

    const reply = { role: "assistant", content: "", timestamp: time(), meta: {} };
    thread.messages.push(reply);
    this.setStreaming(true);
    this.renderAll();

    this.stopRequested = false;
    const startedAt = performance.now();
    try {
      if (route.intent === "extract" || route.intent === "compliance") {
        await this.runStructuredTask(route, text, reply);
        return;
      }

      // Approved earlier answers as style examples (experimental, off by default; see evals/).
      const examples = this.useExamples && useDocument && route.intent === "qa" ? selectExamples(text, this.feedback) : [];
      const sourceBudget = Math.max(0, plan.sourceBudget - examplesTokens(examples));
      const grounding = useDocument ? await this.retrieveSources(text, thread, sourceBudget, route.intent === "summary") : null;

      if (grounding?.abstain) {
        // Nothing in the document relates to the question: answer without running the model.
        reply.content = `${NOT_FOUND_TEXT} Nothing in **${grounding.filename}** matched your question closely enough to answer it. ` +
          "Try the document's own wording, or remove the document to ask a general question.";
        reply.abstained = true;
        reply.meta = { doc: grounding.filename, retrieval: grounding.retrieval, sources: [], verification: { status: "abstained", issues: [], citedIds: [] } };
        return;
      }

      const messages = assembleMessages(plan, grounding && { filename: grounding.filename, sources: grounding.sources, mode: grounding.retrieval.mode }, examples);
      // Document lookups are extractive: greedy decoding keeps answers repeatable.
      const temperature = grounding?.retrieval.mode === "search" ? 0 : 0.3;
      for await (const delta of this.llm.stream(messages, { maxTokens: ANSWER_MAX_TOKENS, temperature })) {
        reply.content += delta;
        this.queueStreamRender(reply.content);
      }
      if (!reply.content.trim()) reply.content = "_(No response generated.)_";

      const usage = this.llm.lastUsage;
      reply.meta = {
        model: this.llm.loadedModelId,
        tokensPerSec: usage?.extra?.decode_tokens_per_s ?? null,
        droppedTurns: plan.droppedTurns,
        route: { intent: route.intent, confidence: Number(route.confidence.toFixed(2)), reason: route.reason },
        examplesUsed: examples.length,
      };
      if (route.intent === "general") {
        reply.meta.doc = this.docIndex.filename;
        reply.meta.verification = { status: "general", issues: [], citedIds: [] };
      }
      if (grounding) {
        const { content, verification } = groundAnswer(reply.content, grounding.sources, text);
        if (grounding.queryVector && verification.status !== "abstained") {
          const issue = await this.checkRelevance(reply.content, grounding);
          if (issue) {
            verification.issues.push(issue);
            verification.status = "warning";
          }
        }
        reply.content = content;
        Object.assign(reply.meta, { doc: grounding.filename, retrieval: grounding.retrieval, sources: grounding.sources, verification });
      }
      if (this.ttsEnabled) this.speak(reply.content);
    } catch (err) {
      console.error("Generation failed:", err);
      reply.error = true;
      if (isEngineLost(err)) {
        // The browser reclaimed the GPU (usually memory pressure on integrated graphics).
        // The model is gone; say so instead of pretending the engine is still ready.
        this.llm.discard();
        this.setEngineState("error", "The GPU stopped the model, usually because it ran out of memory. Reload it, or choose a smaller model in Engine Diagnostics.");
        reply.content = `${reply.content}\n\n⚠️ The GPU stopped the model before it finished (often out of memory). Reload the model or choose a smaller one, then ask again.`.trim();
      } else {
        reply.content = `${reply.content}\n\n⚠️ Generation failed: ${errorText(err)}`.trim();
      }
    } finally {
      this.setStreaming(false);
      if (!reply.error && reply.content) sendEvent(buildEvent("answer", reply, { latencyMs: performance.now() - startedAt }));
      await ThreadStore.save(thread);
      this.renderAll();
      this.updateDiagnostics();
    }
  }

  /** Extraction and compliance: schema-constrained JSON, verified row by row. */
  async runStructuredTask(route, text, reply) {
    const index = this.docIndex;
    const embedQuery = index.hasSemantic ? (q) => this.embedder.embedQuery(q) : null;
    const shouldStop = () => this.stopRequested;
    let result;
    if (route.intent === "extract") {
      const vector = embedQuery ? await embedQuery(text).catch(() => null) : null;
      result = await runExtraction({
        question: text, index, retrieval: index.retrieve(text, vector), llm: this.llm, shouldStop,
        onProgress: (msg) => this.queueStreamRender(`_${msg}_`),
      });
    } else {
      result = await runCompliance({
        question: text, index, llm: this.llm, embedQuery, shouldStop,
        onProgress: (markdown) => { reply.content = markdown; this.queueStreamRender(markdown); },
      });
    }
    const usage = this.llm.lastUsage;
    reply.content = result.content;
    reply.meta = {
      model: this.llm.loadedModelId,
      tokensPerSec: usage?.extra?.decode_tokens_per_s ?? null,
      doc: index.filename,
      sources: result.sources,
      verification: result.verification,
      task: result.task,
      route: { intent: route.intent, confidence: Number(route.confidence.toFixed(2)), reason: route.reason },
      retrieval: { mode: route.intent, totalChunks: index.chunks.length, semanticUsed: index.hasSemantic },
    };
  }

  /** Finds the document passages for this question. */
  async retrieveSources(text, thread, budget, summary = false) {
    const index = this.docIndex;
    const filename = index.filename;
    const total = index.chunks.length;

    if (summary) {
      return { filename, sources: index.selectSpread(budget), retrieval: { mode: "summary", totalChunks: total } };
    }

    const previous = thread.messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content || "";
    const query = retrievalQuery(text, previous);

    let queryVector = null;
    if (index.hasSemantic) {
      try {
        queryVector = await this.embedder.embedQuery(query);
      } catch (err) {
        console.warn("Query embedding failed; keyword search only:", err);
      }
    }

    const result = index.retrieve(query, queryVector);
    const retrieval = {
      mode: "search",
      totalChunks: total,
      semanticUsed: result.semanticUsed,
      semanticPending: !result.semanticUsed && ["loading", "indexing"].includes(this.semantic.state),
      bestLexical: Number(result.bestLexical.toFixed(2)),
      bestSemantic: result.bestSemantic === null ? null : Number(result.bestSemantic.toFixed(3)),
      semanticZ: result.semanticZ === null ? null : Number(result.semanticZ.toFixed(2)),
      termCoverage: Number(result.weightedCoverage.toFixed(2)),
    };

    if (shouldAbstain(result)) return { filename, abstain: true, sources: [], retrieval };

    let sources = index.select(result.ranked, budget);
    if (!sources.length) {
      // Query had no searchable terms (e.g. "what does this mean?"): fall back to a spread sample.
      sources = index.selectSpread(budget);
      retrieval.mode = "sample";
    }
    return { filename, sources, retrieval, queryVector: retrieval.mode === "search" ? queryVector : null, bestSemantic: result.bestSemantic };
  }

  /** Advisory check that the answer addresses the question (see MIN_RELEVANCE_RATIO). */
  async checkRelevance(answer, grounding) {
    try {
      const [answerVector] = await this.embedder.embedPassages([stripCitations(answer)]);
      const a = normalize(answerVector);
      const q = normalize(grounding.queryVector);
      let similarity = 0;
      for (let i = 0; i < a.length; i++) similarity += a[i] * q[i];
      return relevanceIssue(similarity, grounding.bestSemantic);
    } catch (err) {
      console.warn("Relevance check skipped:", err);
      return null;
    }
  }

  setStreaming(on) {
    this.isStreaming = on;
    $("send-icon").style.display = on ? "none" : "";
    $("stop-icon").style.display = on ? "inline" : "none";
    $("send-btn").title = on ? "Stop generating" : "Send Message";
  }

  queueStreamRender(text) {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      const boxes = document.querySelectorAll(".msg-turn.assistant .msg-body");
      const last = boxes[boxes.length - 1];
      if (last) last.innerHTML = renderMarkdown(text);
      this.scrollToBottom();
    });
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  renderAll() {
    this.renderThreads();
    this.renderMessages();
  }

  renderThreads() {
    const container = $("sidebar-threads-container");
    container.replaceChildren();
    const visible = this.threads.filter((t) => t.messages.length || t.id === this.activeThreadId);

    const heading = document.createElement("div");
    heading.className = "threads-section-title";
    heading.textContent = "Recent Chats";
    container.append(heading);

    for (const t of visible) {
      const item = document.createElement("div");
      item.className = `thread-item${t.id === this.activeThreadId ? " active" : ""}`;
      item.dataset.action = "select-thread";
      item.dataset.id = t.id;

      const title = document.createElement("div");
      title.className = "thread-title";
      const span = document.createElement("span");
      span.textContent = t.title || "New chat";
      title.append(span);

      const del = document.createElement("button");
      del.className = "thread-delete-btn";
      del.title = "Delete chat";
      del.textContent = "✕";
      del.dataset.action = "delete-thread";
      del.dataset.id = t.id;

      item.append(title, del);
      container.append(item);
    }
  }

  renderMessages() {
    const container = $("messages-container");
    const thread = this.getActiveThread();

    if (!thread || !thread.messages.length) {
      container.innerHTML = `
        <div class="chatgpt-hero-state">
          <div class="hero-shield-icon">🛡️</div>
          <h2 class="hero-title">What can I help with privately?</h2>
          <p class="hero-subtitle">The language model runs in this browser. Your prompts and documents are processed on this device.</p>
          <div class="hero-prompt-grid">
            ${HERO_PROMPTS.map((p) => `
              <div class="hero-prompt-card" data-action="${p.action || "hero-prompt"}" ${p.prompt ? `data-prompt="${escapeHtml(p.prompt)}"` : ""}>
                <div class="hero-prompt-title">${p.title}</div>
                <div class="hero-prompt-desc">${p.desc}</div>
              </div>`).join("")}
          </div>
        </div>`;
      return;
    }

    const lastIndex = thread.messages.length - 1;
    container.innerHTML = thread.messages.map((m, i) => {
      const isAssistant = m.role === "assistant";
      const pending = isAssistant && !m.content && this.isStreaming && i === lastIndex;
      const showActions = isAssistant && m.content && !(this.isStreaming && i === lastIndex);
      const body = isAssistant
        ? (pending ? `<span class="msg-pending">Generating on this device…</span>`
          : showActions ? this.decorateCitations(renderMarkdown(m.content), m.meta, i) : renderMarkdown(m.content))
        : `<div class="msg-user-text">${escapeHtml(m.content)}</div>`;
      return `
        <div class="msg-turn ${m.role}${m.error ? " error" : ""}">
          <div class="msg-avatar">${m.role === "user" ? "U" : "🛡️"}</div>
          <div class="msg-content-wrapper">
            <div class="msg-body">${body}</div>
            ${showActions ? `
              <div class="msg-actions">
                <button class="msg-action-btn" data-action="copy" data-index="${i}" title="Copy response">📋 Copy</button>
                <button class="msg-action-btn" data-action="speak" data-index="${i}" title="Read aloud">🔊 Read</button>
                ${m.error || m.meta?.task?.type === "pii" ? "" : this.renderRatingButtons(m, i)}
                ${m.meta?.task?.type === "pii" && m.meta.task.total && this.activeDoc?.filename === m.meta.doc
                  ? `<button class="msg-action-btn" data-action="pii-download" title="Download a redacted text copy">⬇ Redacted copy</button>` : ""}
                ${this.renderMeta(m.meta)}
              </div>
              ${this.renderGrounding(m.meta, i)}
              ${this.feedbackFormFor === i ? this.renderFeedbackForm(i) : ""}` : ""}
          </div>
        </div>`;
    }).join("");
    this.scrollToBottom();
  }

  /** Turns [S1] / [S1, S3] markers into clickable chips. Runs on already-sanitised HTML; only inserts digits. */
  decorateCitations(html, meta, msgIndex) {
    if (!meta?.sources?.length) return html;
    const known = new Set(meta.sources.map((s) => s.id));
    return html.replace(/\[(~?)((?:S\d+)(?:\s*[,;&]\s*(?:and\s+)?S?\d+)*)\]/gi, (_, auto, group) =>
      [...group.matchAll(/\d+/g)].map(([n]) => {
        const id = `S${n}`;
        if (!known.has(id)) return `<span class="cite invalid" title="This source does not exist">${id}?</span>`;
        const title = auto ? `Matched automatically to source ${id}` : `Show source ${id}`;
        return `<button class="cite${auto ? " auto" : ""}" data-action="show-source" data-msg="${msgIndex}" data-src="${id}" title="${title}">${id}</button>`;
      }).join(""));
  }

  renderMeta(meta) {
    if (!meta) return "";
    const parts = [];
    if (meta.model) parts.push(escapeHtml(meta.model.replace(/-MLC$/, "")));
    if (meta.tokensPerSec) parts.push(`${meta.tokensPerSec.toFixed(1)} tok/s`);
    const r = meta.retrieval;
    if (r) {
      const how = {
        summary: "spread across document", sample: "document sample", extract: "extraction", compliance: "compliance check",
        search: r.semanticUsed ? "keyword + semantic search" : "keyword search",
      }[r.mode];
      parts.push(`${meta.sources?.length ?? 0} of ${r.totalChunks} passages · ${how}`);
      if (r.semanticPending) parts.push("semantic index still building");
    }
    if (meta.route?.intent === "general") parts.push("routed: general question");
    if (meta.droppedTurns > 0) parts.push(`${meta.droppedTurns} older message(s) not in context`);
    return parts.length ? `<span class="msg-meta">${parts.join(" · ")}</span>` : "";
  }

  renderGrounding(meta, msgIndex) {
    const v = meta?.verification;
    if (!v) return "";
    const badge = {
      grounded: v.autoCited?.length
        ? `<span class="ground-badge ok">✓ Figures match the sources · citations matched automatically</span>`
        : `<span class="ground-badge ok">✓ Citations and figures match the sources</span>`,
      abstained: `<span class="ground-badge muted">Not found in document</span>`,
      general: `<span class="ground-badge muted">General knowledge, not from ${escapeHtml(meta.doc || "the document")} · may be wrong or out of date</span>`,
      warning: `<span class="ground-badge warn">⚠ Check this answer: ${v.issues.map((x) => escapeHtml(describeIssue(x))).join("; ")}</span>`,
    }[v.status];

    if (!meta.sources?.length) return `<div class="grounding">${badge}</div>`;
    const cited = new Set(v.citedIds);
    const items = meta.sources.map((s) => `
      <div class="source-item${cited.has(s.id) ? " cited" : ""}" data-src-id="${msgIndex}-${s.id}">
        <div class="source-head"><strong>${s.id}</strong> · p. ${s.page}${s.section ? ` · ${escapeHtml(s.section)}` : ""}${cited.has(s.id) ? " · cited" : ""}</div>
        <div class="source-text">${escapeHtml(s.text)}</div>
      </div>`).join("");
    return `
      <div class="grounding">
        ${badge}
        <details class="sources" id="sources-${msgIndex}">
          <summary>Sources: ${cited.size} cited of ${meta.sources.length} provided</summary>
          ${items}
        </details>
      </div>`;
  }

  showSource(el) {
    const details = $(`sources-${el.dataset.msg}`);
    if (!details) return;
    details.open = true;
    const item = details.querySelector(`[data-src-id="${el.dataset.msg}-${el.dataset.src}"]`);
    if (!item) return;
    item.classList.add("flash");
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => item.classList.remove("flash"), 1200);
  }

  scrollToBottom() {
    const el = $("chat-messages-scroll");
    el.scrollTop = el.scrollHeight;
  }

  autoGrow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }

  // ---------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------
  populateModelSelect() {
    const select = $("diag-model-select");
    const models = this.llm.availableModels();
    for (const m of models) {
      const option = document.createElement("option");
      option.value = m.key;
      option.textContent = m.label;
      select.append(option);
    }
    // A self-hosted mirror may not include the remembered or default model.
    if (models.length && !models.some((m) => m.key === this.modelKey)) this.modelKey = models[0].key;
    select.value = LocalLLM.modelByKey(this.modelKey).key;
    $("diag-source").textContent = this.modelSource?.selfHosted
      ? "Model files are served by this organisation's own server and cached by the browser."
      : "Model weights are downloaded once from Hugging Face and cached by the browser.";
  }

  updateDiagnostics() {
    const selectedId = this.llm.resolveModelId(this.modelKey);
    const record = LocalLLM.modelRecord(selectedId);
    const usage = this.llm.lastUsage;

    $("diag-adapter").textContent = `${this.llm.gpu.description}${this.llm.gpu.f16 ? " (f16)" : ""}`;
    $("diag-status").textContent = $("top-status-text").textContent;
    $("diag-model-id").textContent = selectedId + (this.llm.loadedModelId === selectedId ? " (loaded)" : "");
    $("diag-vram").textContent = record ? `${Math.round(record.vram_required_MB).toLocaleString()} MB` : "—";
    $("diag-context").textContent = `${LocalLLM.contextWindow(selectedId).toLocaleString()} tokens`;
    $("diag-speed").textContent = usage?.extra?.decode_tokens_per_s ? `${usage.extra.decode_tokens_per_s.toFixed(1)} tok/s` : "—";
    $("diag-ttft").textContent = usage?.extra?.time_to_first_token_s ? `${usage.extra.time_to_first_token_s.toFixed(2)} s` : "—";

    const loaded = this.llm.loadedModelId;
    $("model-pill-name").textContent = loaded
      ? LocalLLM.modelByKey(MODELS.find((m) => m.f16 === loaded || m.f32 === loaded)?.key).label.replace(/\s*\(.*\)$/, "")
      : "No model loaded";
    $("top-speed-indicator").textContent = usage?.extra?.decode_tokens_per_s ? `${usage.extra.decode_tokens_per_s.toFixed(1)} tok/s` : "—";
  }

  showDiagnostics(show) {
    if (show) {
      this.updateDiagnostics();
      this.updateLearningDiagnostics();
      this.updateVaultDiagnostics();
    }
    $("telemetry-modal").style.display = show ? "flex" : "none";
  }

  // ---------------------------------------------------------------
  // Voice
  // ---------------------------------------------------------------
  setupSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    this.recognition = new SR();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = navigator.language || "en-US";
    this.recognition.onstart = () => { this.isRecording = true; this.updateVoiceUI(); };
    this.recognition.onend = () => { this.isRecording = false; this.updateVoiceUI(); };
    this.recognition.onerror = () => { this.isRecording = false; this.updateVoiceUI(); };
    this.recognition.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      $("chat-textarea").value = text;
      this.autoGrow($("chat-textarea"));
    };
  }

  toggleVoice() {
    if (!this.recognition) {
      this.toast("Dictation is not supported in this browser.");
      return;
    }
    if (this.isRecording) {
      this.recognition.stop();
      return;
    }
    // Chrome and Edge send dictation audio to the browser vendor's cloud speech service.
    if (storage.get("kredibble_dictation_ack") !== "yes") {
      const ok = confirm(
        "Dictation uses your browser's built-in speech service. In Chrome and Edge, audio is sent to Google or Microsoft for transcription — it does NOT stay on this device.\n\nContinue?"
      );
      if (!ok) return;
      storage.set("kredibble_dictation_ack", "yes");
    }
    $("chat-textarea").value = "";
    this.recognition.start();
  }

  updateVoiceUI() {
    $("voice-wave-container").style.display = this.isRecording ? "flex" : "none";
    $("chat-textarea").style.display = this.isRecording ? "none" : "block";
    $("mic-btn").classList.toggle("recording", this.isRecording);
    if (!this.isRecording) $("chat-textarea").focus();
  }

  toggleTTS() {
    this.ttsEnabled = !this.ttsEnabled;
    storage.set("kredibble_tts", this.ttsEnabled ? "on" : "off");
    if (!this.ttsEnabled) window.speechSynthesis?.cancel();
    this.updateTTSButton();
  }

  updateTTSButton() {
    $("tts-icon").textContent = this.ttsEnabled ? "🔊" : "🔇";
    $("tts-toggle-btn").classList.toggle("active", this.ttsEnabled);
  }

  speak(text) {
    if (!text || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text.replace(/\[~?S\d+[^\]]*\]/gi, "").replace(/[*#_`>|]/g, ""));
    utter.rate = 1.05;
    window.speechSynthesis.speak(utter);
  }

  // ---------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------
  async copyMessage(index) {
    const text = this.getActiveThread().messages[index]?.content;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast("Copied to clipboard.");
    } catch {
      this.toast("Clipboard access was blocked.");
    }
  }

  applyTheme(theme) {
    storage.set("kredibble_theme", theme);
    document.body.className = `theme-${theme}`;
    $("theme-btn").textContent = theme === "dark" ? "☀️" : "🌘";
  }

  // ---------------------------------------------------------------
  // Personal data scan (privacy/pii.js), entirely on this device
  // ---------------------------------------------------------------
  async scanPersonalData() {
    const doc = this.activeDoc;
    if (!doc || this.isStreaming) return;
    const report = scanDocument(doc.pages);
    const thread = this.getActiveThread();
    if (!thread.messages.length) thread.title = `Personal data scan: ${doc.filename}`.slice(0, 40);

    let content;
    if (!report.total) {
      content = `No personal identifiers with a recognisable format were found in **${doc.filename}**.\n\n` +
        "_Checked: emails, phone numbers, payment cards (Luhn-validated), IBANs (checksum-validated), UK NI and US SSN numbers, IP addresses. " +
        "Names and other free-text personal data are not detected, so this does not prove the document holds no personal data._";
    } else {
      const rows = Object.entries(report.counts).map(([type, count]) => {
        const hits = report.findings.filter((f) => f.type === type);
        const pages = [...new Set(hits.map((f) => f.page))].slice(0, 8).join(", ");
        return `| ${PII_LABELS[type]} | ${count} | ${pages} | ${hits.slice(0, 2).map((f) => `\`${mask(f.value)}\``).join(", ")} |`;
      });
      content = [
        `Found **${report.total}** personal identifier${report.total === 1 ? "" : "s"} in **${doc.filename}**:`,
        "",
        "| Type | Count | Pages | Examples (masked) |",
        "|---|---|---|---|",
        ...rows,
        "",
        "_The scan ran on this device. Names and other free-text personal data are not detected. Use **Redacted copy** to download the text with these identifiers replaced._",
      ].join("\n");
    }
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    thread.messages.push({ role: "user", content: `Scan ${doc.filename} for personal data`, timestamp: time });
    thread.messages.push({
      role: "assistant", content, timestamp: time,
      meta: { doc: doc.filename, task: { type: "pii", total: report.total, counts: report.counts } },
    });
    await ThreadStore.save(thread);
    this.renderAll();
  }

  downloadRedacted() {
    const doc = this.activeDoc;
    if (!doc) return;
    const text = redactPages(doc.pages).map((p) => `--- Page ${p.page} ---\n${p.text}`).join("\n\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const name = doc.filename.replace(/\.[^.]+$/, "") + ".redacted.txt";
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------
  // Passphrase lock (core/vault.js)
  // ---------------------------------------------------------------
  vaultConfig() {
    try { return JSON.parse(storage.get("kredibble_vault") || "null"); } catch { return null; }
  }

  /** Shows the unlock dialog and resolves once the vault is unlocked or the data erased. */
  requireUnlock() {
    return new Promise((resolve) => {
      this.unlockResolve = resolve;
      this.openVaultDialog("unlock");
    });
  }

  openVaultDialog(mode) {
    this.vaultMode = mode;
    const create = mode === "create";
    const missingConfig = !create && !this.vaultConfig();
    $("vault-title").textContent = create ? "Set a passphrase" : "Unlock chat history";
    $("vault-text").textContent = create
      ? "Chats and feedback on this device will be encrypted. You'll need this passphrase after every reload. It cannot be recovered if forgotten."
      : missingConfig
        ? "Encrypted data was found, but its lock settings are missing (site data may have been partly cleared). It cannot be unlocked."
        : "Your chats and feedback on this device are locked with a passphrase.";
    $("vault-pass").hidden = missingConfig;
    $("vault-confirm").hidden = !create;
    $("vault-submit").hidden = missingConfig;
    $("vault-submit").textContent = create ? "Encrypt" : "Unlock";
    $("vault-cancel").hidden = !create;
    $("vault-forgot").hidden = create;
    $("vault-error").hidden = true;
    $("vault-pass").value = "";
    $("vault-confirm").value = "";
    $("vault-modal").hidden = false;
    if (!missingConfig) $("vault-pass").focus();
  }

  closeVaultDialog() {
    $("vault-modal").hidden = true;
    this.vaultMode = null;
  }

  vaultError(message) {
    $("vault-error").textContent = message;
    $("vault-error").hidden = false;
  }

  async submitVault() {
    const pass = $("vault-pass").value;
    const submit = $("vault-submit");
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Working…";
    try {
      if (this.vaultMode === "create") {
        if (pass !== $("vault-confirm").value) return this.vaultError("The passphrases don't match.");
        const { config, key } = await createVault(pass);
        this.applyKey(key);
        await ThreadStore.rewriteAll(this.threads.filter((t) => t.messages.length));
        await FeedbackStore.rewriteAll(this.feedback);
        storage.set("kredibble_vault", JSON.stringify(config));
        this.closeVaultDialog();
        this.toast("Chat history and feedback are now encrypted on this device.");
      } else {
        const key = await unlockVault(pass, this.vaultConfig());
        if (!key) return this.vaultError("That passphrase is not correct.");
        this.applyKey(key);
        this.closeVaultDialog();
        this.unlockResolve?.();
      }
    } catch (err) {
      this.vaultError(errorText(err));
    } finally {
      submit.disabled = false;
      submit.textContent = label;
      this.updateVaultDiagnostics();
    }
  }

  applyKey(key) {
    this.vaultKey = key;
    setCipher(key ? recordCipher(key) : null);
    this.lastActivity = Date.now();
  }

  async lock() {
    if (!this.vaultConfig()) return;
    if (this.isStreaming) {
      this.toast("Locking after the current answer finishes.");
      this.lockWhenIdle = true;
      return;
    }
    this.applyKey(null);
    this.threads = [];
    this.feedback = [];
    this.setDocument(null); // the loaded document may be sensitive too
    this.createThread();
    this.renderAll();
    this.showDiagnostics(false);
    await this.requireUnlock();
    await this.loadThreads();
    this.feedback = await FeedbackStore.all();
  }

  startIdleLock() {
    const touch = () => { this.lastActivity = Date.now(); };
    for (const evt of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(evt, touch, { passive: true });
    setInterval(() => {
      const idle = Date.now() - this.lastActivity > IDLE_LOCK_MS;
      if (this.vaultKey && !this.isStreaming && (idle || this.lockWhenIdle)) {
        this.lockWhenIdle = false;
        this.lock();
      }
    }, 30_000);
  }

  async removePassphrase() {
    if (!this.vaultKey || !confirm("Remove the passphrase and store chat history unencrypted on this device?")) return;
    this.applyKey(null);
    await ThreadStore.rewriteAll(this.threads.filter((t) => t.messages.length));
    await FeedbackStore.rewriteAll(this.feedback);
    storage.remove("kredibble_vault");
    this.updateVaultDiagnostics();
    this.toast("Passphrase removed. History is no longer encrypted.");
  }

  async eraseLockedData() {
    if (!confirm("Permanently erase all chat history and feedback stored in this browser? This cannot be undone.")) return;
    await ThreadStore.clear();
    await FeedbackStore.clear();
    storage.remove("kredibble_vault");
    this.applyKey(null);
    this.closeVaultDialog();
    this.unlockResolve?.();
    this.toast("Local chat history and feedback erased.");
  }

  updateVaultDiagnostics() {
    const locked = !!this.vaultConfig();
    $("diag-vault").textContent = locked ? "Encrypted with your passphrase (unlocked)" : "Not encrypted";
    $("diag-vault-set").hidden = locked;
    $("diag-vault-lock").hidden = !locked;
    $("diag-vault-remove").hidden = !locked;
  }

  // ---------------------------------------------------------------
  // Feedback (stored on this device; reused as examples if enabled)
  // ---------------------------------------------------------------
  renderRatingButtons(m, i) {
    const rating = m.meta?.feedback?.rating;
    return `
      <button class="msg-action-btn rate${rating === "up" ? " active" : ""}" data-action="feedback-up" data-index="${i}" title="Good answer">👍</button>
      <button class="msg-action-btn rate${rating === "down" ? " active" : ""}" data-action="feedback-down" data-index="${i}" title="Bad answer: tell us why">👎</button>`;
  }

  renderFeedbackForm(i) {
    const current = this.getActiveThread().messages[i]?.meta?.feedback || {};
    const reasons = REASONS.map((r) => `
      <label class="fb-reason"><input type="checkbox" name="fb-reason" value="${r.code}"${current.reasons?.includes(r.code) ? " checked" : ""}> ${escapeHtml(r.label)}</label>`).join("");
    return `
      <div class="feedback-form" data-feedback-form="${i}">
        <div class="fb-title">What was wrong?</div>
        <div class="fb-reasons">${reasons}</div>
        <textarea class="fb-correction" rows="2" maxlength="1000" placeholder="What should the answer be? (optional, saved on this device only)">${escapeHtml(current.correction || "")}</textarea>
        <div class="fb-buttons">
          <button class="btn-top-action" data-action="feedback-cancel">Cancel</button>
          <button class="btn-top-action" data-action="feedback-save" data-index="${i}">Save feedback</button>
        </div>
      </div>`;
  }

  /** The user message that an assistant reply at `index` answered. */
  questionFor(thread, index) {
    for (let j = index - 1; j >= 0; j--) if (thread.messages[j].role === "user") return thread.messages[j].content;
    return "";
  }

  openFeedbackForm(index) {
    this.feedbackFormFor = this.feedbackFormFor === index ? null : index;
    this.renderMessages();
    document.querySelector(`[data-feedback-form="${index}"] .fb-correction`)?.scrollIntoView({ block: "nearest" });
  }

  saveFeedbackForm(index) {
    const form = document.querySelector(`[data-feedback-form="${index}"]`);
    const reasons = [...form.querySelectorAll('input[name="fb-reason"]:checked')].map((x) => x.value);
    const correction = form.querySelector(".fb-correction").value;
    this.feedbackFormFor = null;
    return this.rate(index, "down", { reasons, correction });
  }

  async rate(index, rating, { reasons = [], correction = "" } = {}) {
    const thread = this.getActiveThread();
    const message = thread.messages[index];
    if (!message) return;
    const id = `${thread.id}:${index}`;

    // Clicking 👍 again removes the rating.
    if (rating === "up" && message.meta?.feedback?.rating === "up") {
      delete message.meta.feedback;
      await FeedbackStore.remove(id).catch(() => {});
      this.feedback = this.feedback.filter((r) => r.id !== id);
    } else {
      const record = buildRecord({
        threadId: thread.id, messageIndex: index, question: this.questionFor(thread, index), message,
        rating, reasons, correction, docFingerprint: this.docFingerprint, registryVersion: registry.version,
      });
      try {
        await FeedbackStore.save(record);
      } catch (err) {
        this.toast(`Could not save feedback: ${errorText(err)}`);
        return;
      }
      this.feedback = [...this.feedback.filter((r) => r.id !== id), record];
      message.meta = { ...message.meta, feedback: { rating, reasons: record.reasons, correction: record.correction } };
      sendEvent(buildEvent("feedback", message, { rating, reasons: record.reasons }));
      this.toast(rating === "up" ? "Thanks! Saved on this device." : "Thanks. Feedback saved on this device.");
    }
    await ThreadStore.save(thread);
    this.renderMessages();
    this.updateLearningDiagnostics();
  }

  updateLearningDiagnostics() {
    const up = this.feedback.filter((r) => r.rating === "up").length;
    const down = this.feedback.length - up;
    const corrected = this.feedback.filter((r) => r.correction).length;
    $("diag-feedback").textContent = `${this.feedback.length} saved (👍 ${up} · 👎 ${down}, ${corrected} with corrections)`;
    $("diag-fewshot").checked = this.useExamples;
    $("diag-metrics").checked = metricsEnabled();
    const sample = lastEvent() || buildEvent("answer", { meta: { model: this.llm.loadedModelId || "none", route: { intent: "qa" }, verification: { status: "grounded", issues: [] } } }, { latencyMs: 12000 });
    $("diag-metrics-sample").textContent = JSON.stringify(sample, null, 1);
  }

  exportFeedback() {
    // Exports leave the app, so recognisable identifiers are redacted (see privacy/pii.js).
    const records = this.feedback.map((r) => ({ ...r, question: redact(r.question || ""), answer: redact(r.answer || ""), correction: redact(r.correction || "") }));
    const payload = {
      exportedAt: new Date().toISOString(),
      registryVersion: registry.version,
      redaction: "Emails, phone numbers, card numbers, IBANs, NI/SSN numbers and IP addresses were replaced. Names and other free text were not.",
      records,
      evalCandidates: toEvalCandidates(records),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `kredibble-feedback-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async clearFeedback() {
    if (!confirm("Delete all feedback saved in this browser?")) return;
    await FeedbackStore.clear();
    this.feedback = [];
    for (const t of this.threads) for (const m of t.messages) if (m.meta?.feedback) delete m.meta.feedback;
    await Promise.all(this.threads.filter((t) => t.messages.length).map((t) => ThreadStore.save(t)));
    this.renderMessages();
    this.updateLearningDiagnostics();
    this.toast("Feedback deleted.");
  }

  toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
}

const app = new KredibbleApp();
app.init();

// Support/diagnostics hook: open the app with ?debug to inspect retrieval in the console.
// Everything it exposes already lives in this browser tab.
if (new URLSearchParams(location.search).has("debug")) {
  window.kredibble = { app, DocumentIndex, Embedder, shouldAbstain };
}
