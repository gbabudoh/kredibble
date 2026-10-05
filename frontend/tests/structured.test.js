import { describe, expect, it } from "vitest";
import registry from "../src/registry/registry.json";
import { DocumentIndex } from "../src/rag/retriever.js";
import { findCandidates } from "../src/structured/candidates.js";
import { buildBatches, contextSnippet, entityDensity, extractionPlan, figureRows, rankForExtraction, runExtraction, verifyItems } from "../src/structured/extract.js";
import { pickChecklist, runCompliance, verifyFinding } from "../src/structured/compliance.js";
import { withSourceEnum } from "../src/structured/schema.js";

const filler = (n) => Array.from({ length: n }, (_, i) => `The parties shall cooperate in good faith on routine matter number ${i}.`).join(" ");
const doc = {
  filename: "dpa.pdf",
  pages: [
    { page: 1, text: `DATA PROCESSING AGREEMENT\n\n1. Instructions\nThe Processor shall process Personal Data only on documented instructions from the Controller.\n\n${filler(8)}` },
    { page: 2, text: `2. Breach\nThe Processor shall notify the Controller of a Personal Data Breach within twenty-four (24) hours.\n\n${filler(8)}` },
    { page: 3, text: `3. Fees\nThe Customer shall pay £12,000 per year. Invoices are due within thirty (30) days.\n\n${filler(8)}` },
  ],
};

describe("candidate finder", () => {
  it("finds verbatim figures, preferring the longest overlapping span", () => {
    const found = findCandidates([
      { id: "S1", text: "Pay within forty-five (45) days. Interest at 4% above base. Cap of £2,500,000 per year." },
      { id: "S2", text: "Available 99.5% of the time. Effective 1 March 2026. Notice of 30 days." },
    ]);
    expect(found.map((c) => [c.id, c.value, c.source])).toEqual([
      ["C1", "forty-five (45) days", "S1"], ["C2", "4%", "S1"], ["C3", "£2,500,000", "S1"],
      ["C4", "99.5%", "S2"], ["C5", "1 March 2026", "S2"], ["C6", "30 days", "S2"],
    ]);
    expect(found[0].context).toBe("Pay within forty-five (45) days.");
  });

  it("drops repeats from overlapping chunks", () => {
    const text = "The fee is £100 per month.";
    expect(findCandidates([{ id: "S1", text }, { id: "S2", text }])).toHaveLength(1);
  });
});

