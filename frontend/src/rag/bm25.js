// Okapi BM25 over chunk texts. Small enough to keep in-house, and its raw scores
// are what the abstention gate uses to decide whether anything matched at all.
import { tokenize } from "./text.js";

const K1 = 1.2;
const B = 0.75;

export class BM25Index {
  /** @param {string[]} documents */
  constructor(documents) {
    this.docTerms = documents.map((d) => {
      const tf = new Map();
      for (const t of tokenize(d)) tf.set(t, (tf.get(t) || 0) + 1);
      return tf;
    });
    this.docLengths = this.docTerms.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
    this.avgLength = this.docLengths.reduce((a, b) => a + b, 0) / Math.max(1, documents.length);
    this.df = new Map();
    for (const tf of this.docTerms) for (const term of tf.keys()) this.df.set(term, (this.df.get(term) || 0) + 1);
  }

  idf(term) {
    const n = this.docTerms.length;
    const df = this.df.get(term) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * weightedCoverage is the IDF-weighted share of query terms found in the document, so
   * a match on a common word ("good" in "good faith") counts for little while a rare,
   * specific word ("pasta") that is absent counts for a lot.
   * @returns {{ hits: Array<{index:number, score:number}>, matchedTerms: number, queryTerms: number, weightedCoverage: number }}
   */
  search(query, limit = 20) {
    const terms = [...new Set(tokenize(query))];
    const matched = terms.filter((t) => this.df.has(t));
    const totalIdf = terms.reduce((s, t) => s + this.idf(t), 0);
    const matchedIdf = matched.reduce((s, t) => s + this.idf(t), 0);
    const hits = [];
    this.docTerms.forEach((tf, index) => {
      let score = 0;
      for (const term of matched) {
        const f = tf.get(term);
        if (!f) continue;
        const norm = f + K1 * (1 - B + (B * this.docLengths[index]) / (this.avgLength || 1));
        score += this.idf(term) * ((f * (K1 + 1)) / norm);
      }
      if (score > 0) hits.push({ index, score });
    });
    hits.sort((a, b) => b.score - a.score);
    return {
      hits: hits.slice(0, limit),
      matchedTerms: matched.length,
      queryTerms: terms.length,
      weightedCoverage: totalIdf ? matchedIdf / totalIdf : 0,
    };
  }
}
