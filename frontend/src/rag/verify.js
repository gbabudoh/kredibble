// Post-generation checks of an answer against the sources it was given.
// These are cheap, deterministic signals, not proof of correctness:
//  - citations: every [S#] must refer to a source that was actually provided
//  - quotes:    quoted passages must appear in the sources
//  - numbers:   figures in the answer must appear in the sources or the question
import { normalizeForMatch, tokenize } from "./text.js";

// Accepts "[S1]", "[S1, S3]" and the "[~S1]" auto-citation form (a model may imitate it).
const CITATION_GROUP_RE = /\[~?((?:S\d+)(?:\s*[,;&]\s*(?:and\s+)?~?S?\d+)*)\]/gi;

/** Removes citation markers, e.g. from history turns whose labels referred to older sources. */
export const stripCitations = (text) => (text || "").replace(CITATION_GROUP_RE, "").replace(/[ \t]+([.,;!?])/g, "$1");
const QUOTE_RE = /["“]([^"“”]{20,400})["”]/g;
const NUMBER_RE = /(?<![\w.])(?:[£$€]\s?)?\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?%?|(?<![\w.])(?:[£$€]\s?)?\d+(?:\.\d+)?%?/g;

export const NOT_FOUND_TEXT = "I can't find that in the document.";

// Small models rephrase the not-found reply ("I can't find that information…",
// "The document does not mention…"), so match the family rather than the exact text.
const ABSTAIN_RE = /^\W*(?:i\s+(?:can['’]?t|cannot|could\s*not|couldn['’]?t|was\s+unable\s+to|am\s+unable\s+to)\s+find|(?:the\s+)?(?:document|sources?|excerpts?)\s+(?:does|do)\s*(?:not|n['’]t)\s+(?:contain|mention|include|specify|say|provide))/i;

export const isAbstention = (answer) => ABSTAIN_RE.test(answer || "");

export function extractCitations(answer) {
  const ids = [];
  for (const match of (answer || "").matchAll(CITATION_GROUP_RE)) {
    for (const n of match[1].matchAll(/\d+/g)) ids.push(`S${n[0]}`);
  }
  return [...new Set(ids)];
}

/** Strips citation markers, "(p. 3)" page refs and list numbering so they aren't mistaken for figures. */
function stripNonFigures(answer) {
  return answer
    .replace(CITATION_GROUP_RE, " ")
    .replace(/\((?:p|pp|page|pages)\.?\s*[\d\s,–-]+\)/gi, " ")
    .replace(/^\s*\d+[.)]\s+/gm, " ")
    .replace(/\b(?:S|section|clause|article|schedule|annex|para(?:graph)?)\s*\d+(?:\.\d+)*/gi, " ");
}

const digitsOnly = (s) => s.replace(/[£$€\s,]/g, "");

// Clause numbers in front of a capitalised word ("6.0 The Processor", "17. Limitation").
// Models often drop or merge them when quoting a heading together with its clause, so they
// are ignored on both sides. Figures such as "forty-eight (48) hours" are untouched.
const CLAUSE_NUMBER_RE = /(^|\s)\d+(?:\.\d+)*\.?(?=\s+[A-Z])/g;

/** True when `quote` occurs in `sourceText`, tolerating small extraction differences. */
export function sourceSupports(sourceText, quote) {
  const strip = (t) => (t || "").replace(CLAUSE_NUMBER_RE, "$1");
  const q = strip(quote);
  const s = strip(sourceText);
  // The shingle tolerance below could let one altered figure through in a long quote,
  // so every figure in the quote must also occur in the source, exactly.
  const sourceFigures = new Set([...s.matchAll(NUMBER_RE)].map((m) => digitsOnly(m[0])));
  if ([...q.matchAll(NUMBER_RE)].some((m) => !sourceFigures.has(digitsOnly(m[0])))) return false;
  return quoteSupported(q, normalizeForMatch(s).replace(/["']/g, ""));
}

function quoteSupported(quote, haystack) {
  const q = normalizeForMatch(quote).replace(/["']/g, "");
  if (!q) return true;
  if (haystack.includes(q)) return true;
  // Tolerate small extraction differences: 90% of the quote's 4-word shingles must be present.
  const words = q.split(" ");
  if (words.length < 4) return false;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 4 <= words.length; i++) {
    total++;
    if (haystack.includes(words.slice(i, i + 4).join(" "))) hit++;
  }
  return hit / total >= 0.9;
}

/**
 * @param {string} answer
 * @param {Array<{id:string, text:string}>} sources
 * @param {string} question
 */
export function verifyAnswer(answer, sources, question = "") {
  const issues = [];
  const text = answer || "";
  const abstained = isAbstention(text);

  const provided = new Set(sources.map((s) => s.id));
  const cited = extractCitations(text);
  const validCitations = cited.filter((id) => provided.has(id));
  const invalidCitations = cited.filter((id) => !provided.has(id));
  if (invalidCitations.length) issues.push({ kind: "invalid-citation", detail: invalidCitations.join(", ") });
  if (!abstained && sources.length && !validCitations.length) issues.push({ kind: "no-citation" });

  const haystack = normalizeForMatch(sources.map((s) => s.text).join("\n")).replace(/["']/g, "");
  for (const match of text.matchAll(QUOTE_RE)) {
    if (!quoteSupported(match[1], haystack)) issues.push({ kind: "unverified-quote", detail: match[1].slice(0, 80) });
  }

  const allowedDigits = new Set();
  for (const src of [haystack, normalizeForMatch(question)]) {
    for (const m of src.matchAll(NUMBER_RE)) allowedDigits.add(digitsOnly(m[0]).replace(/%$/, ""));
  }
  const unsupported = new Set();
  for (const m of stripNonFigures(text).matchAll(NUMBER_RE)) {
    const value = digitsOnly(m[0]).replace(/%$/, "");
    if (value.length && !allowedDigits.has(value)) unsupported.add(m[0].trim());
  }
  if (unsupported.size) issues.push({ kind: "unsupported-number", detail: [...unsupported].join(", ") });

  return {
    status: abstained ? "abstained" : issues.length ? "warning" : "grounded",
    citedIds: validCitations,
    issues,
  };
}

const MIN_ATTRIBUTION_OVERLAP = 0.6;
const MIN_SUBSTANTIVE_WORDS = 3;

// A sentence ends at . ! ? followed by whitespace or end of line, so "99.5%" and "£2.5m"
// stay intact; a citation written after the full stop ("… cap. [S1]") belongs to it.
const SENTENCE_RE = /(?:[^\n.!?]|[.!?](?![\s]|$))+[.!?]*(?:[ \t]*\[~?S\d+[^\]\n]*\])*/g;

/**
 * Links uncited answer sentences to the source they overlap with most (content words,
 * with exact figures counting extra). Inserted markers use the form [~S2] so the UI can
 * show them as automatic rather than model-provided citations. Substantive sentences
 * that match no source are returned in `unmatched`.
 */
export function attributeSentences(answer, sources) {
  const sourceTokens = sources.map((s) => new Set(tokenize(s.text)));
  const sourceDigits = sources.map((s) => new Set([...s.text.matchAll(NUMBER_RE)].map((m) => digitsOnly(m[0]))));
  const ids = new Set();
  const unmatched = [];

  const text = answer.replace(SENTENCE_RE, (sentence) => {
    if (/\[~?S\d+/i.test(sentence)) return sentence;
    const words = [...new Set(tokenize(sentence))];
    if (words.length < MIN_SUBSTANTIVE_WORDS) return sentence;
    const digits = [...stripNonFigures(sentence).matchAll(NUMBER_RE)].map((m) => digitsOnly(m[0]));

    let best = -1;
    let bestScore = 0;
    sources.forEach((_, i) => {
      const overlap = words.filter((w) => sourceTokens[i].has(w)).length / words.length;
      const figureBonus = digits.some((d) => sourceDigits[i].has(d)) ? 0.25 : 0;
      if (overlap + figureBonus > bestScore) {
        bestScore = overlap + figureBonus;
        best = i;
      }
    });
    if (best < 0 || bestScore < MIN_ATTRIBUTION_OVERLAP) {
      unmatched.push(sentence.trim());
      return sentence;
    }
    ids.add(sources[best].id);
    return sentence.replace(/([.!?]*)$/, ` [~${sources[best].id}]$1`);
  });

  return { text, ids: [...ids], unmatched };
}

/**
 * Verifies the model's answer, attributes any uncited sentences to sources, and flags
 * substantive sentences that no source supports (e.g. outside knowledge, or earlier
 * conversation leaking into a document answer).
 * @returns {{ content: string, verification: ReturnType<typeof verifyAnswer> & { autoCited: string[] } }}
 */
export function groundAnswer(answer, sources, question = "") {
  const base = verifyAnswer(answer, sources, question);
  if (base.status === "abstained" || !sources.length) {
    return { content: answer, verification: { ...base, autoCited: [] } };
  }

  const { text, ids, unmatched } = attributeSentences(answer, sources);
  const autoCited = ids.filter((id) => !base.citedIds.includes(id));
  const citedIds = [...new Set([...base.citedIds, ...ids])];
  const issues = base.issues.filter((i) => i.kind !== "no-citation");
  if (!citedIds.length) issues.push({ kind: "no-citation" });
  else if (unmatched.length) issues.push({ kind: "unsupported-sentence", detail: unmatched.length, sentences: unmatched.slice(0, 3) });

  return {
    content: text,
    verification: { ...base, citedIds, autoCited, issues, status: issues.length ? "warning" : "grounded" },
  };
}

// Relevance: how similar the answer is to the question, relative to the best passage.
// Calibrated on 16 real answers to a 15-page contract (arctic-embed-s): faithful answers
// scored 0.965–1.255, faithful-but-off-topic ones 0.65–0.936 (plus one vague restatement
// at 1.161 that this cannot catch). Small, same-document sample, so it is advisory only.
export const MIN_RELEVANCE_RATIO = 0.95;

/** @returns an issue when the answer looks less related to the question than the best passage does. */
export function relevanceIssue(answerSimilarity, bestPassageSimilarity) {
  if (!(bestPassageSimilarity > 0)) return null;
  const ratio = answerSimilarity / bestPassageSimilarity;
  return ratio < MIN_RELEVANCE_RATIO ? { kind: "off-topic", detail: Number(ratio.toFixed(2)) } : null;
}

export function describeIssue(issue) {
  switch (issue.kind) {
    case "invalid-citation": return `cites sources that don't exist (${issue.detail})`;
    case "no-citation": return "no source citations";
    case "unverified-quote": return `quote not found in sources: “${issue.detail}…”`;
    case "unsupported-number": return `figures not found in sources: ${issue.detail}`;
    case "off-topic": return "may not answer the question (the answer is less related to it than the best passage)";
    case "unverified-rows": return `${issue.detail} row${issue.detail === 1 ? "" : "s"} not matched to the cited source`;
    case "unverified-findings": return `${issue.detail} finding${issue.detail === 1 ? "" : "s"} without verifiable evidence`;
    case "unsupported-sentence": return `${issue.detail} sentence${issue.detail === 1 ? "" : "s"} not supported by any source`;
    default: return issue.kind;
  }
}
