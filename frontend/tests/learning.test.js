import { describe, expect, it } from "vitest";
import { buildRecord, documentFingerprint, selectExamples, toEvalCandidates, REASONS } from "../src/learning/feedback.js";
import { buildEvent } from "../src/learning/metrics.js";
import registry from "../src/registry/registry.json";

const message = {
  role: "assistant",
  content: "The liability cap is £2,500,000 [S1].",
  meta: {
    model: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", tokensPerSec: 7.42, doc: "msa.pdf",
    route: { intent: "qa", confidence: 0.86 },
    verification: { status: "warning", issues: [{ kind: "no-citation" }, { kind: "off-topic", detail: 0.8 }, { kind: "no-citation" }] },
  },
};

describe("feedback records", () => {
  it("keeps reasons and corrections only for thumbs-down, and only known reason codes", () => {
    const up = buildRecord({ threadId: "t1", messageIndex: 1, question: "What is the cap?", message, rating: "up", reasons: ["wrong"], correction: "x", registryVersion: "v" });
    expect(up).toMatchObject({ id: "t1:1", rating: "up", reasons: [], correction: "", intent: "qa", doc: "msa.pdf" });
    const down = buildRecord({ threadId: "t1", messageIndex: 1, question: "q", message, rating: "down", reasons: ["wrong", "bogus"], correction: "  £2.5m per year  ", registryVersion: "v" });
    expect(down).toMatchObject({ reasons: ["wrong"], correction: "£2.5m per year" });
    expect(REASONS.map((r) => r.code)).toEqual(["wrong", "not-in-document", "citation", "incomplete", "off-topic", "other"]);
  });

  it("fingerprints documents without storing them", async () => {
    const a = await documentFingerprint([{ page: 1, text: "hello" }]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await documentFingerprint([{ page: 1, text: "hello" }])).toBe(a);
    expect(await documentFingerprint([{ page: 1, text: "hello!" }])).not.toBe(a);
  });
});

describe("example selection", () => {
  const records = [
    { intent: "qa", rating: "up", question: "What is the liability cap?", answer: "The cap is £2,500,000 [S1]." },
    { intent: "qa", rating: "down", correction: "Notice is ninety (90) days.", question: "How much notice is needed to terminate?", answer: "30 days" },
    { intent: "qa", rating: "down", correction: "", question: "What is the liability limit?", answer: "bad" },  // no correction: not approved
    { intent: "extract", rating: "up", question: "What is the liability cap amount?", answer: "table" },     // not Q&A
    { intent: "qa", rating: "up", question: "Recommend a pasta recipe", answer: "..." },
  ];

  it("picks approved, similar Q&A answers and strips their old citation labels", () => {
    expect(selectExamples("What's the cap on liability?", records)).toEqual([
      { question: "What is the liability cap?", answer: "The cap is £2,500,000." },
    ]);
    expect(selectExamples("How much notice to terminate the agreement?", records)[0].answer).toBe("Notice is ninety (90) days.");
    expect(selectExamples("Who owns the IP?", records)).toEqual([]);
  });

  it("respects the token budget", () => {
    const long = [{ intent: "qa", rating: "up", question: "What is the liability cap?", answer: "x".repeat(2000) }];
    expect(selectExamples("What is the liability cap?", long)).toEqual([]);
  });

  it("exports corrections as candidate eval items", () => {
    expect(toEvalCandidates([{ ...records[1], doc: "msa.pdf", reasons: ["wrong"] }])).toEqual([
      { doc: "msa.pdf", q: "How much notice is needed to terminate?", expect: ["Notice is ninety (90) days."], reasons: ["wrong"], rejected_answer: "30 days" },
    ]);
  });
});

describe("metric events", () => {
  it("carry only enums, ids and numbers — never the question or answer", () => {
    const event = buildEvent("feedback", message, { latencyMs: 15234.6, rating: "down", reasons: ["wrong"] });
    expect(event).toEqual({
      kind: "feedback", intent: "qa", status: "warning", issues: ["no-citation", "off-topic"],
      model: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", registry_version: registry.version, latency_ms: 15235,
      tokens_per_sec: 7.42, rating: "down", reasons: ["wrong"],
    });
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain("liability");
    expect(serialised).not.toContain("2,500,000");
  });
});
