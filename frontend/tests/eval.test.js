// CI evaluation suite: runs the real pipeline (minus the GPU-bound model and embeddings)
// against the fixture documents and the answer key in evals/gold.json. Thresholds are the
// measured baselines, so a change that makes retrieval, extraction or routing worse fails CI.
// The model-in-the-loop counterpart is evals/run-live.mjs.
import { describe, expect, it } from "vitest";
import gold from "../../evals/gold.json";
import msa from "../../evals/fixtures/msa.pages.json";
import dpa from "../../evals/fixtures/dpa.pages.json";
import { DocumentIndex } from "../src/rag/retriever.js";
import { routeMessage } from "../src/intent/router.js";
import { runExtraction } from "../src/structured/extract.js";

const docs = { msa: new DocumentIndex(msa), dpa: new DocumentIndex(dpa) };

// Baselines measured when this suite was written (keyword-only; semantic search needs WebGPU).
// Keyword misses are paraphrases ("end the deal early", "uptime") that semantic search recovers in the
// app; the routing miss is "Who painted the Mona Lisa?" -> qa, the safe direction.
const BASELINE = { keywordRecall: 9, routing: 7, extractionRecall: 9 };

describe("eval: retrieval (keyword only)", () => {
  const results = gold.qa.map(({ doc, q, gold: passage }) => {
    const index = docs[doc];
    const sources = index.select(index.retrieve(q).ranked, 2400);
    return { q, hit: sources.some((s) => s.text.includes(passage)) };
  });
  const hits = results.filter((r) => r.hit).length;

  it(`recall@6 does not regress (baseline ${BASELINE.keywordRecall}/${gold.qa.length})`, () => {
    expect(hits, `misses: ${results.filter((r) => !r.hit).map((r) => r.q).join(" | ")}`).toBeGreaterThanOrEqual(BASELINE.keywordRecall);
  });
});

describe("eval: routing", () => {
  const results = gold.routing.map(({ doc, q, intent }) => {
    const index = docs[doc];
    const route = routeMessage(q, { hasDocument: true, documentOverlap: index.bm25.search(q, 1).weightedCoverage });
    return { q, expected: intent, got: route.intent };
  });

  it(`routes the gold set (baseline ${BASELINE.routing}/${gold.routing.length})`, () => {
    const wrong = results.filter((r) => r.expected !== r.got);
    expect(results.length - wrong.length, JSON.stringify(wrong)).toBeGreaterThanOrEqual(BASELINE.routing);
  });

  it("never sends a document question to 'general'", () => {
    const leaks = results.filter((r) => r.got === "general" && r.expected !== "general");
    expect(leaks).toEqual([]);
  });
});

describe("eval: figure extraction", () => {
  for (const { doc, q, expect_values: expected } of gold.extraction) {
    it(`finds the expected figures for "${q}" (baseline ${BASELINE.extractionRecall}/${expected.length})`, async () => {
      const index = docs[doc];
      const llm = { async generateJSON() { throw new Error("figure extraction must not call the model"); } };
      const result = await runExtraction({ question: q, index, retrieval: index.retrieve(q), llm });
      const found = expected.filter((v) => result.content.includes(v));
      expect(found.length, `missing: ${expected.filter((v) => !found.includes(v)).join(", ")}`).toBeGreaterThanOrEqual(BASELINE.extractionRecall);
      expect(result.verification.issues).toEqual([]);
    });
  }
});
