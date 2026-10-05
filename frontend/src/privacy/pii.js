// Personal-data detection and redaction, fully on-device and deterministic.
// Patterns are paired with validity checks (Luhn for cards, ISO 7064 mod-97 for IBANs, the
// published format rules for UK NI and US SSN numbers) so that ordinary figures in contracts
// ("£2,500,000", clause numbers, dates) are not flagged.
//
// Scope: identifiers with a recognisable format. It does not find names or free-text
// descriptions of people, so a clean scan does not prove a document holds no personal data.

export const PII_LABELS = {
  email: "Email address",
  phone: "Phone number",
  card: "Payment card number",
  iban: "IBAN",
  uk_ni: "UK National Insurance number",
  us_ssn: "US Social Security number",
  ip: "IP address",
};

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(raw) {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function phoneDigitsOk(value) {
  const d = value.replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 && !/^(\d)\1+$/.test(d);
}

const DETECTORS = [
  { type: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: "iban", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g, valid: ibanValid },
  {
    type: "card",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    valid: (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d); },
  },
  {
    type: "uk_ni",
    re: /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
    valid: (m) => !/^(BG|GB|NK|KN|TN|NT|ZZ)/.test(m.replace(/\s/g, "")),
  },
  {
    type: "us_ssn",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    valid: (m) => { const [a, g, s] = m.split("-"); return a !== "000" && a !== "666" && a[0] !== "9" && g !== "00" && s !== "0000"; },
  },
  {
    // International: +44 20 7946 0958, +1 555 123 4567
    type: "phone",
    re: /\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}\b/g,
    valid: (m) => phoneDigitsOk(m),
  },
  {
    // National: 07700 900123, 020 7946 0958, (555) 123-4567, 555-123-4567
    type: "phone",
    re: /(?:\(\d{3,5}\)\s?|\b0[1-9]\d{1,3}[\s.-]?|\b\d{3}[.-])\d{3,4}[\s.-]?\d{3,4}\b/g,
    valid: (m) => phoneDigitsOk(m),
  },
  {
    type: "ip",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    valid: (m) => m.split(".").every((o) => Number(o) <= 255 && String(Number(o)) === o),
  },
];

/** @returns {Array<{type:string, start:number, end:number, value:string}>} non-overlapping, in order */
export function findPII(text) {
  const hits = [];
  for (const { type, re, valid } of DETECTORS) {
    for (const m of (text || "").matchAll(re)) {
      const value = m[0].trim();
      const start = m.index + m[0].indexOf(value);
      const end = start + value.length;
      if (valid && !valid(value)) continue;
      // Detectors run in priority order; skip spans already claimed (an IBAN's digits are not also a card).
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ type, start, end, value });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

export const placeholder = (type) => `[${type.toUpperCase()} REDACTED]`;

export function redact(text, hits = findPII(text)) {
  let out = "";
  let at = 0;
  for (const h of hits) {
    out += text.slice(at, h.start) + placeholder(h.type);
    at = h.end;
  }
  return out + text.slice(at);
}

/** Masked preview for showing what was found without repeating it in full. */
export function mask(value) {
  const chars = [...value];
  const keep = Math.min(2, Math.floor(chars.length / 4));
  return chars.map((c, i) => (i < keep || i >= chars.length - keep || !/[A-Za-z0-9]/.test(c) ? c : "•")).join("");
}

/** Scans a document page by page. */
export function scanDocument(pages) {
  const findings = [];
  for (const { page, text } of pages) {
    for (const h of findPII(text)) findings.push({ ...h, page });
  }
  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  return { findings, counts, total: findings.length };
}

export const redactPages = (pages) => pages.map(({ page, text }) => ({ page, text: redact(text) }));
