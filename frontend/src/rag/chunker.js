// Splits extracted pages into retrieval chunks.
// - Chunks never cross a page boundary, so every chunk has an exact page citation.
// - Section headings (numbered clauses, "Section 4", ALL-CAPS titles) are tracked and
//   carried forward so a chunk knows which section it belongs to.
// - Target size keeps chunks well under the embedding model's 512-token input limit.

export const TARGET_CHARS = 900;
export const MAX_CHARS = 1200;
const OVERLAP_MAX_CHARS = 250;

const HEADING_PATTERNS = [
  /^(?:section|clause|article|schedule|annex|appendix|part|chapter)\s+[\w.]+\b.{0,80}$/i,
  /^\d+(?:\.\d+){0,3}[.)]?\s+[A-Z][^.!?]{0,80}$/,
  /^[A-Z][A-Z0-9 ,&/'()\-]{3,70}$/,
];

export function detectHeading(line) {
  const text = line.trim();
  if (text.length < 3 || text.length > 100) return null;
  return HEADING_PATTERNS.some((re) => re.test(text)) ? text.replace(/\s+/g, " ") : null;
}

function splitSentences(paragraph) {
  const parts = paragraph.match(/[^.!?;]+(?:[.!?;]+(?=\s|$)|$)/g) || [paragraph];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Breaks a page into units no longer than MAX_CHARS, each tagged with the section in force. */
function pageUnits(text, sectionState) {
  const units = [];
  const paragraphs = text.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n").map((l) => l.trim()).filter(Boolean);
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const joined = buffer.join(" ");
      const pieces = joined.length > MAX_CHARS ? splitSentences(joined) : [joined];
      for (const piece of pieces) {
        // Hard-wrap pathological sentences (tables, run-on extraction) at MAX_CHARS.
        for (let i = 0; i < piece.length; i += MAX_CHARS) {
          units.push({ text: piece.slice(i, i + MAX_CHARS), section: sectionState.current });
        }
      }
      buffer = [];
    };
    for (const line of lines) {
      const heading = detectHeading(line);
      if (heading) {
        flush();
        sectionState.current = heading;
      }
      buffer.push(line);
    }
    flush();
  }
  return units;
}

/**
 * @param {Array<{page:number, text:string}>} pages
 * @returns {Array<{index:number, page:number, section:string|null, text:string}>}
 */
export function chunkPages(pages) {
  const chunks = [];
  const sectionState = { current: null };

  for (const { page, text } of pages) {
    if (!text?.trim()) continue;
    const units = pageUnits(text, sectionState);
    let current = [];
    let length = 0;
    let section = units[0]?.section ?? null;

    const emit = () => {
      if (!current.length) return;
      chunks.push({ index: chunks.length, page, section, text: current.map((u) => u.text).join(" ") });
    };

    for (const unit of units) {
      const startsNewSection = unit.section !== section && length > 0;
      if (length > 0 && (length + unit.text.length > TARGET_CHARS || startsNewSection)) {
        emit();
        // Carry a short tail unit as overlap, unless we just crossed into a new section.
        const tail = current[current.length - 1];
        current = !startsNewSection && tail.text.length <= OVERLAP_MAX_CHARS ? [tail] : [];
        length = current.reduce((n, u) => n + u.text.length, 0);
        section = unit.section;
      }
      if (!current.length) section = unit.section;
      current.push(unit);
      length += unit.text.length + 1;
    }
    emit();
  }
  return chunks;
}
