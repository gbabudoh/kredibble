// Answer feedback: what users rate, how it is stored, and how it is reused.
// Everything here stays in the browser. Only the opt-in metrics (metrics.js) leave the
// device, and those carry reason codes and counts, never text.
import { tokenize, estimateTokens } from "../rag/text.js";
import { stripCitations } from "../rag/verify.js";

export const REASONS = [
  { code: "wrong", label: "Wrong answer" },
  { code: "not-in-document", label: "Made up / not in the document" },
  { code: "citation", label: "Missing or wrong citation" },
  { code: "incomplete", label: "Incomplete" },
  { code: "off-topic", label: "Didn't answer the question" },
  { code: "other", label: "Other" },
];

const MAX_CORRECTION_CHARS = 1000;

/** SHA-256 of the document text, so feedback can be tied to "the same document" without storing it. */
export async function documentFingerprint(pages) {
  const bytes = new TextEncoder().encode(pages.map((p) => p.text).join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * @param {{threadId:string, messageIndex:number, question:string, message:object, rating:"up"|"down",
 *          reasons?:string[], correction?:string, docFingerprint?:string|null, registryVersion:string}} args
 */
export function buildRecord({ threadId, messageIndex, question, message, rating, reasons = [], correction = "", docFingerprint = null, registryVersion }) {
  const meta = message.meta || {};
  return {
    id: `${threadId}:${messageIndex}`,
    createdAt: new Date().toISOString(),
    rating,
    reasons: rating === "down" ? reasons.filter((r) => REASONS.some((x) => x.code === r)) : [],
    correction: rating === "down" ? correction.trim().slice(0, MAX_CORRECTION_CHARS) : "",
    question,
    answer: message.content,
    intent: meta.route?.intent || (meta.doc ? "qa" : "chat"),
    status: meta.verification?.status || "none",
    doc: meta.doc || null,
    docFingerprint,
    model: meta.model || null,
    registryVersion,
  };
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
};

/**
 * Approved examples for few-shot prompting: answers rated 👍, or 👎 with a correction
 * (the correction is the approved answer). Picks the most similar questions by word overlap.
 */
export function selectExamples(question, records, { k = 2, minSimilarity = 0.2, maxTokens = 220 } = {}) {
  const q = new Set(tokenize(question));
  const candidates = records
    .filter((r) => r.intent === "qa" && (r.rating === "up" || (r.rating === "down" && r.correction)))
    .map((r) => ({ r, score: jaccard(q, new Set(tokenize(r.question))) }))
    .filter((x) => x.score >= minSimilarity)
    .sort((a, b) => b.score - a.score);

  const out = [];
  let used = 0;
  for (const { r } of candidates) {
    if (out.length >= k) break;
    const answer = r.rating === "down" ? r.correction : stripCitations(r.answer);
    const cost = estimateTokens(r.question) + estimateTokens(answer) + 8;
    if (used + cost > maxTokens) continue;
    out.push({ question: r.question, answer });
    used += cost;
  }
  return out;
}

/** Corrections exported as candidate items for evals/gold.json (reviewed by a person before use). */
export function toEvalCandidates(records) {
  return records
    .filter((r) => r.rating === "down" && r.correction && r.intent === "qa")
    .map((r) => ({ doc: r.doc, q: r.question, expect: [r.correction], reasons: r.reasons, rejected_answer: r.answer }));
}