describe("extraction", () => {
  const index = new DocumentIndex(doc);

  it("chooses paths from the request", () => {
    expect(extractionPlan("Extract all amounts and dates")).toEqual({ figures: true, text: false, kinds: ["amount", "date"] });
    expect(extractionPlan("Extract all amounts and durations.").kinds).toEqual(["amount", "duration"]);
    expect(extractionPlan("List the parties and their obligations")).toMatchObject({ figures: false, text: true });
    expect(extractionPlan("Extract everything important")).toEqual({ figures: true, text: true, kinds: ["amount", "percent", "duration", "date"] });
  });

  it("prefers passages that contain figures, dates or durations", () => {
    expect(entityDensity("pay £12,000 within thirty (30) days")).toBe(2);
    const order = rankForExtraction(index, index.retrieve("list all amounts"));
    expect(index.chunks[order[0]].text).toMatch(/£12,000|\(24\) hours/);
  });

  it("labels a pool of passages globally and batches them", () => {
    const batches = buildBatches(index, index.chunks.map((_, i) => i));
    const ids = batches.flat().map((s) => s.id);
    expect(ids).toEqual(ids.map((_, i) => `S${i + 1}`));
    batches.forEach((b) => expect(b.length).toBeLessThanOrEqual(6));
  });

  it("re-derives a row's source from the passage containing the value", () => {
    const sources = [{ id: "S1", text: "Nothing here." }, { id: "S2", text: "The Customer shall pay £12,000 per year." }];
    const rows = verifyItems([
      { category: "amount", label: "Annual fee", value: "£12,000", source: "S1", quote: "" }, // wrong label, repaired
      { category: "amount", label: "Annual fee", value: "£12,000", source: "S2", quote: "dup" },
      { category: "amount", label: "Cap", value: "£9,999", source: "S2", quote: "" },
      { category: "other", label: "", value: "x", source: "S1", quote: "" },
    ], sources);
    expect(rows.map((r) => [r.label, r.source, r.verified, r.problem])).toEqual([
      ["Annual fee", "S2", true, null],
      ["Cap", "S2", false, "value not found in any source"],
    ]);
  });

  it("labels figures with their section heading and keeps only the kinds asked for", () => {
    const sources = [{ id: "S1", section: "17. Limitation of Liability", text: "Liability shall not exceed £2,500,000 in any Contract Year. Claims must be made within two (2) years." }];
    expect(figureRows(sources, ["amount"])).toEqual([
      { category: "amount", label: "Limitation of Liability", value: "£2,500,000", source: "S1", quote: "Liability shall not exceed £2,500,000 in any Contract Year.", context: "Liability shall not exceed £2,500,000 in any Contract Year." },
    ]);
    expect(figureRows(sources, ["amount", "duration"]).map((r) => r.value)).toEqual(["£2,500,000", "two (2) years"]);
  });

  it("trims long context around the value", () => {
    const sentence = `${"a ".repeat(80)}fee of £5 applies ${"b ".repeat(80)}`.trim();
    const snip = contextSnippet(sentence, "£5", 40);
    expect(snip).toContain("£5");
    expect(snip.startsWith("…") && snip.endsWith("…")).toBe(true);
  });

  it("extracts figures without calling the model at all", async () => {
    let calls = 0;
    const llm = { async generateJSON() { calls++; return { items: [] }; } };
    const result = await runExtraction({ question: "List all amounts", index, retrieval: index.retrieve("List all amounts"), llm });
    expect(calls).toBe(0);
    expect(result.task.paths).toMatchObject({ figures: true, text: false, kinds: ["amount"] });
    expect(result.verification.status).toBe("grounded");
    expect(result.content).toMatch(/\| amount \| Fees \| £12,000 \| The Customer shall pay £12,000 per year\. \| \[S\d+\] ✓ \|/);
  });

  it("free extraction flags values that are not in the document", async () => {
    const llm = { async generateJSON() { return { items: [{ category: "party", label: "Processor", value: "Acme Ltd", source: "S1", quote: "" }] }; } };
    const result = await runExtraction({ question: "List the parties", index, retrieval: index.retrieve("parties"), llm });
    expect(result.verification.issues).toEqual([{ kind: "unverified-rows", detail: 1 }]);
    expect(result.content).toContain("| party | Processor | Acme Ltd |  | [S1] ⚠ |");
  });
});

