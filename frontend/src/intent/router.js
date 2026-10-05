// On-device intent routing with weights trained in Python (backend/app/registry/router.py).
// Mirrors scikit-learn's TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True) followed by
// multinomial LogisticRegression.predict_proba. Parity with scikit-learn is unit-tested
// against samples exported alongside the weights.
import registry from "../registry/registry.json";
import { isSummaryRequest } from "../rag/retriever.js";

// sklearn's default token_pattern r"(?u)\b\w\w+\b": runs of 2+ word characters.
const TOKEN_RE = /[\p{L}\p{N}_]{2,}/gu;

export class IntentRouter {
  constructor(model) {
    this.classes = model.classes;
    this.vocabulary = model.vocabulary;
    this.idf = model.idf;
    this.coef = model.coef;
    this.intercept = model.intercept;
    this.sublinear = model.sublinear_tf;
  }

  features(text) {
    const tokens = (text.toLowerCase().match(TOKEN_RE) || []);
    const grams = [...tokens];
    for (let i = 0; i + 1 < tokens.length; i++) grams.push(`${tokens[i]} ${tokens[i + 1]}`);

    const counts = new Map();
    for (const g of grams) {
      const idx = this.vocabulary[g];
      if (idx !== undefined) counts.set(idx, (counts.get(idx) || 0) + 1);
    }
    const weights = new Map();
    let norm = 0;
    for (const [idx, tf] of counts) {
      const w = (this.sublinear ? 1 + Math.log(tf) : tf) * this.idf[idx];
      weights.set(idx, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [idx, w] of weights) weights.set(idx, w / norm);
    return weights;
  }

  /** @returns {Record<string, number>} probability per intent */
  predict(text) {
    const x = this.features(text);
    const logits = this.classes.map((_, k) => {
      let z = this.intercept[k];
      for (const [idx, w] of x) z += this.coef[k][idx] * w;
      return z;
    });
    const max = Math.max(...logits);
    const exps = logits.map((z) => Math.exp(z - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return Object.fromEntries(this.classes.map((c, k) => [c, exps[k] / sum]));
  }
}

const config = registry.intents;
export const router = new IntentRouter(config.router);

/**
 * Chooses how to handle a message.
 * @param {string} text
 * @param {{ hasDocument: boolean, documentOverlap?: number }} context
 *   documentOverlap: IDF-weighted share of the question's words found in the loaded document.
 * @returns {{ intent: "chat"|"qa"|"summary"|"extract"|"compliance"|"general", confidence: number, probs?: object, reason: string }}
 */
export function routeMessage(text, { hasDocument, documentOverlap = 0 }) {
  if (!hasDocument) return { intent: "chat", confidence: 1, reason: "no document loaded" };

  const probs = router.predict(text);
  const [top, confidence] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];

  // The summary regex is a precise override for phrasings the router has not seen ("recap").
  if (isSummaryRequest(text) && (top === "qa" || top === "summary")) {
    return { intent: "summary", confidence: Math.max(confidence, probs.summary), probs, reason: "summary phrasing" };
  }
  if (top === "general") {
    // Skipping the document needs two independent signals (see backend intents.py).
    if (confidence >= config.min_confidence_general && documentOverlap < config.max_doc_overlap_for_general) {
      return { intent: "general", confidence, probs, reason: "unrelated to the document" };
    }
    return { intent: "qa", confidence: probs.qa, probs, reason: "possibly general, but shares vocabulary with the document" };
  }
  if (confidence < config.min_confidence) {
    return { intent: "qa", confidence, probs, reason: `low confidence for ${top}` };
  }
  return { intent: top, confidence, probs, reason: "router" };
}
