// Hybrid retrieval over one document: BM25 + (optional) embeddings, fused with
// reciprocal rank fusion, then packed into the prompt's token budget.
import { chunkPages } from "./chunker.js";
import { BM25Index } from "./bm25.js";
import { estimateTokens, tokenize } from "./text.js";

const RRF_K = 60;
const CANDIDATES_PER_RANKER = 20;
// Each ranker's top hits are guaranteed a slot before the fused order fills the rest:
// in evaluation, plain RRF dropped passages that only one ranker found.
const GUARANTEED_PER_RANKER = 3;
const MAX_SOURCES = 6;
const MAX_SUMMARY_SOURCES = 8;

// Why there is no semantic abstention threshold: on a 15-page contract with 12 relevant and
// 8 unrelated questions, neither raw cosine nor the best passage's z-score separated the two
// groups with snowflake-arctic-embed-s or -m ("What is the uptime commitment?" z=1.98 vs
// "Tell me a joke about cats" z=1.92). Any threshold that caught the unrelated questions
// also refused real ones. So the model decides from the retrieved sources, and the
// verifier checks the result. The gate below only covers keyword-only search.
const MIN_CHUNKS_TO_GATE = 12;

const SUMMARY_RE = /\b(summar(y|ise|ize|ising|izing)|overview|recap|rundown|nutshell|highlights|tl;?dr|outline|gist|key (points|terms|takeaways|clauses|provisions)|main points|what is (this|the) (document|file|agreement|contract) about)\b/i;

export const isSummaryRequest = (text) => SUMMARY_RE.test(text || "");

const FOLLOW_UP_RE = /^\s*(and|but|also|so|then|what about|how about|why)\b|\b(it|its|they|them|their|those|that one|the same|above|previous|earlier)\b/i;

/**
 * Search query for this turn. The previous question is only added for follow-ups
 * ("and what about termination?", "why is it capped?"); adding it to every query
 * dragged the last topic's passages into unrelated new questions.
 */
export function retrievalQuery(text, previousQuestion = "") {
  if (!previousQuestion) return text;
  const isFollowUp = FOLLOW_UP_RE.test(text) || tokenize(text).length <= 1;
  return isFollowUp ? `${text}\n${previousQuestion}` : text;
}

/** Text used for embeddings: the section heading gives short chunks useful context. */
export const chunkIndexText = (chunk) => (chunk.section && !chunk.text.startsWith(chunk.section) ? `${chunk.section}\n${chunk.text}` : chunk.text);