describe("compliance", () => {
  const index = new DocumentIndex(doc);
  const breachItem = registry.checklists.gdpr_art28.items.find((i) => i.id === "a28_breach");
  const rightsItem = registry.checklists.gdpr_art28.items.find((i) => i.id === "a28_rights");
  const sources = [
    { id: "S1", text: "The Processor shall process Personal Data only on documented instructions from the Controller." },
    { id: "S2", text: "The Processor shall notify the Controller of a Personal Data Breach within twenty-four (24) hours." },
  ];

  it("picks the checklist named in the question", () => {
    expect(pickChecklist("Is this BAA HIPAA compliant?").key).toBe("hipaa_baa");
    expect(pickChecklist("Check this against GDPR article 28").key).toBe("gdpr_art28");
    expect(pickChecklist("Run a compliance check").key).toBe("gdpr_art28");
  });

  it("re-derives the source from the quote, even when the model said 'none'", () => {
    const r = verifyFinding({ quote: "notify the Controller of a Personal Data Breach within twenty-four (24) hours", source: "none", status: "addressed" }, sources, breachItem);
    expect(r).toMatchObject({ verdict: "addressed", source: "S2", problem: null });
  });

  it("rejects evidence that is real but does not mention the requirement's key terms", () => {
    const r = verifyFinding({ quote: "process Personal Data only on documented instructions from the Controller", source: "S1", status: "addressed" }, sources, rightsItem);
    expect(r.verdict).toBe("unverified");
    expect(r.problem).toMatch(/^evidence does not mention “data subject”/);
  });

  it("rejects paraphrased or missing evidence and keeps not_found", () => {
    expect(verifyFinding({ quote: "processors must report breaches quickly", status: "addressed" }, sources, breachItem).problem).toBe("quoted evidence not found in the sources");
    expect(verifyFinding({ quote: "", status: "partial" }, sources, breachItem).problem).toBe("no evidence quoted");
    expect(verifyFinding({ quote: "", source: "S1", status: "not_found" }, sources, breachItem)).toMatchObject({ verdict: "not_found", source: "none" });
  });

  it("restricts source labels at the grammar level and keeps quote-first order", () => {
    const cf = withSourceEnum(registry.schemas.compliance_finding, [], ["S3", "none"]);
    expect(cf.properties.source.enum).toEqual(["S3", "none"]);
    expect(Object.keys(cf.properties)).toEqual(["quote", "source", "status", "note"]);
    expect(registry.schemas.compliance_finding.properties.source.enum).toBeUndefined();
  });

  it("checks every requirement, shares source labels and streams progress", async () => {
    const progress = [];
    const llm = {
      async generateJSON(messages) {
        if (/breaches without undue delay/.test(messages[0].content)) {
          return { quote: "notify the Controller of a Personal Data Breach within twenty-four (24) hours", source: "none", status: "addressed", note: "24-hour notice." };
        }
        return { quote: "", source: "none", status: "not_found", note: "Not covered." };
      },
    };
    const result = await runCompliance({ question: "GDPR check", index, llm, onProgress: (md) => progress.push(md) });
    expect(result.task.checklist).toBe("gdpr_art28");
    expect(result.task.counts).toEqual({ addressed: 1, not_found: 7 });
    expect(result.content).toMatch(/Breach notification \| ✅ Addressed \| “notify the Controller/);
    expect(progress.length).toBe(8);
    expect(progress[3]).toContain("Checking 4 of 8");
    const ids = result.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stops between requirements when asked", async () => {
    let calls = 0;
    const llm = { async generateJSON() { calls++; return { quote: "", source: "none", status: "not_found", note: "" }; } };
    const result = await runCompliance({ question: "GDPR", index, llm, shouldStop: () => calls >= 3 });
    expect(calls).toBe(3);
    expect(result.content).toContain("Stopped after 3 of 8 requirements");
  });
});

describe("quote matching", async () => {
  const { sourceSupports } = await import("../src/rag/verify.js");
  const source = "6. Personal Data Breaches\n6.0 The Processor shall notify the Controller without undue delay, and in any event within forty-eight (48) hours, after becoming aware of a Personal Data Breach.";
  it("ignores clause numbers when a quote spans a heading and its clause", () => {
    expect(sourceSupports(source, "6. Personal Data Breaches The Processor shall notify the Controller without undue delay, and in any event within forty-eight (48) hours, after becoming aware of a Personal Data Breach.")).toBe(true);
  });
  it("still rejects changed figures and fabricated text", () => {
    expect(sourceSupports(source, "The Processor shall notify the Controller without undue delay, and in any event within twenty-four (24) hours, after becoming aware of a Personal Data Breach.")).toBe(false);
    expect(sourceSupports(source, "The processor assists the controller in responding to data subject rights requests.")).toBe(false);
  });
  it("rejects a single altered figure even inside a long, otherwise exact quote", () => {
    const long = `${"The Processor shall keep the Controller fully informed at all times of the progress of its investigation and remediation. ".repeat(3)}It shall notify the Controller within forty-eight (48) hours.`;
    expect(sourceSupports(long, long.replace("(48)", "(24)"))).toBe(false);
    expect(sourceSupports(long, long)).toBe(true);
  });
});

describe("candidate context", () => {
  it("does not split sentences on clause numbers or decimals", () => {
    const [c] = findCandidates([{ id: "S1", text: "10.4 Late fees apply. 10.5 The Customer shall pay each invoice within forty-five (45) days of receipt. 10.6 Other terms." }]);
    expect(c.context).toBe("The Customer shall pay each invoice within forty-five (45) days of receipt.");
    const [d] = findCandidates([{ id: "S1", text: "Availability must be at least 99.5% each month. Next sentence." }]);
    expect(d.context).toBe("Availability must be at least 99.5% each month.");
  });
});
