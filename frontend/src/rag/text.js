// Shared text utilities for retrieval and verification.

const STOPWORDS = new Set(
  ("a an and are as at be been being but by can could did do does for from had has have how i if in into is it its " +
   "may me might must my no nor not of on or our shall should so such than that the their them then there these they " +
   "this those to was we were what when where which who whom why will with would you your about any all also each " +
   "per please tell explain describe give show list document doc file say says said mean means meaning " +
   "elaborate clarify simply simpler more again detail details further expand why").split(" ")
);

/** Lowercases, keeps letters/digits, drops stopwords, applies a light suffix stemmer. */
export function tokenize(text) {
  const raw = (text || "").toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const word of raw) {
    if (STOPWORDS.has(word)) continue;
    if (word.length < 2 && !/\d/.test(word)) continue;
    out.push(stem(word));
  }
  return out;
}

function stem(word) {
  if (/\d/.test(word) || word.length <= 4) return word;
  for (const suffix of ["ations", "ation", "ings", "ing", "ies", "ied", "ed", "es", "s", "ly"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, -suffix.length);
      if (suffix === "ies" || suffix === "ied") return `${base}y`;
      // "capped" -> "capp" -> "cap", "terminating" stays "terminat"
      if (/([b-df-hj-km-np-rtv-z])\1$/.test(base) && !/(ll|ss|zz)$/.test(base)) return base.slice(0, -1);
      return base;
    }
  }
  return word;
}

/** Normalises text for substring comparisons: lowercase, unify quotes/dashes, collapse whitespace. */
export function normalizeForMatch(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[^\p{L}\p{N}%.,'"\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const estimateTokens = (text) => Math.ceil((text || "").length / 3);
