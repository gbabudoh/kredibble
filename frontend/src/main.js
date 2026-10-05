// Kredibble web client: on-device chat over WebLLM.
import "@fontsource-variable/inter";
import "./styles.css";
import { LocalLLM, isEngineLost } from "./engine/llm.js";
import { loadModelSource } from "./engine/source.js";
import { MODELS, DEFAULT_MODEL_KEY } from "./engine/models.js";
import { ThreadStore, FeedbackStore, setCipher, hasSealedRecords } from "./core/db.js";
import { createVault, recordCipher, unlockVault } from "./core/vault.js";
import { renderMarkdown, escapeHtml, escapeAutoCitations } from "./core/render.js";
import { icon } from "./core/icons.js";
import { PERSONAS, getPersona, personaForUserType, DEFAULT_PERSONA_ID } from "./core/personas.js";
import { AccountAPI } from "./services/account.js";
import { storage } from "./core/storage.js";
import { UNLIMITED, PLAN_LABELS, GuestCounter, canUseModel, canUseWorkspace, timeZone, workspaceUnlockLabel } from "./core/plans.js";
import { planTurn, assembleMessages, examplesTokens, ANSWER_MAX_TOKENS } from "./core/prompt.js";
import { extractDocument } from "./services/documents.js";
import { DocumentIndex, combineDocuments, pageLabel, chunkIndexText, normalize, retrievalQuery, shouldAbstain } from "./rag/retriever.js";
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


const IDLE_LOCK_MS = 15 * 60 * 1000;

const HERO_PROMPTS = [
  { icon: "globe", title: "Ask a general question", desc: "Answered privately on this device", prompt: "What is the capital of the UK?" },
  { icon: "list", title: "NDA review checklist", desc: "Key clauses to check in a mutual NDA", prompt: "Give me a checklist of the key clauses to review in a mutual NDA, with one line on why each matters." },
  { icon: "shield", title: "Explain GDPR data minimisation", desc: "Article 5(1)(c) in plain English", prompt: "Explain GDPR Article 5(1)(c) data minimisation in plain English, with two practical examples." },
  { icon: "fileSearch", title: "Analyse a document", desc: "PDF or text, read in this browser", action: "pick-file" },
];

class KredibbleApp {
  constructor() {
    this.llm = new LocalLLM();
    this.threads = [];
    this.activeThreadId = null;
    this.docs = []; // attached documents; searched together as this.activeDoc
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
    this.activePersonaId = getPersona(storage.get("kredibble_persona", DEFAULT_PERSONA_ID)).id;
    this.activeTier = storage.get("kredibble_tier", "free");
    this.ttsEnabled = storage.get("kredibble_tts", "off") === "on";
    this.renderQueued = false;
    this.stickToBottom = true; // follow new output unless the reader has scrolled up
    this.renderedTurns = { threadId: null, count: 0 };
    this.account = null; // signed-in account (identity and plan only), or null
    this.accountsEnabled = false;
    this.entitlements = UNLIMITED; // what this browser may use; replaced by the server's answer
    this.messagesUsed = 0; // today
    this.billingInterval = "month"; // pricing window: "month" | "year"
    this.authView = "signin";
    this.resetToken = null;
  }

  async init() {
    this.applyTheme(storage.get("kredibble_theme", "dark"));
    this.updateTTSButton();
    this.updatePersonaUI();
    this.renderPersonaModalGrid();
    this.bindEvents();
    this.setupSpeechRecognition();
    const source = await loadModelSource();
    this.llm.setSource(source);
    if (source.selfHosted) this.embedder.appConfig = source.appConfig;
    this.modelSource = source;
    this.populateModelSelect();
    // Plan limits decide the workspace, model and history saving, so they come first.
    await this.loadAccount();

    if (this.vaultConfig() || (await hasSealedRecords())) await this.requireUnlock();
    await this.loadThreads();
    this.feedback = await FeedbackStore.all();
    this.startIdleLock();
    this.handleAccountLinks();

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
      "toggle-sidebar": () => this.toggleSidebar(),
      "toggle-theme": () => this.applyTheme(document.body.classList.contains("theme-dark") ? "light" : "dark"),
      "toggle-tts": () => this.toggleTTS(),
      "show-telemetry": () => this.showDiagnostics(true),
      "hide-telemetry": () => this.showDiagnostics(false),
      "load-model": () => this.loadModel(),
      "jump-latest": () => this.scrollToBottom({ force: true, smooth: true }),
      "clear-model-cache": () => this.clearModelCache(),
      "purge-history": () => this.purgeHistory(),
      "pick-file": () => (this.entitlements.documents ? $("file-upload-input").click() : this.promptUpgrade("Attaching documents needs a free account.")),
      "limit-action": () => this.limitAction(),
      "limit-signin": () => { $("limit-banner").hidden = true; this.openAuth("signin"); },
      "limit-dismiss": () => { $("limit-banner").hidden = true; },
      "remove-doc": () => this.setDocument(null),
      "remove-doc-file": (el) => this.removeDocument(Number(el.dataset.index)),
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
      "pii-scan": () => (this.entitlements.pii_scan ? this.scanPersonalData() : this.promptUpgrade("The personal-data scan needs a free account.")),
      "pii-download": () => (this.entitlements.pii_redaction ? this.downloadRedacted() : this.promptUpgrade("Redacted copies are part of Pro.")),
      "open-persona-modal": () => this.showPersonaModal(true),
      "close-persona-modal": () => this.showPersonaModal(false),
      "select-persona": (el) => this.selectPersona(el.dataset.id),
      "toggle-workspace-menu": () => this.showWorkspaceMenu($("workspace-menu").hidden),
      "open-workspace-menu": () => this.openWorkspaceMenuFromTopbar(),
      "open-auth": (el) => this.openAuth(el.dataset.view),
      "close-auth": () => this.closeAuth(),
      "sign-out": () => this.signOut(),
      "resend-verification": () => this.resendVerification(),
      "save-account": () => this.saveAccount(),
      "delete-account": () => this.deleteAccount(),
      "open-tier-modal": () => this.showTierModal(true),
      "close-tier-modal": () => this.showTierModal(false),
      "subscribe-tier": (el) => this.handleSubscription(el.dataset.tier),
      "manage-billing": () => this.manageBilling(),
      "billing-interval": (el) => this.setBillingInterval(el.dataset.interval),
      "contact-enterprise": () => this.handleEnterpriseContact(),
      "vault-set": () => (this.entitlements.passphrase_lock ? this.openVaultDialog("create") : this.promptUpgrade("Passphrase lock is part of Pro.")),
      "vault-lock": () => this.lock(),
      "vault-remove": () => this.removePassphrase(),
      "vault-forgot": () => this.eraseLockedData(),
      "vault-cancel": () => this.closeVaultDialog(),
      "clear-feedback": () => this.clearFeedback(),
      "speak": (el) => this.speak(this.getActiveThread().messages[Number(el.dataset.index)]?.content),
    };

