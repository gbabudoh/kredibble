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

export function renderMarkdown(text) {
  if (!text) return "";
  return DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS, FORBID_ATTR: ["style", "srcset"] });
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}
