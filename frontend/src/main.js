// Kredibble web client: on-device chat over WebLLM.
import "./styles.css";
import { LocalLLM } from "./engine/llm.js";
import { MODELS, DEFAULT_MODEL_KEY } from "./engine/models.js";
import { ThreadStore } from "./core/db.js";
import { renderMarkdown, escapeHtml } from "./core/render.js";
import { planTurn, assembleMessages, ANSWER_MAX_TOKENS } from "./core/prompt.js";
import { extractDocument } from "./services/documents.js";
import { DocumentIndex, chunkIndexText, normalize, retrievalQuery, shouldAbstain } from "./rag/retriever.js";
import { routeMessage } from "./intent/router.js";
import { runExtraction } from "./structured/extract.js";
import { runCompliance } from "./structured/compliance.js";
import { Embedder } from "./rag/embedder.js";
import { groundAnswer, describeIssue, relevanceIssue, stripCitations, NOT_FOUND_TEXT } from "./rag/verify.js";

const $ = (id) => document.getElementById(id);

// WebLLM worker errors can arrive as strings or plain objects rather than Error instances.
const errorText = (err) => err?.message || (typeof err === "string" ? err : String(err));

// Errors WebLLM raises once the WebGPU device has been lost or the model was released.
const GPU_LOST_RE = /already been disposed|ModelNotLoaded|not loaded before|device (?:was |is )?lost|out of memory|GPUDevice/i;

const storage = {
  get(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

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
    this.populateModelSelect();

    await this.loadThreads();

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
    try {
      if (route.intent === "extract" || route.intent === "compliance") {
        await this.runStructuredTask(route, text, reply);
        return;
      }

      const grounding = useDocument ? await this.retrieveSources(text, thread, plan.sourceBudget, route.intent === "summary") : null;

      if (grounding?.abstain) {
        // Nothing in the document relates to the question: answer without running the model.
        reply.content = `${NOT_FOUND_TEXT} Nothing in **${grounding.filename}** matched your question closely enough to answer it. ` +
          "Try the document's own wording, or remove the document to ask a general question.";
        reply.abstained = true;
        reply.meta = { doc: grounding.filename, retrieval: grounding.retrieval, sources: [], verification: { status: "abstained", issues: [], citedIds: [] } };
        return;
      }

      const messages = assembleMessages(plan, grounding && { filename: grounding.filename, sources: grounding.sources, mode: grounding.retrieval.mode });
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
      if (GPU_LOST_RE.test(errorText(err))) {
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
    $("stop-icon").style.display = on ? "" : "none";
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
                ${this.renderMeta(m.meta)}
              </div>
              ${this.renderGrounding(m.meta, i)}` : ""}
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
    for (const m of MODELS) {
      const option = document.createElement("option");
      option.value = m.key;
      option.textContent = m.label;
      select.append(option);
    }
    select.value = LocalLLM.modelByKey(this.modelKey).key;
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
    if (show) this.updateDiagnostics();
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