    document.addEventListener("click", (e) => {
      if (!$("workspace-menu").hidden && !e.target.closest(".workspace-switcher, .topbar-workspace")) this.showWorkspaceMenu(false);
      const el = e.target.closest("[data-action]");
      if (!el || !actions[el.dataset.action]) return;
      e.preventDefault();
      e.stopPropagation();
      actions[el.dataset.action](el);
    });

    $("telemetry-modal").addEventListener("click", (e) => {
      if (e.target.id === "telemetry-modal") this.showDiagnostics(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("auth-modal").hidden) this.closeAuth();
      if (e.key === "Escape" && !$("workspace-menu").hidden) {
        this.showWorkspaceMenu(false);
        $("workspace-btn").focus();
      }
    });
    $("auth-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitAuth();
    });
    $("auth-modal").addEventListener("click", (e) => {
      if (e.target.id === "auth-modal") this.closeAuth();
    });
    $("persona-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "persona-modal") this.showPersonaModal(false);
    });
    $("tier-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "tier-modal") this.showTierModal(false);
    });

    $("chat-messages-scroll").addEventListener("scroll", () => {
      const el = $("chat-messages-scroll");
      this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      $("jump-latest").hidden = this.stickToBottom;
    }, { passive: true });

    const textarea = $("chat-textarea");
    textarea.addEventListener("input", () => this.autoGrow(textarea));
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!this.isStreaming) this.sendMessage();
      }
    });

    $("file-upload-input").addEventListener("change", (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = "";
      if (files.length) this.handleFiles(files);
    });
    document.body.addEventListener("dragover", (e) => e.preventDefault());
    document.body.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) this.handleFiles(files);
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
    $("status-dot").dataset.state = state;
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
  /** Reads files in this browser. Plans with several documents add to the set; others replace it. */
  async handleFiles(files) {
    if (!this.entitlements.documents) {
      this.promptUpgrade("Attaching documents needs a free account.");
      return;
    }
    const max = this.entitlements.max_documents; // null: no limit
    const keep = max === 1 ? [] : this.docs;
    const room = max == null ? files.length : max - keep.length;
    if (room <= 0) {
      this.promptUpgrade(`Your plan searches up to ${max} documents together.${max < 20 ? " Business searches up to 20." : " Remove one to add another."}`);
      return;
    }
    if (files.length > room) this.toast(`Only ${room} more document${room === 1 ? "" : "s"} fit${room === 1 ? "s" : ""} your plan; the rest were skipped.`);

    $("attached-doc-chip").hidden = false;
    $("attached-doc-meta").textContent = "(reading…)";
    const added = [];
    for (const file of files.slice(0, room)) {
      try {
        const doc = await extractDocument(file);
        if (this.documentAllowed(doc)) added.push(doc);
      } catch (err) {
        this.toast(`${file.name}: ${errorText(err)}`);
      }
    }
    // Re-adding a file with the same name replaces the earlier copy.
    this.setDocuments([...keep.filter((d) => !added.some((a) => a.filename === d.filename)), ...added]);
  }

  setDocument(doc) {
    this.setDocuments(doc ? [doc] : []);
  }

  removeDocument(index) {
    this.setDocuments(this.docs.filter((_, i) => i !== index));
  }

  setDocuments(docs) {
    this.docs = docs;
    const doc = docs.length ? combineDocuments(docs) : null;
    this.activeDoc = doc;
    this.docIndex = doc ? new DocumentIndex(doc) : null;
    this.docFingerprint = null;
    if (doc) documentFingerprint(doc.pages).then((fp) => { if (this.activeDoc === doc) this.docFingerprint = fp; }).catch(() => {});
    this.semantic = { state: "off", progress: 0 };
    $("attached-doc-chip").hidden = !doc;
    if (doc) {
      this.renderDocNames();
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

  renderDocNames() {
    const name = $("attached-doc-name");
    if (this.docs.length === 1) {
      name.textContent = this.docs[0].filename;
      return;
    }
    name.innerHTML = this.docs.map((d, i) => `
      <span class="doc-file">${escapeHtml(d.filename)}<button class="doc-file-remove" data-action="remove-doc-file" data-index="${i}" title="Remove ${escapeHtml(d.filename)}" aria-label="Remove ${escapeHtml(d.filename)}">${icon("x", 11)}</button></span>`).join("");
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
    const count = this.docs.length > 1 ? `${this.docs.length} documents · ` : "";
    $("attached-doc-meta").textContent = `(${count}${pages} · ${this.docIndex.chunks.length} passages · ${search} · stays on this device)`;
  }

  // ---------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------
  async loadThreads() {
    this.threads = await ThreadStore.all();
    this.openLatestThread();
    this.renderThreads();
    this.renderMessages();
  }

  /** Chats belong to one workspace. Chats saved before workspaces existed belong to the default one. */
  workspaceThreads() {
    return this.threads.filter((t) => (t.workspaceId || DEFAULT_PERSONA_ID) === this.activePersonaId);
  }

  /** Opens the newest chat in the active workspace, or starts one. */
  openLatestThread() {
    const [latest] = this.workspaceThreads();
    if (latest) this.activeThreadId = latest.id;
    else this.createThread();
  }

  createThread() {
    const now = new Date().toISOString();
    const thread = { id: `thread-${Date.now()}`, title: "New chat", workspaceId: this.activePersonaId, messages: [], createdAt: now, updatedAt: now };
    this.threads.unshift(thread);
    this.activeThreadId = thread.id;
    return thread;
  }

  getActiveThread() {
    const threads = this.workspaceThreads();
    return threads.find((t) => t.id === this.activeThreadId) || threads[0];
  }

  isNarrow() {
    return window.matchMedia("(max-width: 860px)").matches;
  }

  /** Small screens: slide the sidebar over the chat. Wide screens: collapse it. */
  toggleSidebar() {
    if (this.isNarrow()) document.body.classList.toggle("sidebar-open");
    else $("app-sidebar").classList.toggle("collapsed");
  }

  closeMobileSidebar() {
    document.body.classList.remove("sidebar-open");
  }

  newChat() {
    if (this.isStreaming) return;
    this.closeMobileSidebar();
    this.createThread();
    this.setDocument(null);
    this.renderThreads();
    this.renderMessages();
    $("chat-textarea").focus();
  }

  selectThread(id) {
    if (this.isStreaming) return;
    this.closeMobileSidebar();
    this.activeThreadId = id;
    this.renderThreads();
    this.renderMessages();
  }

  async deleteThread(id) {
    if (this.isStreaming) return;
    await ThreadStore.remove(id);
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) this.openLatestThread();
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

    const route = routeMessage(text, {
      hasDocument: !!this.docIndex,
      documentOverlap: this.docIndex ? this.docIndex.bm25.search(text, 1).weightedCoverage : 0,
    });
    // Plan checks come first; a blocked question stays in the input box.
    if (route.intent === "compliance" && !this.entitlements.checklists) {
      this.promptUpgrade("Compliance checklists are part of Pro.");
      return;
    }
    if (this.sendPending) return;
    this.sendPending = true;
    const allowed = await this.takeMessage().finally(() => { this.sendPending = false; });
    if (!allowed) return;

    textarea.value = "";
    this.autoGrow(textarea);

    const thread = this.getActiveThread();
    if (!thread.messages.length) thread.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;

    const time = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    thread.messages.push({ role: "user", content: text, timestamp: time() });
    const useDocument = !!this.docIndex && route.intent !== "general";
    const persona = getPersona(this.activePersonaId);

    let plan;
    try {
      plan = planTurn({
        history: thread.messages,
        withDocument: useDocument,
        docMode: route.intent === "summary" ? "summary" : "search",
        personaDirective: persona.systemDirective,
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
      await this.saveThread(thread);
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
      const turns = document.querySelectorAll(".msg-turn.assistant");
      const turn = turns[turns.length - 1];
      if (turn) {
        turn.classList.add("streaming");
        turn.querySelector(".msg-body").innerHTML = renderMarkdown(text);
      }
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
    const visible = this.workspaceThreads().filter((t) => t.messages.length || t.id === this.activeThreadId);

    const heading = document.createElement("div");
    heading.className = "sidebar-section-label";
    heading.textContent = "Chats";
    container.append(heading);

    if (!this.entitlements.save_history) {
      const note = document.createElement("p");
      note.className = "threads-note";
      note.innerHTML = `New chats aren't saved while signed out. <button class="link-btn" data-action="open-auth" data-view="signin">Sign in</button> to keep them.`;
      container.append(note);
    }

    for (const t of visible) {
      const item = document.createElement("div");
      item.className = `thread-item${t.id === this.activeThreadId ? " active" : ""}`;
      item.dataset.action = "select-thread";
      item.dataset.id = t.id;

      const glyph = document.createElement("span");
      glyph.className = "thread-icon";
      glyph.innerHTML = icon("chat", 15);

      const title = document.createElement("span");
      title.className = "thread-title";
      title.textContent = t.title || "New chat";

      const del = document.createElement("button");
      del.className = "thread-delete";
      del.title = "Delete chat";
      del.setAttribute("aria-label", "Delete chat");
      del.innerHTML = icon("trash", 14);
      del.dataset.action = "delete-thread";
      del.dataset.id = t.id;

      item.append(glyph, title, del);
      container.append(item);
    }
  }

  renderMessages() {
    const container = $("messages-container");
    const thread = this.getActiveThread();

    if (!thread || !thread.messages.length) {
      const persona = getPersona(this.activePersonaId);
      container.innerHTML = `
        <div class="hero">
          <div class="hero-persona-tag">
            ${icon(persona.icon, 15)}
            <span>${persona.tagline}</span>
          </div>
          <h2 class="hero-title">${persona.shortName}</h2>
          <p class="hero-subtitle">${persona.description}</p>
          <div class="hero-guarantee">
            ${icon("shieldCheck", 14)}
            <span>${persona.privacyGuarantee}</span>
          </div>
          <div class="hero-grid">
            ${persona.suggestedPrompts.map((p) => `
              <div class="hero-card" data-action="${p.action || "hero-prompt"}" ${p.prompt ? `data-prompt="${escapeHtml(p.prompt)}"` : ""}>
                <span class="hero-card-icon">${icon(p.icon, 16)}</span>
                <span>
                  <span class="hero-card-title">${p.title}</span>
                  <span class="hero-card-desc">${p.desc}</span>
                </span>
              </div>`).join("")}
          </div>
        </div>`;
      return;
    }

    const lastIndex = thread.messages.length - 1;
    // Only turns added since the last render animate in; re-renders and thread switches stay still.
    const seen = this.renderedTurns.threadId === thread.id ? this.renderedTurns.count : thread.messages.length;
    const grew = thread.messages.length > seen;
    this.renderedTurns = { threadId: thread.id, count: thread.messages.length };
    container.innerHTML = thread.messages.map((m, i) => {
      const isAssistant = m.role === "assistant";
      const streaming = isAssistant && this.isStreaming && i === lastIndex && !!m.content;
      const pending = isAssistant && !m.content && this.isStreaming && i === lastIndex;
      const showActions = isAssistant && m.content && !(this.isStreaming && i === lastIndex);
      const body = isAssistant
        ? (pending ? `<span class="msg-pending">Thinking on this device…</span>`
          : showActions ? this.decorateCitations(renderMarkdown(escapeAutoCitations(m.content)), m.meta, i) : renderMarkdown(m.content))
        : `<div class="msg-user-text">${escapeHtml(m.content)}</div>`;
      return `
        <div class="msg-turn ${m.role}${m.error ? " error" : ""}${i >= seen ? " enter" : ""}${streaming ? " streaming" : ""}">
          <div class="msg-avatar">${icon("shieldCheck", 15)}</div>
          <div class="msg-content">
            <div class="msg-body">${body}</div>
            ${showActions ? `
              <div class="msg-actions">
                <button class="msg-action-btn" data-action="copy" data-index="${i}" title="Copy" aria-label="Copy">${icon("copy", 15)}</button>
                <button class="msg-action-btn" data-action="speak" data-index="${i}" title="Read aloud" aria-label="Read aloud">${icon("volume", 15)}</button>
                ${m.error || m.meta?.task?.type === "pii" ? "" : this.renderRatingButtons(m, i)}
                ${m.meta?.task?.type === "pii" && m.meta.task.total && this.activeDoc?.filename === m.meta.doc
                  ? `<button class="msg-action-btn" data-action="pii-download" title="Download a redacted text copy">${icon("download", 15)}<span>Redacted copy</span></button>` : ""}
                ${this.renderMeta(m.meta)}
              </div>
              ${this.renderGrounding(m.meta, i)}
              ${this.feedbackFormFor === i ? this.renderFeedbackForm(i) : ""}` : ""}
          </div>
        </div>`;
    }).join("");
    this.scrollToBottom({ force: grew });
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
    const r = meta.retrieval;
    if (r) {
      const how = {
        summary: "summary of the whole document", sample: "document sample", extract: "extraction", compliance: "compliance check",
        search: r.semanticUsed ? "smart search" : "keyword search",
      }[r.mode] || "";
      const n = meta.sources?.length ?? 0;
      parts.push(`${n} source${n === 1 ? "" : "s"}${how ? ` · ${how}` : ""}`);
      if (r.semanticPending) parts.push("smart search still preparing");
    }
    if (meta.route?.intent === "general") parts.push("general knowledge");
    if (meta.droppedTurns > 0) parts.push("older messages not used");
    if (meta.tokensPerSec) parts.push(`${meta.tokensPerSec.toFixed(1)} tok/s`);
    const detail = [meta.model?.replace(/-MLC$/, ""), r ? `${meta.sources?.length ?? 0} of ${r.totalChunks} passages` : ""].filter(Boolean).join(" · ");
    return parts.length ? `<span class="msg-meta" title="${escapeHtml(detail)}">${parts.join(" · ")}</span>` : "";
  }

  renderGrounding(meta, msgIndex) {
    const v = meta?.verification;
    if (!v) return "";
    const badge = {
      grounded: v.autoCited?.length
        ? `<span class="ground-badge ok">${icon("check", 13)}Matches the document · sources linked automatically</span>`
        : `<span class="ground-badge ok">${icon("check", 13)}Matches the document</span>`,
      abstained: `<span class="ground-badge muted">${icon("info", 13)}Not found in the document</span>`,
      general: `<span class="ground-badge muted">${icon("globe", 13)}General knowledge, not from ${escapeHtml(meta.doc || "the document")}. May be wrong or out of date</span>`,
      warning: `<span class="ground-badge warn">${icon("alert", 13)}Check this answer: ${v.issues.map((x) => escapeHtml(describeIssue(x))).join("; ")}</span>`,
    }[v.status];

    if (!meta.sources?.length) return `<div class="grounding">${badge}</div>`;
    const cited = new Set(v.citedIds);
    const items = meta.sources.map((s) => `
      <div class="source-item${cited.has(s.id) ? " cited" : ""}" data-src-id="${msgIndex}-${s.id}">
        <div class="source-head"><span class="source-id">${s.id}</span><span>${escapeHtml(s.file ? `${s.file} · page ${s.page}` : `Page ${s.page}`)}</span>${s.section ? `<span>· ${escapeHtml(s.section)}</span>` : ""}${cited.has(s.id) ? "<span>· cited</span>" : ""}</div>
        <div class="source-text">${escapeHtml(s.text)}</div>
      </div>`).join("");
    return `
      <div class="grounding">
        ${badge}
        <details class="sources" id="sources-${msgIndex}">
          <summary>${icon("chevronRight", 14)}${meta.sources.length} source${meta.sources.length === 1 ? "" : "s"} from the document</summary>
          <div class="source-list">${items}</div>
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

  /** Keeps the newest output in view, unless the reader scrolled up (then offers a jump button). */
  scrollToBottom({ force = false, smooth = false } = {}) {
    const el = $("chat-messages-scroll");
    if (force) this.stickToBottom = true;
    if (!this.stickToBottom) {
      $("jump-latest").hidden = false;
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    $("jump-latest").hidden = true;
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
    select.replaceChildren();
    for (const m of models) {
      const option = document.createElement("option");
      option.value = m.key;
      const allowed = canUseModel(this.entitlements, m.key);
      option.textContent = allowed ? m.label : `${m.label} · Pro`;
      option.disabled = !allowed;
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
    // Name the loaded model, or the selected one while nothing is loaded; the status sits beside it.
    const shown = loaded ? MODELS.find((m) => m.f16 === loaded || m.f32 === loaded)?.key : this.modelKey;
    $("model-pill-name").textContent = LocalLLM.modelByKey(shown).label.replace(/\s*\(.*\)$/, "");
    const speed = usage?.extra?.decode_tokens_per_s;
    $("top-speed-indicator").textContent = speed ? `${speed.toFixed(1)} tok/s` : "";
    $("top-speed-indicator").hidden = !speed;
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
    const btn = $("tts-toggle-btn");
    btn.innerHTML = icon(this.ttsEnabled ? "volume" : "volumeOff", 18);
    btn.classList.toggle("active", this.ttsEnabled);
    btn.setAttribute("aria-pressed", String(this.ttsEnabled));
    btn.title = this.ttsEnabled ? "Reading answers aloud (click to turn off)" : "Read answers aloud";
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
    document.body.classList.remove("theme-dark", "theme-light");
    document.body.classList.add(`theme-${theme}`);
    $("theme-btn").innerHTML = icon(theme === "dark" ? "sun" : "moon", 18);
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
        const pages = [...new Set(hits.map((f) => (f.file ? pageLabel(f) : f.page)))].slice(0, 8).join(", ");
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
    await this.saveThread(thread);
    this.renderAll();
  }

  downloadRedacted() {
    const doc = this.activeDoc;
    if (!doc) return;
    const text = redactPages(doc.pages).map((p) => `--- ${p.file ? `${p.file}, page` : "Page"} ${p.page} ---\n${p.text}`).join("\n\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const name = (doc.files ? "documents" : doc.filename.replace(/\.[^.]+$/, "")) + ".redacted.txt";
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
    $("diag-vault-set").textContent = this.entitlements.passphrase_lock ? "Set passphrase" : "Set passphrase · Pro";
    $("diag-vault-lock").hidden = !locked;
    $("diag-vault-remove").hidden = !locked;
  }

  // ---------------------------------------------------------------
  // Feedback (stored on this device; reused as examples if enabled)
  // ---------------------------------------------------------------
  renderRatingButtons(m, i) {
    const rating = m.meta?.feedback?.rating;
    return `
      <button class="msg-action-btn${rating === "up" ? " active" : ""}" data-action="feedback-up" data-index="${i}" title="Good answer" aria-label="Good answer">${icon("thumbUp", 15)}</button>
      <button class="msg-action-btn${rating === "down" ? " active" : ""}" data-action="feedback-down" data-index="${i}" title="Bad answer: tell us why" aria-label="Bad answer">${icon("thumbDown", 15)}</button>`;
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
          <button class="btn" data-action="feedback-cancel">Cancel</button>
          <button class="btn btn-primary" data-action="feedback-save" data-index="${i}">Save feedback</button>
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
    await this.saveThread(thread);
    this.renderMessages();
    this.updateLearningDiagnostics();
  }

  updateLearningDiagnostics() {
    const up = this.feedback.filter((r) => r.rating === "up").length;
    const down = this.feedback.length - up;
    const corrected = this.feedback.filter((r) => r.correction).length;
    $("diag-feedback").textContent = this.feedback.length
      ? `${up} helpful · ${down} not helpful${corrected ? ` (${corrected} corrected)` : ""}`
      : "None yet";
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
    await Promise.all(this.threads.filter((t) => t.messages.length).map((t) => this.saveThread(t)));
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

  updatePersonaUI() {
    const persona = getPersona(this.activePersonaId);
    $("workspace-btn-icon").innerHTML = icon(persona.icon, 16);
    $("workspace-btn-name").textContent = persona.shortName;
    $("workspace-btn-audience").textContent = persona.audience;
    $("topbar-workspace-icon").innerHTML = icon(persona.icon, 14);
    $("topbar-workspace-name").textContent = persona.shortName;
    this.renderWorkspaceMenu();
  }

  renderWorkspaceMenu() {
    $("workspace-menu-list").innerHTML = PERSONAS.map((p) => {
      const active = p.id === this.activePersonaId;
      const locked = !canUseWorkspace(this.entitlements, p.id);
      const marker = active ? `<span class="workspace-check">${icon("check", 15)}</span>`
        : locked ? `<span class="lock-badge">${icon("lock", 11)}${workspaceUnlockLabel(this.entitlements, p)}</span>` : "";
      return `
        <button class="workspace-option${active ? " active" : ""}${locked ? " locked" : ""}" role="option" aria-selected="${active}" data-action="select-persona" data-id="${p.id}">
          <span class="workspace-icon">${icon(p.icon, 16)}</span>
          <span class="workspace-text">
            <span class="workspace-name">${p.shortName}</span>
            <span class="workspace-audience">${p.audience}</span>
          </span>
          ${marker}
        </button>`;
    }).join("");
  }

  showWorkspaceMenu(show) {
    $("workspace-menu").hidden = !show;
    $("workspace-btn").setAttribute("aria-expanded", String(show));
    if (show) $("workspace-menu-list").querySelector(".active")?.focus();
  }

  /** The top-bar chip is only visible while the sidebar is hidden: bring the sidebar back, then open the menu. */
  openWorkspaceMenuFromTopbar() {
    if (this.isNarrow()) document.body.classList.add("sidebar-open");
    else $("app-sidebar").classList.remove("collapsed");
    this.showWorkspaceMenu(true);
  }

  showPersonaModal(show) {
    const modal = $("persona-modal");
    if (modal) {
      modal.hidden = !show;
      if (show) this.renderPersonaModalGrid();
    }
  }

  renderPersonaModalGrid() {
    const container = $("persona-modal-grid");
    if (!container) return;
    container.innerHTML = PERSONAS.map((p) => {
      const isActive = p.id === this.activePersonaId;
      return `
        <div class="persona-card ${isActive ? "active" : ""}" data-action="select-persona" data-id="${p.id}">
          <div class="persona-card-header">
            <div class="persona-card-icon-title">
              <span class="persona-card-icon">${icon(p.icon, 18)}</span>
              <span class="persona-card-title">${p.name}</span>
            </div>
            <span class="persona-card-badge">${p.badge}</span>
          </div>
          <p class="persona-card-desc">${p.description}</p>
          <div class="persona-card-guarantee">
            ${icon("shieldCheck", 13)}
            <span>${p.deliveryMethod} · ${p.privacyGuarantee}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  /** Switching workspace shows only that workspace's chats and drops the attached document. */
  selectPersona(personaId) {
    this.showWorkspaceMenu(false);
    this.showPersonaModal(false);
    if (personaId === this.activePersonaId) return;
    if (!canUseWorkspace(this.entitlements, personaId)) {
      const persona = getPersona(personaId);
      const unlock = workspaceUnlockLabel(this.entitlements, persona);
      this.promptUpgrade(unlock === "Sign up" ? `${persona.shortName} needs a free account.` : `${persona.shortName} is part of ${unlock}.`);
      return;
    }
    if (this.isStreaming) {
      this.toast("Wait for the answer to finish before switching workspace.");
      return;
    }
    this.activePersonaId = getPersona(personaId).id;
    storage.set("kredibble_persona", this.activePersonaId);
    this.setDocument(null);
    this.openLatestThread();
    this.updatePersonaUI();
    this.renderThreads();
    this.renderMessages();
    this.toast(`Switched to ${getPersona(personaId).shortName}`);
  }

  showTierModal(show) {
    const modal = $("tier-modal");
    if (modal) modal.hidden = !show;
  }

  get hasLiveSubscription() {
    return ["active", "trialing", "past_due"].includes(this.account?.subscription_status);
  }

  renderTierModal() {
    const current = this.entitlements.plan;
    const yearly = this.billingInterval === "year";
    const prices = { pro: { month: 5, year: 48 }, business: { month: 9, year: 86 } };
    const priceLine = (plan, seat) => {
      const amount = prices[plan][this.billingInterval];
      const per = `${seat ? "/ seat " : ""}/ ${yearly ? "year" : "month"}`;
      const monthly = Math.round((prices[plan].year / 12) * 100) / 100;
      const note = yearly ? `$${monthly} a month${seat ? " per seat" : ""}, billed yearly` : "";
      return { price: `$${amount}`, unit: per, note };
    };
    const card = ({ plan, name, price, unit = "", note = "", desc, features, highlight }) => {
      const isCurrent = plan === current;
      let button;
      if (isCurrent && this.account?.has_billing) button = `<button class="btn btn-secondary full-width" data-action="manage-billing">Manage billing</button>`;
      else if (isCurrent) button = `<button class="btn btn-secondary full-width" disabled>Your plan</button>`;
      else if (plan === "free") button = this.isGuest
        ? `<button class="btn btn-primary full-width" data-action="open-auth" data-view="register">Create free account</button>`
        : `<button class="btn btn-secondary full-width" disabled>Included</button>`;
      else if (plan === "enterprise") button = `<button class="btn btn-secondary full-width" data-action="contact-enterprise">Contact us</button>`;
      else if (this.hasLiveSubscription) button = `<button class="btn btn-primary full-width" data-action="manage-billing">Switch to ${name}</button>`;
      else button = `<button class="btn btn-primary full-width" data-action="subscribe-tier" data-tier="${plan}">Upgrade to ${name}</button>`;
      return `
        <div class="pricing-card${isCurrent ? " current" : ""}${highlight && !isCurrent ? " highlighted" : ""}">
          ${isCurrent ? `<div class="pricing-badge">Your plan</div>` : highlight ? `<div class="pricing-badge popular">Most popular</div>` : ""}
          <h4 class="pricing-tier-name">${name}</h4>
          <div class="pricing-price">${price} <span>${unit}</span></div>
          ${note ? `<div class="pricing-note-line">${note}</div>` : ""}
          <p class="pricing-desc">${desc}</p>
          <ul class="pricing-features">${features.map((f) => `<li>✓ ${f}</li>`).join("")}</ul>
          ${button}
        </div>`;
    };
    $("billing-interval").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.interval === this.billingInterval)));
    $("pricing-grid").innerHTML = [
      card({ plan: "free", name: "Free", price: "$0", unit: "forever", desc: "For trying Kredibble and everyday personal use.",
        features: ["30 messages a day", "Personal Vault + 1 workspace of your choice", "1 document at a time, up to 10 pages", "Chats saved on this device", "Personal-data scan", "Standard models (Qwen3.5 2B)"] }),
      card({ plan: "pro", name: "Pro", ...priceLine("pro"), highlight: true, desc: "For founders, freelancers and small businesses.",
        features: ["300 messages a day", "All in-browser workspaces", "Up to 3 documents together, no page limit", "Larger, more accurate models (Qwen3.5 4B and up)", "Passphrase-encrypted history", "Redacted copies and compliance checklists"] }),
      card({ plan: "business", name: "Business", ...priceLine("business", true), desc: "For teams handling contracts, HR and meetings.",
        features: ["No daily limit (fair use)", "All workspaces, including team ones", "Search up to 20 documents together", "Optional private server for your team", "Everything in Pro"] }),
      card({ plan: "enterprise", name: "Enterprise & Institution", price: "Custom", desc: "For legal, healthcare, public sector and large companies.",
        features: ["Contract-based limits", "Unlimited documents together", "Dedicated on-premise deployment", "Custom checklists and redaction rules", "Compliance support (SOC 2, HIPAA, NHS)", "Everything in Business"] }),
    ].join("");
  }

  setBillingInterval(interval) {
    this.billingInterval = interval;
    this.renderTierModal();
  }

  /** Sends the browser to Stripe Checkout. Card details are entered on Stripe, never here. */
  async handleSubscription(plan) {
    if (this.isGuest) {
      this.showTierModal(false);
      this.toast("Create a free account first, then upgrade.");
      this.openAuth("register");
      return;
    }
    try {
      const { url } = await AccountAPI.checkout(plan, this.billingInterval);
      location.href = url;
    } catch (err) {
      this.toast(err.message);
    }
  }

  /** Stripe's portal: change plan or billing period, update the card, cancel, download invoices. */
  async manageBilling() {
    try {
      const { url } = await AccountAPI.billingPortal();
      location.href = url;
    } catch (err) {
      this.toast(err.message);
    }
  }

  /** Back from Stripe Checkout (?checkout=success&session_id=… or ?checkout=cancelled). */
  async finishCheckout(outcome, sessionId) {
    if (outcome !== "success") {
      this.toast("Checkout cancelled. You have not been charged.");
      return;
    }
    try {
      if (sessionId) await AccountAPI.billingSync(sessionId);
    } catch (err) {
      console.warn("Billing sync failed; the webhook will update the plan:", err);
    }
    await this.loadAccount();
    const label = PLAN_LABELS[this.entitlements.plan];
    this.toast(this.hasLiveSubscription ? `Payment received. Welcome to ${label}!` : "Payment received. Your plan will update in a moment.");
  }

  handleEnterpriseContact() {
    this.showTierModal(false);
    this.toast("Enterprise team contacted for custom deployment.");
  }

  // ---------------------------------------------------------------
  // Accounts (identity and plan only; chats stay on this device)
  // ---------------------------------------------------------------
  /** Reads who is signed in and what their plan allows, then applies it everywhere. */
  async loadAccount() {
    const session = await AccountAPI.session(timeZone());
    this.accountsEnabled = session.enabled;
    // No account database (self-hosted) or no answer from the server: nothing is locked.
    this.entitlements = session.enabled && session.entitlements ? session.entitlements : UNLIMITED;
    this.messagesUsed = session.account ? session.messages_used_today ?? 0 : GuestCounter.used();
    this.setAccount(session.account);
    this.applyEntitlements();
  }

  get isGuest() {
    return this.entitlements.plan === "guest";
  }

  /** Moves the app inside the plan: allowed workspace and model, menus, counter, pricing. */
  applyEntitlements() {
    const ent = this.entitlements;
    if (!canUseWorkspace(ent, this.activePersonaId)) {
      this.activePersonaId = ent.workspaces[0] || DEFAULT_PERSONA_ID;
      storage.set("kredibble_persona", this.activePersonaId);
      if (this.threads.length || this.activeThreadId) {
        this.setDocument(null);
        this.openLatestThread();
        this.renderThreads();
        this.renderMessages();
      }
    }
    if (!canUseModel(ent, this.modelKey)) {
      this.modelKey = DEFAULT_MODEL_KEY;
      storage.set("kredibble_model", this.modelKey);
      if (this.llm.loadedModelId) this.loadModel();
    }
    const maxDocs = ent.max_documents;
    if (this.docs.length && ((maxDocs != null && this.docs.length > maxDocs) || this.docs.some((d) => !this.documentAllowed(d, { quiet: true })))) {
      this.setDocument(null);
    }
    $("file-upload-input").multiple = maxDocs == null || maxDocs > 1;
    this.updatePersonaUI();
    this.populateModelSelect();
    this.updateVaultDiagnostics();
    this.renderThreads();
    this.renderTierModal();
    this.updateUsageMeter();
    if (this.messagesLeft() !== 0) $("limit-banner").hidden = true;
    const tier = $("top-tier-badge");
    tier.textContent = PLAN_LABELS[ent.plan] || "";
    tier.closest(".tier-pill").hidden = ent.plan === "unlimited";
  }

  /** Messages left today, or null without a daily limit. */
  messagesLeft() {
    const limit = this.entitlements.daily_messages;
    return limit == null ? null : Math.max(0, limit - this.messagesUsed);
  }

  updateUsageMeter() {
    const left = this.messagesLeft();
    const meter = $("usage-meter");
    meter.hidden = left == null;
    if (left == null) return;
    meter.textContent = `${left} of ${this.entitlements.daily_messages} messages left today`;
    meter.classList.toggle("warn-text", left <= 3);
  }

  /** Takes one of today's messages before a question goes to the model. */
  async takeMessage() {
    const limit = this.entitlements.daily_messages;
    if (limit == null) return true;
    if (this.isGuest) {
      if (GuestCounter.used() >= limit) return this.showLimit();
      this.messagesUsed = GuestCounter.take();
    } else {
      try {
        this.messagesUsed = (await AccountAPI.useMessage(timeZone())).used;
      } catch (err) {
        if (err.status === 429) {
          this.messagesUsed = err.detail?.used ?? limit;
          this.updateUsageMeter();
          return this.showLimit();
        }
        if (err.status === 401) await this.loadAccount(); // signed out elsewhere: guest limits apply next time
        // Server unreachable: the AI runs locally, so let this message through.
      }
    }
    this.updateUsageMeter();
    return true;
  }

  showLimit() {
    const ent = this.entitlements;
    const text = {
      guest: `You've used today's ${ent.daily_messages} free messages. Create a free account for 30 a day, or come back tomorrow.`,
      free: `You've used all ${ent.daily_messages} messages for today. They reset at midnight, or upgrade to Pro for 300 a day.`,
    }[ent.plan] || `You've used all ${ent.daily_messages} messages for today. They reset at midnight, or move to Business for no daily limit.`;
    $("limit-banner-text").textContent = text;
    $("limit-banner-primary").textContent = this.isGuest ? "Create free account" : "See plans";
    $("limit-banner-secondary").hidden = !this.isGuest;
    $("limit-banner").hidden = false;
    return false;
  }

  /** Explains why something is locked and opens the next step: sign-up for guests, plans otherwise. */
  promptUpgrade(message) {
    this.toast(message);
    if (this.isGuest) this.openAuth("register");
    else this.showTierModal(true);
  }

  limitAction() {
    $("limit-banner").hidden = true;
    if (this.isGuest) this.openAuth("register");
    else this.showTierModal(true);
  }

  /** Free plans read short documents only. Returns false (and explains) when over the limit. */
  documentAllowed(doc, { quiet = false } = {}) {
    const max = this.entitlements.max_document_pages;
    if (max == null || doc.pageCount <= max) return true;
    if (!quiet) this.promptUpgrade(`This document has ${doc.pageCount} pages. Your plan reads up to ${max}; Pro has no page limit.`);
    return false;
  }

  async saveThread(thread) {
    if (this.entitlements.save_history) await ThreadStore.save(thread);
  }

  setAccount(account) {
    this.account = account;
    $("account-box").hidden = !this.accountsEnabled;
    $("settings-account").hidden = !this.accountsEnabled;
    $("account-signed-out").hidden = !!account;
    $("account-signed-in").hidden = !account;
    if (account) {
      const name = account.display_name || account.email.split("@")[0];
      $("account-avatar").textContent = name.charAt(0).toUpperCase();
      $("account-name").textContent = name;
      $("account-sub").textContent = account.email_verified ? `${PLAN_LABELS[account.plan] || account.plan} plan` : "Confirm your email";
      $("account-sub").classList.toggle("warn-text", !account.email_verified);
    }
    this.renderAccountSettings();
  }

  /** Links from account emails: /?verify=TOKEN and /?reset=TOKEN. Removed from the address bar at once. */
  async handleAccountLinks() {
    const params = new URLSearchParams(location.search);
    const verify = params.get("verify");
    const reset = params.get("reset");
    const checkout = params.get("checkout");
    if (!verify && !reset && !checkout) return;
    history.replaceState(null, "", location.pathname);
    if (!this.accountsEnabled) return;
    if (checkout) {
      await this.finishCheckout(checkout, params.get("session_id"));
      return;
    }
    if (reset) {
      this.resetToken = reset;
      this.openAuth("reset");
      return;
    }
    try {
      await AccountAPI.verifyEmail(verify);
      this.toast("Email confirmed. Thank you!");
      await this.loadAccount();
    } catch (err) {
      this.toast(err.message);
    }
  }

  openAuth(view = "signin") {
    this.authView = view;
    this.showDiagnostics(false);
    this.closeMobileSidebar();
    this.renderAuth();
    $("auth-modal").hidden = false;
    $("auth-fields").querySelector("input")?.focus();
  }

  closeAuth() {
    $("auth-modal").hidden = true;
    this.resetToken = null;
  }

  renderAuth() {
    const view = this.authView;
    const field = (id, label, type, autocomplete, extra = "") =>
      `<label class="field"><span class="field-label">${label}</span><input class="input" id="${id}" type="${type}" autocomplete="${autocomplete}" ${extra}></label>`;
    const passwordHint = `<span class="field-hint">At least 10 characters. A short phrase is easy to remember.</span>`;
    const typeOptions = PERSONAS.map((p) =>
      `<option value="${p.userType}"${p.id === this.activePersonaId ? " selected" : ""}>${escapeHtml(p.audience)} · ${escapeHtml(p.shortName)}</option>`).join("");
    const link = (to, text) => `<button type="button" class="link-btn" data-action="open-auth" data-view="${to}">${text}</button>`;

    const views = {
      signin: {
        title: "Welcome back",
        subtitle: "Sign in to your Kredibble account.",
        fields: field("auth-email", "Email", "email", "email", "required") +
          field("auth-password", "Password", "password", "current-password", "required") +
          `<div class="field-aside">${link("forgot", "Forgot password?")}</div>`,
        submit: "Sign in",
        switch: `New to Kredibble? ${link("register", "Create a free account")}`,
      },
      register: {
        title: "Create your account",
        subtitle: "Free, and the AI still runs privately on this device.",
        fields: field("auth-name", "Name <span class=\"field-optional\">(optional)</span>", "text", "name", 'maxlength="80"') +
          field("auth-email", "Email", "email", "email", "required") +
          field("auth-password", "Password", "password", "new-password", 'required minlength="10"') + passwordHint +
          `<label class="field"><span class="field-label">Kredibble is mainly for</span><select class="input select" id="auth-type">${typeOptions}</select></label>`,
        submit: "Create account",
        switch: `Already have an account? ${link("signin", "Sign in")}`,
      },
      forgot: {
        title: "Reset your password",
        subtitle: "Enter your email and we'll send you a link to choose a new password.",
        fields: field("auth-email", "Email", "email", "email", "required"),
        submit: "Send reset link",
        switch: link("signin", "Back to sign in"),
      },
      reset: {
        title: "Choose a new password",
        subtitle: "You'll be signed in, and signed out everywhere else.",
        fields: field("auth-password", "New password", "password", "new-password", 'required minlength="10"') + passwordHint,
        submit: "Save password",
        switch: "",
      },
      sent: {
        title: "Check your email",
        subtitle: "If an account exists for that address, a reset link is on its way. It works for 1 hour.",
        fields: "",
        submit: "Back to sign in",
        switch: "",
      },
    };
    const v = views[view];
    $("auth-title").textContent = v.title;
    $("auth-subtitle").textContent = v.subtitle;
    $("auth-fields").innerHTML = v.fields;
    $("auth-submit").textContent = v.submit;
    $("auth-switch").innerHTML = v.switch;
    $("auth-switch").hidden = !v.switch;
    $("auth-error").hidden = true;
  }

  async submitAuth() {
    const view = this.authView;
    if (view === "sent") return this.openAuth("signin");
    const value = (id) => $(id)?.value.trim() ?? "";
    const button = $("auth-submit");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Please wait…";
    $("auth-error").hidden = true;
    try {
      if (view === "signin") {
        await AccountAPI.login(value("auth-email"), $("auth-password").value);
        await this.loadAccount();
        this.closeAuth();
        this.toast("Signed in.");
      } else if (view === "register") {
        const account = await AccountAPI.register({
          email: value("auth-email"),
          password: $("auth-password").value,
          display_name: value("auth-name") || null,
          user_type: $("auth-type").value,
        });
        await this.loadAccount();
        this.closeAuth();
        this.selectPersona(personaForUserType(account.user_type).id);
        this.toast("Account created. Check your email to confirm your address.");
      } else if (view === "forgot") {
        await AccountAPI.forgotPassword(value("auth-email"));
        this.openAuth("sent");
      } else if (view === "reset") {
        await AccountAPI.resetPassword(this.resetToken, $("auth-password").value);
        await this.loadAccount();
        this.closeAuth();
        this.toast("Password changed. You're signed in.");
      }
    } catch (err) {
      $("auth-error").textContent = err.message;
      $("auth-error").hidden = false;
    } finally {
      button.disabled = false;
      if (this.authView === view) button.textContent = label;
    }
  }

  renderAccountSettings() {
    const body = $("settings-account-body");
    const account = this.account;
    if (!account) {
      body.innerHTML = `
        <p class="settings-note">You're using Kredibble without an account. Create a free one to keep your plan and preferences.</p>
        <div class="settings-actions">
          <button class="btn btn-primary" data-action="open-auth" data-view="signin">Sign in</button>
          <button class="btn" data-action="open-auth" data-view="register">Create account</button>
        </div>`;
      return;
    }
    const typeOptions = PERSONAS.map((p) =>
      `<option value="${p.userType}"${p.userType === account.user_type ? " selected" : ""}>${escapeHtml(p.audience)} · ${escapeHtml(p.shortName)}</option>`).join("");
    body.innerHTML = `
      <div class="setting-row">
        <span class="setting-label">Email</span>
        <span class="setting-value">${escapeHtml(account.email)}${account.email_verified ? "" : ` <span class="tag warn">Not confirmed</span>`}</span>
      </div>
      ${account.email_verified ? "" : `<p class="settings-note">Check your inbox for the confirmation link. <button class="link-btn" data-action="resend-verification">Send it again</button></p>`}
      <div class="setting-row"><span class="setting-label">Plan</span><span class="setting-value">${escapeHtml(PLAN_LABELS[account.plan] || account.plan)}${this.billingSummary(account)}</span></div>
      ${account.subscription_status === "past_due" ? '<p class="settings-note warn-text">Your last payment failed. Update your card in Manage billing to keep your plan.</p>' : ""}
      <div class="setting-row">
        <label class="setting-label" for="acct-name">Name</label>
        <input class="input input-sm" id="acct-name" maxlength="80" autocomplete="name" value="${escapeHtml(account.display_name || "")}" placeholder="Optional">
      </div>
      <div class="setting-row">
        <label class="setting-label" for="acct-type">Mainly for</label>
        <select class="select" id="acct-type">${typeOptions}</select>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" data-action="save-account">Save changes</button>
        ${account.has_billing ? '<button class="btn" data-action="manage-billing">Manage billing</button>' : '<button class="btn" data-action="open-tier-modal">See plans</button>'}
        <button class="btn" data-action="sign-out">Sign out</button>
        <button class="btn btn-link-danger" data-action="delete-account">Delete account</button>
      </div>`;
  }

  /** " · monthly, renews 5 Nov 2026" / " · ends 5 Nov 2026" for a paid plan. */
  billingSummary(account) {
    if (!account.subscription_renews_at || !this.hasLiveSubscription) return "";
    const date = new Date(account.subscription_renews_at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    const period = account.subscription_interval === "year" ? "yearly" : "monthly";
    return account.subscription_cancel_at_period_end ? ` · ends ${date}` : ` · ${period}, renews ${date}`;
  }

  async saveAccount() {
    try {
      await AccountAPI.update({ display_name: $("acct-name").value.trim() || null, user_type: $("acct-type").value });
      await this.loadAccount(); // on the free plan the user type decides the second workspace
      this.toast("Account updated.");
    } catch (err) {
      this.toast(err.message);
    }
  }

  async resendVerification() {
    try {
      await AccountAPI.resendVerification();
      this.toast("Confirmation email sent.");
    } catch (err) {
      this.toast(err.message);
    }
  }

  async signOut() {
    try {
      await AccountAPI.logout();
    } catch {
      // Signed out locally either way; the server session expires on its own.
    }
    await this.loadAccount();
    this.toast("Signed out. Your chats stay on this device.");
  }

  async deleteAccount() {
    const password = prompt("This permanently deletes your Kredibble account. Chats on this device are not affected.\n\nEnter your password to confirm:");
    if (!password) return;
    try {
      await AccountAPI.deleteAccount(password);
      await this.loadAccount();
      this.toast("Account deleted.");
    } catch (err) {
      this.toast(err.message);
    }
  }
}


const app = new KredibbleApp();
app.init().catch((err) => {
  console.error("Startup failed:", err);
  app.setEngineState("error", `Startup failed: ${errorText(err)}`);
});

// Support/diagnostics hook: open the app with ?debug to inspect retrieval in the console.
// Everything it exposes already lives in this browser tab.
if (new URLSearchParams(location.search).has("debug")) {
  window.kredibble = { app, DocumentIndex, Embedder, shouldAbstain };
}
