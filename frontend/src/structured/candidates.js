// Finds figures (amounts, percentages, durations, dates) by pattern matching, so extracted
// values are verbatim by construction. The model's only job is to label each candidate.

const MONTHS = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
const UNIT = "(?:business\\s+|calendar\\s+|working\\s+)?(?:days?|weeks?|months?|years?|hours?)";

const PATTERNS = [
  ["amount", new RegExp("[£$€]\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:million|billion|bn|m|k)\\b)?", "gi")],
  ["amount", new RegExp("\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:GBP|USD|EUR|pounds|dollars|euros)\\b", "gi")],
  ["percent", new RegExp("\\b\\d+(?:\\.\\d+)?\\s?(?:%|per\\s?cent\\b)", "gi")],
  ["duration", new RegExp(`\\b(?:[a-z]+(?:-[a-z]+)?\\s)?\\(\\d+\\)\\s*${UNIT}`, "gi")],
  ["duration", new RegExp(`\\b\\d+\\s*${UNIT}\\b`, "gi")],
  ["date", new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\s+\\d{4}\\b`, "gi")],
  ["date", new RegExp(`\\b${MONTHS}\\s+\\d{1,2},?\\s+\\d{4}\\b`, "gi")],
];

// A sentence ends at ". " not preceded by a digit, so clause numbers like "10.5 The…"
// and decimals don't split a sentence.
const BOUNDARY_RE = /(?<!\d)\.\s/g;

function sentenceAround(text, start, end) {
  let from = 0;
  let to = text.length;
  for (const m of text.matchAll(BOUNDARY_RE)) {
    if (m.index < start) from = m.index + m[0].length;
    else if (m.index >= end) { to = m.index + 1; break; }
  }
  // Drop a leading clause number ("10.5 The Customer…" -> "The Customer…").
  return text.slice(from, to).trim().replace(/^\d+(?:\.\d+)*\.?\s+(?=[A-Z])/, "");
}

/**
 * @param {Array<{id:string, text:string}>} sources
 * @returns {Array<{id:string, value:string, kind:string, source:string, context:string}>}
 */
export function findCandidates(sources, limit = 24) {
  const out = [];
  const seen = new Set();
  for (const source of sources) {
    const spans = [];
    for (const [kind, re] of PATTERNS) {
      for (const m of source.text.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        // Keep the longest match where patterns overlap ("thirty (30) days" over "30 days").
        if (spans.some((s) => start < s.end && end > s.start && s.end - s.start >= end - start)) continue;
        for (let i = spans.length - 1; i >= 0; i--) if (start < spans[i].end && end > spans[i].start) spans.splice(i, 1);
        spans.push({ kind, start, end, value: m[0].trim() });
      }
    }
    spans.sort((a, b) => a.start - b.start);
    for (const s of spans) {
      const context = sentenceAround(source.text, s.start, s.end);
      // Overlapping chunks repeat sentences; keep the first occurrence.
      const key = `${s.value.toLowerCase()}|${context.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `C${out.length + 1}`, value: s.value, kind: s.kind, source: source.id, context });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
