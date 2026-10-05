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
  // ALLOW_DATA_ATTR: false — the app dispatches clicks by data-action, so a model-emitted
  // <button data-action="purge-history"> would otherwise become a working app control.
  return DOMPurify.sanitize(marked.parse(text), {
    FORBID_TAGS: [...FORBID_TAGS, "button", "textarea", "select"],
    FORBID_ATTR: ["style", "srcset", "id", "name"],
    ALLOW_DATA_ATTR: false,
  });
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}
