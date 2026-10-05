import { describe, expect, it } from "vitest";
import { chunkPages, detectHeading, MAX_CHARS } from "../src/rag/chunker.js";
import { BM25Index } from "../src/rag/bm25.js";
import { tokenize } from "../src/rag/text.js";
import { DocumentIndex, isSummaryRequest, retrievalQuery, shouldAbstain, normalize } from "../src/rag/retriever.js";
import { extractCitations, verifyAnswer, groundAnswer, attributeSentences, isAbstention, stripCitations, NOT_FOUND_TEXT } from "../src/rag/verify.js";
import { planTurn, assembleMessages } from "../src/core/prompt.js";

const filler = (n) => Array.from({ length: n }, (_, i) => `The parties shall cooperate in good faith on routine matter ${i}.`).join(" ");

const contract = {
  filename: "msa.pdf",
  pages: [
    { page: 1, text: `MASTER SERVICES AGREEMENT\n\n1. Definitions\n${filler(12)}` },
    { page: 2, text: `2. Term\nThis Agreement lasts three (3) years from the Effective Date.\n\n${filler(10)}` },
    { page: 3, text: `${filler(14)}` },
    { page: 4, text: `12. Limitation of Liability\nEach party's total aggregate liability is capped at £2,500,000 in any contract year.\n\n${filler(6)}` },
    { page: 5, text: `14. Governing Law\nThis Agreement is governed by the laws of England and Wales.\n\n15. Termination\nEither party may terminate on ninety (90) days written notice.` },
  ],
};

describe("text", () => {
  it("tokenizes with stopwords removed and light stemming", () => {
    expect(tokenize("What are the termination rights?")).toEqual(["termin", "right"]);
    expect(tokenize("Liabilities capped at £2,500,000")).toEqual(["liability", "cap", "2", "500", "000"]);
  });

  it("stems doubled consonants so inflections meet their base form", () => {
    expect(tokenize("cap capped capping")).toEqual(["cap", "cap", "cap"]);
    expect(tokenize("billing bills billed")).toEqual(["bill", "bill", "bill"]);
  });
});

describe("chunker", () => {
  it("detects common heading styles", () => {
    expect(detectHeading("12. Limitation of Liability")).toBe("12. Limitation of Liability");
    expect(detectHeading("Section 4 Payment Terms")).toBe("Section 4 Payment Terms");
    expect(detectHeading("MASTER SERVICES AGREEMENT")).toBe("MASTER SERVICES AGREEMENT");
    expect(detectHeading("The parties shall cooperate in good faith.")).toBeNull();
  });

  it("never crosses pages, respects size limits and tracks sections", () => {
    const chunks = chunkPages(contract.pages);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS + 300);
      const page = contract.pages.find((p) => p.page === c.page);
      expect(page.text.replace(/\s+/g, " ")).toContain(c.text.slice(0, 40));
    }
    const liability = chunks.find((c) => c.text.includes("£2,500,000"));
    expect(liability.page).toBe(4);
    expect(liability.section).toBe("12. Limitation of Liability");
    // Section carries across a page boundary until a new heading appears.
    expect(chunks.find((c) => c.page === 3).section).toBe("2. Term");
  });

  it("hard-wraps a single enormous line", () => {
    const chunks = chunkPages([{ page: 1, text: "x".repeat(5000) }]);
    expect(chunks.every((c) => c.text.length <= MAX_CHARS)).toBe(true);
  });
});

describe("bm25", () => {
  it("weights coverage by term rarity", () => {
    const idx = new BM25Index(["in good faith", "good industry practice", "good conduct", "liability cap"]);
    expect(idx.search("recommend a good pasta recipe").weightedCoverage).toBeLessThan(0.2);
    expect(idx.search("liability cap").weightedCoverage).toBe(1);
  });

  it("ranks the chunk containing rare query terms first", () => {
    const idx = new BM25Index(["the cat sat on the mat", "liability is capped at two million", "the dog sat on the log"]);
    const { hits, matchedTerms, queryTerms } = idx.search("what is the liability cap?");
    expect(hits[0].index).toBe(1);
    expect(matchedTerms).toBe(2); // "cap" now matches "capped"
    expect(queryTerms).toBe(2);
  });
});

