// Plan limits. The server is the source of truth (backend/app/plans.py, sent by /account/me);
// this file covers the cases without it and counts guests' messages on this device.
import { storage } from "./storage.js";

/** No account database (self-hosted / offline): no plans, nothing locked. */
export const UNLIMITED = {
  plan: "unlimited",
  daily_messages: null,
  workspaces: null, // null: every workspace
  documents: true,
  max_documents: null,
  max_document_pages: null,
  large_models: true,
  save_history: true,
  passphrase_lock: true,
  pii_scan: true,
  pii_redaction: true,
  checklists: true,
};

export const PLAN_LABELS = { guest: "Guest", free: "Free", pro: "Pro", business: "Business", enterprise: "Enterprise", unlimited: "" };

/** Models every plan may use (keys from engine/models.js); larger ones need Pro or above. */
export const SMALL_MODEL_KEYS = ["qwen2.5-1.5b", "llama3.2-1b"];

export const canUseWorkspace = (ent, id) => !ent.workspaces || ent.workspaces.includes(id);
export const canUseModel = (ent, key) => ent.large_models || SMALL_MODEL_KEYS.includes(key);

/** The plan that unlocks a workspace, as a short label for a lock badge. */
export function workspaceUnlockLabel(ent, persona) {
  if (ent.plan === "guest") return "Sign up";
  return persona.deliveryMethod.startsWith("In-browser") ? "Pro" : "Business";
}

/** The browser's IANA time zone, so daily limits reset at the user's own midnight. */
export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Signed-out message count, kept in this browser for the current local day. */
export const GuestCounter = {
  used() {
    const record = storage.get("kredibble_guest_usage", null);
    try {
      const { day, used } = JSON.parse(record);
      return day === today() ? used : 0;
    } catch {
      return 0;
    }
  },
  take() {
    const used = this.used() + 1;
    storage.set("kredibble_guest_usage", JSON.stringify({ day: today(), used }));
    return used;
  },
};
