// Opt-in anonymous metrics. Off by default. Events are built only from enums and numbers
// (task, verification status, issue kinds, rating, reason codes, model id, latency) and the
// server rejects anything else (backend/app/routers/metrics.py), so no text can leave the device.
import registry from "../registry/registry.json";

const KEY = "kredibble_metrics";
const INTENTS = new Set(["chat", "qa", "summary", "extract", "compliance", "general"]);
const STATUSES = new Set(["grounded", "warning", "abstained", "general", "none"]);

export const metricsEnabled = () => {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
};

export const setMetricsEnabled = (on) => {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* private mode */ }
};

/** Builds the event from message metadata only. Exported so the UI can show exactly what is sent. */
export function buildEvent(kind, message, { latencyMs = 0, rating = null, reasons = [] } = {}) {
  const meta = message.meta || {};
  const intent = meta.route?.intent || (meta.doc ? "qa" : "chat");
  const status = meta.verification?.status || "none";
  const event = {
    kind,
    intent: INTENTS.has(intent) ? intent : "chat",
    status: STATUSES.has(status) ? status : "none",
    issues: [...new Set((meta.verification?.issues || []).map((i) => i.kind))].slice(0, 8),
    model: (meta.model || "unknown").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "unknown",
    registry_version: registry.version,
    latency_ms: Math.max(0, Math.min(3_600_000, Math.round(latencyMs))),
  };
  if (typeof meta.tokensPerSec === "number") event.tokens_per_sec = Math.min(10_000, Math.max(0, meta.tokensPerSec));
  if (kind === "feedback") {
    event.rating = rating;
    event.reasons = reasons.slice(0, 6);
  }
  return event;
}

let lastSent = null;
export const lastEvent = () => lastSent;

/** Fire-and-forget; does nothing unless the user opted in. */
export function sendEvent(event) {
  if (!metricsEnabled()) return;
  lastSent = event;
  fetch("/api/v1/metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event), keepalive: true })
    .catch(() => { /* metrics are best-effort */ });
}