// Keyword index text repeats the heading, so a match on "Governing Law" outweighs
// boilerplate mentions of "applicable laws" scattered through the document.
const HEADING_WEIGHT = 3;
const chunkKeywordText = (chunk) => (chunk.section ? `${`${chunk.section}\n`.repeat(HEADING_WEIGHT)}${chunk.text}` : chunk.text);

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function normalize(vector) {
  const v = Float32Array.from(vector);
  const norm = Math.sqrt(dot(v, v)) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function stats(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

export class DocumentIndex {
  constructor(doc) {
    this.filename = doc.filename;
    this.chunks = chunkPages(doc.pages);
    this.bm25 = new BM25Index(this.chunks.map(chunkKeywordText));
    this.vectors = null;
  }

  get hasSemantic() {
    return Array.isArray(this.vectors) && this.vectors.length === this.chunks.length;
  }

  setVectors(vectors) {
    this.vectors = vectors.map(normalize);
  }

  /**
   * @param {string} query
   * @param {Float32Array|number[]|null} queryVector
   */
  retrieve(query, queryVector = null) {
    const lexical = this.bm25.search(query, CANDIDATES_PER_RANKER);
    const fused = new Map();
    const entry = (index) => {
      if (!fused.has(index)) fused.set(index, { index, rrf: 0, lexical: 0, semantic: null });
      return fused.get(index);
    };

    lexical.hits.forEach((hit, rank) => {
      const e = entry(hit.index);
      e.rrf += 1 / (RRF_K + rank + 1);
      e.lexical = hit.score;
    });

    let semantic = null;
    if (queryVector && this.hasSemantic) {
      const q = normalize(queryVector);
      const scores = this.vectors.map((v) => dot(q, v));
      const { mean, std } = stats(scores);
      const ranked = scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score);
      const best = ranked[0]?.score ?? 0;
      semantic = { best, z: std > 1e-6 ? (best - mean) / std : 0 };
      ranked.slice(0, CANDIDATES_PER_RANKER).forEach((hit, rank) => {
        const e = entry(hit.index);
        e.rrf += 1 / (RRF_K + rank + 1);
        e.semantic = hit.score;
      });
    }

    const byRrf = [...fused.values()].sort((a, b) => b.rrf - a.rrf);
    const bySemantic = byRrf.filter((e) => e.semantic !== null).sort((a, b) => b.semantic - a.semantic);
    const byLexical = byRrf.filter((e) => e.lexical > 0).sort((a, b) => b.lexical - a.lexical);
    const guaranteed = [];
    for (let i = 0; i < GUARANTEED_PER_RANKER; i++) guaranteed.push(byLexical[i], bySemantic[i]);
    const ranked = [...new Set([...guaranteed.filter(Boolean), ...byRrf])];

    return {
      ranked,
      bestLexical: lexical.hits[0]?.score ?? 0,
      matchedTerms: lexical.matchedTerms,
      queryTerms: lexical.queryTerms,
      weightedCoverage: lexical.weightedCoverage,
      semanticUsed: semantic !== null,
      bestSemantic: semantic?.best ?? null,
      semanticZ: semantic?.z ?? null,
      chunkCount: this.chunks.length,
    };
  }

  /**
   * Picks top-ranked chunks that fit the budget. Labels follow relevance (S1 = best match),
   * because small models attend most to what comes first.
   */
  select(ranked, budgetTokens, maxSources = MAX_SOURCES) {
    return this.toSources(this.pick(ranked, budgetTokens, maxSources));
  }

  /** For "summarise this": spread sources evenly across the whole document, in document order. */
  selectSpread(budgetTokens) {
    const n = this.chunks.length;
    if (!n) return [];
    const avg = this.chunks.reduce((s, c) => s + estimateTokens(c.text) + 16, 0) / n;
    const k = Math.max(1, Math.min(n, MAX_SUMMARY_SOURCES, Math.floor(budgetTokens / avg)));
    const picks = [...new Set(Array.from({ length: k }, (_, i) => (k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1)))))];
    const chosen = this.pick(picks.map((index) => ({ index })), budgetTokens, MAX_SUMMARY_SOURCES);
    return this.toSources(chosen.sort((a, b) => a - b));
  }

  pick(ranked, budgetTokens, maxSources) {
    const chosen = [];
    let used = 0;
    for (const { index } of ranked) {
      if (chosen.length >= maxSources) break;
      const cost = estimateTokens(this.chunks[index].text) + 16;
      if (used + cost > budgetTokens) continue;
      chosen.push(index);
      used += cost;
    }
    return chosen;
  }

  toSources(indices) {
    return indices.map((index, i) => {
      const c = this.chunks[index];
      return { id: `S${i + 1}`, index, page: c.page, section: c.section, text: c.text };
    });
  }
}

/**
 * Decide whether to skip generation because retrieval has nothing to offer. Only applies when
 * semantic search is unavailable, the document is long enough that the model would not see
 * most of it anyway, and not a single query term occurs in the document.
 */
export function shouldAbstain(retrieval) {
  const { queryTerms, matchedTerms, semanticUsed, chunkCount } = retrieval;
  if (semanticUsed || queryTerms === 0 || chunkCount < MIN_CHUNKS_TO_GATE) return false;
  return matchedTerms === 0;
}