describe("retriever", () => {
  const index = new DocumentIndex(contract);

  it("finds a fact deep in the document by keyword", () => {
    const r = index.retrieve("What is the liability cap?");
    const sources = index.select(r.ranked, 1200);
    expect(sources.some((s) => s.text.includes("£2,500,000") && s.page === 4)).toBe(true);
    expect(shouldAbstain(r)).toBe(false);
  });

  it("guarantees each ranker's top hit a slot even when fusion would bury it", () => {
    const long = new DocumentIndex({ filename: "l.pdf", pages: [...contract.pages, ...Array.from({ length: 10 }, (_, i) => ({ page: 6 + i, text: filler(14) }))] });
    const target = long.chunks.findIndex((c) => c.text.includes("England and Wales"));
    // Semantic ranker strongly prefers some other chunk; keyword ranker finds the target.
    long.setVectors(long.chunks.map((_, i) => (i === 0 ? [1, 0] : [0.1, 1])));
    const r = long.retrieve("governing law", [1, 0]);
    const top = long.select(r.ranked, 2400).map((s) => s.index);
    expect(top).toContain(target);
    expect(top).toContain(0);
  });

  it("labels sources S1..Sn by relevance and respects the budget", () => {
    const r = index.retrieve("governing law termination notice");
    const sources = index.select(r.ranked, 400);
    expect(sources.map((s) => s.id)).toEqual(sources.map((_, i) => `S${i + 1}`));
    expect(sources[0].index).toBe(r.ranked.find((x) => sources.some((s) => s.index === x.index)).index);
    expect(sources[0].text).toMatch(/England and Wales|ninety/);
    expect(sources.reduce((n, s) => n + Math.ceil(s.text.length / 3) + 16, 0)).toBeLessThanOrEqual(400);
  });

  it("abstains on keyword-only search when no query term exists in a long document", () => {
    const long = new DocumentIndex({ filename: "l.pdf", pages: [...contract.pages, ...Array.from({ length: 10 }, (_, i) => ({ page: 6 + i, text: filler(14) }))] });
    expect(shouldAbstain(long.retrieve("What's the weather in Tokyo?"))).toBe(true);
    expect(shouldAbstain(long.retrieve("What is the liability cap?"))).toBe(false);
    expect(shouldAbstain(long.retrieve("what does this mean?"))).toBe(false); // nothing searchable: don't judge
  });

  it("uses semantic search to rescue paraphrases and never gates when it is available", () => {
    const longContract = { filename: "long.pdf", pages: [...contract.pages, ...Array.from({ length: 10 }, (_, i) => ({ page: 6 + i, text: filler(14) }))] };
    const withVectors = new DocumentIndex(longContract);
    expect(withVectors.chunks.length).toBeGreaterThanOrEqual(12);
    const dims = 4;
    // Fake embeddings: chunk containing the cap points along axis 0, everything else along axis 1.
    withVectors.setVectors(withVectors.chunks.map((c) => (c.text.includes("£2,500,000") ? [1, 0, 0, 0] : [0, 1, 0, 0])));
    const paraphrase = withVectors.retrieve("How much could we owe at most if things go wrong?", [0.9, 0.1, 0, 0].slice(0, dims));
    expect(paraphrase.semanticUsed).toBe(true);
    expect(paraphrase.semanticZ).toBeGreaterThan(3);
    expect(withVectors.chunks[paraphrase.ranked[0].index].text).toContain("£2,500,000");
    expect(shouldAbstain(paraphrase)).toBe(false);

    // Unrelated questions go to the model, which answers "not found" from the sources.
    const unrelated = withVectors.retrieve("Recommend a pasta recipe", [0, 0, 1, 0]);
    expect(shouldAbstain(unrelated)).toBe(false);
  });

  it("does not gate short documents, where z-scores are meaningless", () => {
    const short = new DocumentIndex(contract);
    expect(short.chunks.length).toBeLessThan(12);
    short.setVectors(short.chunks.map(() => [0, 1, 0, 0]));
    // Paraphrase with no keyword overlap must still reach the model.
    expect(shouldAbstain(short.retrieve("How much could we owe at most if things go wrong?", [0, 1, 0, 0]))).toBe(false);
    expect(shouldAbstain(short.retrieve("pasta recipe"))).toBe(false);
  });

  it("spreads summary sources across the document", () => {
    const sources = index.selectSpread(2000);
    const pages = new Set(sources.map((s) => s.page));
    expect(pages.has(1)).toBe(true);
    expect(pages.has(5)).toBe(true);
  });

  it("only adds the previous question to the search for follow-ups", () => {
    const prev = "How quickly must a data breach be reported?";
    expect(retrievalQuery("What is the uptime commitment?", prev)).toBe("What is the uptime commitment?");
    expect(retrievalQuery("And what about termination?", prev)).toContain(prev);
    expect(retrievalQuery("Why is it so short?", prev)).toContain(prev);
    expect(retrievalQuery("Explain more", prev)).toContain(prev);
    expect(retrievalQuery("What is the uptime commitment?", "")).toBe("What is the uptime commitment?");
  });

  it("detects summary requests", () => {
    expect(isSummaryRequest("Summarise this contract")).toBe(true);
    expect(isSummaryRequest("What are the key terms?")).toBe(true);
    expect(isSummaryRequest("What is the liability cap?")).toBe(false);
  });

  it("normalizes vectors", () => {
    const v = normalize([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
  });
});

describe("verifier", () => {
  const sources = [
    { id: "S1", text: "Either party may terminate on ninety (90) days written notice." },
    { id: "S2", text: "Each party's total aggregate liability is capped at £2,500,000 in any contract year." },
  ];

  it("parses single, grouped and imitated auto citations", () => {
    expect(extractCitations("Cap is £2.5m [S2]. Notice [S1, S2] and [S3;S4]")).toEqual(["S2", "S1", "S3", "S4"]);
    expect(extractCitations("Paris [~S6].")).toEqual(["S6"]);
  });

  it("strips citation markers for history", () => {
    expect(stripCitations("Cap is £2,500,000 [S1]. Notice is 90 days [~S2, S3].")).toBe("Cap is £2,500,000. Notice is 90 days.");
  });

  it("treats an imitated auto citation as the model's own claim", () => {
    const v = groundAnswer("The capital of France is Paris [~S2].", sources, "What is the capital of France?").verification;
    expect(v.citedIds).toEqual(["S2"]);
    expect(v.autoCited).toEqual([]);
  });

  it("passes a grounded answer", () => {
    const v = verifyAnswer("Liability is capped at £2,500,000 per contract year [S2]; termination needs 90 days' notice [S1].", sources, "q");
    expect(v.status).toBe("grounded");
    expect(v.citedIds).toEqual(["S2", "S1"]);
  });

  it("flags invented citations, figures and quotes", () => {
    const v = verifyAnswer('The cap is £5,000,000 [S2] [S7]. It says "liability is unlimited for all claims whatsoever".', sources, "q");
    const kinds = v.issues.map((i) => i.kind).sort();
    expect(v.status).toBe("warning");
    expect(kinds).toEqual(["invalid-citation", "unsupported-number", "unverified-quote"]);
  });

  it("does not treat citations, page refs or list numbers as figures", () => {
    const v = verifyAnswer("1. Notice is 90 days [S1] (p. 5).\n2. See clause 15.", sources, "q");
    expect(v.issues).toEqual([]);
  });

  it("accepts figures that come from the question", () => {
    const v = verifyAnswer("No — the notice period is 90 days, not 30 [S1].", sources, "Is the notice period 30 days?");
    expect(v.status).toBe("grounded");
  });

  it("recognises the model abstaining in its usual phrasings", () => {
    expect(verifyAnswer(NOT_FOUND_TEXT, sources).status).toBe("abstained");
    for (const text of ["I can't find that information in the document.", "I cannot find a pasta recipe here.", "The document does not mention insurance.", "The sources don't specify a date."]) {
      expect(isAbstention(text)).toBe(true);
    }
    expect(isAbstention("Notice is 90 days [S1]. I can't find anything about fees.")).toBe(false);
  });

  it("attributes uncited sentences to the best-matching source", () => {
    const { text, ids } = attributeSentences("The customer may terminate on ninety days written notice. Liability is capped at £2,500,000 per contract year. Thanks for asking!", sources);
    expect(ids.sort()).toEqual(["S1", "S2"]);
    expect(text).toContain("notice [~S1].");
    expect(text).toContain("year [~S2].");
    expect(text).toContain("Thanks for asking!");
  });

  it("keeps decimals and trailing citations inside their sentence", () => {
    const avail = [{ id: "S1", text: "The Supplier shall achieve system availability of not less than 99.5% in each calendar month." }];
    const { text } = attributeSentences("The Supplier must achieve availability of not less than 99.5% each calendar month.", avail);
    expect(text).toBe("The Supplier must achieve availability of not less than 99.5% each calendar month [~S1].");
    const cited = groundAnswer("Liability is capped at £2,500,000 per contract year. [S2]", sources, "q");
    expect(cited.content).toBe("Liability is capped at £2,500,000 per contract year. [S2]");
    expect(cited.verification.status).toBe("grounded");
  });

  it("flags sentences no source supports, even when others are cited", () => {
    const g = groundAnswer("Liability is capped at £2,500,000 per contract year [S2]. The capital of France is Paris, a lovely city.", sources, "summarise");
    expect(g.verification.status).toBe("warning");
    expect(g.verification.issues).toEqual([{ kind: "unsupported-sentence", detail: 1, sentences: ["The capital of France is Paris, a lovely city."] }]);
  });

  it("groundAnswer upgrades an uncited but faithful answer and keeps real warnings", () => {
    const ok = groundAnswer("Liability is capped at £2,500,000 per contract year.", sources, "q");
    expect(ok.verification.status).toBe("grounded");
    expect(ok.verification.autoCited).toEqual(["S2"]);
    expect(ok.content).toContain("[~S2]");

    const bad = groundAnswer("Liability is capped at £9,000,000 per contract year.", sources, "q");
    expect(bad.verification.status).toBe("warning");
    expect(bad.verification.issues.map((i) => i.kind)).toEqual(["unsupported-number"]);

    const cited = groundAnswer("Notice is 90 days [S1].", sources, "q");
    expect(cited.content).toBe("Notice is 90 days [S1].");
    expect(cited.verification.autoCited).toEqual([]);
  });

  it("flags answers without any citation", () => {
    expect(verifyAnswer("Notice is 90 days.", sources).issues.map((i) => i.kind)).toEqual(["no-citation"]);
  });
});

describe("prompt planning", () => {
  it("keeps the newest turns, skips abstained/error turns and leaves a source budget", () => {
    const history = [
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "y".repeat(300) })),
      { role: "assistant", content: "nothing found", abstained: true },
      { role: "user", content: "latest question" },
    ];
    const plan = planTurn({ history, withDocument: true, contextWindow: 4096 });
    expect(plan.current.content).toBe("latest question");
    expect(plan.keptTurns.some((t) => t.content === "nothing found")).toBe(false);
    expect(plan.keptTurns).toHaveLength(2); // document Q&A keeps only the last exchange
    const cited = planTurn({ history: [{ role: "user", content: "q1" }, { role: "assistant", content: "Cap is 5 [~S1]." }, { role: "user", content: "q2" }], withDocument: true, contextWindow: 4096 });
    expect(cited.keptTurns[1].content).toBe("Cap is 5.");
    const summary = planTurn({ history, withDocument: true, contextWindow: 4096, docMode: "summary" });
    expect(summary.keptTurns).toHaveLength(0);
    const chat = planTurn({ history, withDocument: false, contextWindow: 4096 });
    expect(chat.keptTurns.length).toBeGreaterThan(2);
    expect(plan.droppedTurns).toBeGreaterThan(0);
    expect(plan.sourceBudget).toBeGreaterThan(1500);

    const messages = assembleMessages(plan, { filename: "x.pdf", sources: [{ id: "S1", page: 4, section: "12. Liability", text: "cap" }] });
    expect(messages[0].content).toContain("[S1] (p. 4 · 12. Liability)\ncap");
    const total = messages.reduce((n, m) => n + Math.ceil(m.content.length / 3), 0);
    expect(total).toBeLessThanOrEqual(4096 - 768);
  });

  it("rejects a message that cannot fit", () => {
    expect(() => planTurn({ history: [{ role: "user", content: "z".repeat(20000) }], withDocument: false, contextWindow: 4096 })).toThrow(/too long/);
  });
});

describe("relevance check", async () => {
  const { relevanceIssue, MIN_RELEVANCE_RATIO } = await import("../src/rag/verify.js");
  it("flags answers less related to the question than the best passage", () => {
    expect(MIN_RELEVANCE_RATIO).toBe(0.95);
    expect(relevanceIssue(0.78, 0.622)).toBeNull(); // calibration: good answer, ratio 1.25
    expect(relevanceIssue(0.487, 0.505)).toBeNull(); // lowest good answer, ratio 0.965
    expect(relevanceIssue(0.568, 0.607)).toEqual({ kind: "off-topic", detail: 0.94 }); // highest off-topic, 0.936
    expect(relevanceIssue(0.5, 0)).toBeNull();
  });
});
