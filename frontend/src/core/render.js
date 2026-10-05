// Safe rendering of model output. Model text is untrusted: a document can
// contain prompt injection that makes the model emit HTML or markdown images
// whose URLs carry document content off the device. Images and active
// content are therefore stripped entirely.
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

const FORBID_TAGS = ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "form", "input", "style", "svg", "math"];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

// "1. Choose a name: ..." becomes "1. **Choose a name:** ..." so list items scan by their label.
// Short labels only (up to six words, starting with a capital), never inside code fences.
const LEAD_IN_RE = /^(\s*(?:\d+[.)]|[-*+])\s+)([A-Z][^:*_`[\]\n]{0,58}?):(?=\s)/gm;

export function boldListLeadIns(text) {
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) => (i % 2 ? part : part.replace(LEAD_IN_RE, (match, marker, label) =>
      label.trim().split(/\s+/).length <= 6 ? `${marker}**${label}:**` : match)))
    .join("");
}

export function renderMarkdown(text) {
  if (!text) return "";
  text = boldListLeadIns(text);
  // ALLOW_DATA_ATTR: false — the app dispatches clicks by data-action, so a model-emitted
  // <button data-action="purge-history"> would otherwise become a working app control.
  return DOMPurify.sanitize(marked.parse(text), {
    FORBID_TAGS: [...FORBID_TAGS, "button", "textarea", "select"],
    FORBID_ATTR: ["style", "srcset", "id", "name"],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Automatic citation markers look like "[~S1]". Two of them in one paragraph would be read
 * by Markdown as ~strikethrough~ and strike out the text between them, so the tilde is
 * escaped before rendering; the citation decorator then sees "[~S1]" again in the HTML.
 */
export const escapeAutoCitations = (text) => (text || "").replace(/\[~(?=S\d)/g, "[\\~");

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}
