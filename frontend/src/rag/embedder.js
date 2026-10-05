// On-device embeddings via a dedicated WebLLM worker, kept separate from the chat
// engine so switching chat models never discards a document's semantic index.
import { CreateWebWorkerMLCEngine, hasModelInCache } from "@mlc-ai/web-llm";

import { EMBEDDING_MODEL_ID } from "./model-ids.js";

export { EMBEDDING_MODEL_ID };
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const BATCH = 8;

export class Embedder {
  constructor(modelId = EMBEDDING_MODEL_ID) {
    this.modelId = modelId;
    this.appConfig = undefined; // set to a self-hosted appConfig by the app when available
    this.engine = null;
    this.loading = null;
  }

  isCached() {
    return hasModelInCache(this.modelId, this.appConfig).catch(() => false);
  }

  load(onProgress) {
    if (this.engine) return Promise.resolve();
    if (!this.loading) {
      const worker = new Worker(new URL("../engine/llm.worker.js", import.meta.url), { type: "module" });
      this.loading = CreateWebWorkerMLCEngine(worker, this.modelId, {
        initProgressCallback: (report) => onProgress?.(report),
        ...(this.appConfig ? { appConfig: this.appConfig } : {}),
      })
        .then((engine) => { this.engine = engine; })
        .catch((err) => { this.loading = null; worker.terminate(); throw err; });
    }
    return this.loading;
  }

  async embedPassages(texts, onProgress) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const result = await this.engine.embeddings.create({ input: texts.slice(i, i + BATCH) });
      for (const item of result.data) vectors.push(item.embedding);
      onProgress?.(Math.min(1, (i + BATCH) / texts.length));
    }
    return vectors;
  }

  async embedQuery(text) {
    const result = await this.engine.embeddings.create({ input: [QUERY_PREFIX + text] });
    return result.data[0].embedding;
  }
}
