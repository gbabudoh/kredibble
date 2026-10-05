// Thin wrapper over WebLLM: GPU probing, model selection, loading and streaming.
import {
  CreateWebWorkerMLCEngine,
  prebuiltAppConfig,
  hasModelInCache,
  deleteModelAllInfoInCache,
} from "@mlc-ai/web-llm";
import { MODELS, DEFAULT_MODEL_KEY } from "./models.js";

const FALLBACK_CONTEXT_WINDOW = 4096;

// Errors WebLLM raises once the WebGPU device has been lost or the model was released.
// Multi-step tasks must stop on these instead of recording them per step.
const ENGINE_LOST_RE = /already been disposed|ModelNotLoaded|not loaded before|device (?:was |is )?lost|out of memory|GPUDevice/i;
export const isEngineLost = (err) => ENGINE_LOST_RE.test(err?.message || String(err ?? ""));

export class LocalLLM {
  constructor() {
    this.engine = null;
    this.loadedModelId = null;
    this.gpu = { supported: false, f16: false, description: "Not detected" };
    this.lastUsage = null;
  }

  async probeGPU() {
    if (!navigator.gpu) {
      this.gpu = { supported: false, f16: false, description: "WebGPU not available in this browser" };
      return this.gpu;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        this.gpu = { supported: false, f16: false, description: "No compatible GPU adapter" };
        return this.gpu;
      }
      const info = adapter.info || {};
      const description = [info.vendor, info.architecture, info.description].filter(Boolean).join(" · ") || "WebGPU adapter";
      this.gpu = { supported: true, f16: adapter.features.has("shader-f16"), description };
    } catch (err) {
      this.gpu = { supported: false, f16: false, description: `WebGPU error: ${err.message}` };
    }
    return this.gpu;
  }

  static modelByKey(key) {
    return MODELS.find((m) => m.key === key) || MODELS.find((m) => m.key === DEFAULT_MODEL_KEY);
  }

  resolveModelId(key) {
    const model = LocalLLM.modelByKey(key);
    return this.gpu.f16 ? model.f16 : model.f32;
  }

  static modelRecord(modelId) {
    return prebuiltAppConfig.model_list.find((m) => m.model_id === modelId) || null;
  }

  static contextWindow(modelId) {
    return LocalLLM.modelRecord(modelId)?.overrides?.context_window_size ?? FALLBACK_CONTEXT_WINDOW;
  }

  isCached(modelId) {
    return hasModelInCache(modelId).catch(() => false);
  }

  async load(modelId, onProgress) {
    if (!this.gpu.supported) throw new Error(this.gpu.description);
    const initProgressCallback = (report) => onProgress?.(report);

    if (this.engine) {
      this.engine.setInitProgressCallback(initProgressCallback);
      await this.engine.reload(modelId);
    } else {
      this.worker = new Worker(new URL("./llm.worker.js", import.meta.url), { type: "module" });
      this.engine = await CreateWebWorkerMLCEngine(this.worker, modelId, { initProgressCallback });
    }
    this.loadedModelId = modelId;
  }

  async removeFromCache(modelId) {
    if (this.loadedModelId === modelId && this.engine) {
      await this.engine.unload();
      this.loadedModelId = null;
    }
    await deleteModelAllInfoInCache(modelId);
  }

  /** Streams completion text deltas. Usage stats land in `this.lastUsage`. */
  async *stream(messages, { temperature = 0.3, maxTokens = 768 } = {}) {
    if (!this.engine || !this.loadedModelId) throw new Error("No model loaded.");
    const chunks = await this.engine.chat.completions.create({
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of chunks) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
      if (chunk.usage) this.lastUsage = chunk.usage;
    }
  }

  /**
   * Generates JSON constrained to `schema` (grammar-guided decoding), then parses it.
   * Streams internally so interrupt() works and callers can show progress.
   */
  async generateJSON(messages, schema, { maxTokens = 700, onProgress } = {}) {
    if (!this.engine || !this.loadedModelId) throw new Error("No model loaded.");
    const chunks = await this.engine.chat.completions.create({
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: "json_object", schema: JSON.stringify(schema) },
    });
    let text = "";
    let finish = null;
    for await (const chunk of chunks) {
      text += chunk.choices?.[0]?.delta?.content ?? "";
      finish = chunk.choices?.[0]?.finish_reason ?? finish;
      if (chunk.usage) this.lastUsage = chunk.usage;
      onProgress?.(text);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(finish === "length" ? "The structured answer was cut off (output limit reached)." : "The model returned invalid JSON.");
    }
  }

  /** Drops a broken engine (e.g. after GPU device loss) so the next load starts a fresh worker. */
  discard() {
    this.worker?.terminate();
    this.worker = null;
    this.engine = null;
    this.loadedModelId = null;
  }

  interrupt() {
    this.engine?.interruptGenerate();
  }
}
