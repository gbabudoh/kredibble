// IndexedDB persistence for chat threads and answer feedback.
// Records are plaintext unless the user sets a passphrase (core/vault.js); then every record
// is sealed with AES-GCM except its id and updatedAt.
import { isSealed } from "./vault.js";

const DB_NAME = "KredibbleChatDB";
const DB_VERSION = 3; // v3 adds the "feedback" store

let cipher = null; // { seal, open } while a vault is unlocked

/** Sets (or clears, with null) the cipher used for all reads and writes. */
export function setCipher(next) {
  cipher = next;
}

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("threads")) db.createObjectStore("threads", { keyPath: "id" });
      if (!db.objectStoreNames.contains("feedback")) db.createObjectStore("feedback", { keyPath: "id" });
    };
  });
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], mode);
    const request = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// Encryption happens before the transaction opens: IndexedDB transactions auto-commit
// as soon as the code awaits anything that is not an IndexedDB request.
const seal = (record) => (cipher ? cipher.seal(record) : record);

async function readAll(store) {
  const stored = (await run(store, "readonly", (s) => s.getAll())) || [];
  const out = [];
  for (const record of stored) {
    if (!isSealed(record)) out.push(record);
    else if (cipher) out.push(await cipher.open(record));
    // Sealed records stay unreadable while the vault is locked.
  }
  return out;
}

async function writeAll(store, records) {
  const sealed = await Promise.all(records.map(seal));
  return run(store, "readwrite", (s) => { for (const r of sealed) s.put(r); });
}

/** True if any stored record is encrypted (so the app must ask for the passphrase). */
export async function hasSealedRecords() {
  for (const store of ["threads", "feedback"]) {
    const stored = (await run(store, "readonly", (s) => s.getAll())) || [];
    if (stored.some(isSealed)) return true;
  }
  return false;
}

export const ThreadStore = {
  async all() {
    try {
      const list = await readAll("threads");
      return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (err) {
      console.warn("Thread load failed:", err);
      return [];
    }
  },
  async save(thread) {
    thread.updatedAt = new Date().toISOString();
    try {
      const record = await seal(thread);
      await run("threads", "readwrite", (s) => s.put(record));
    } catch (err) {
      console.warn("Thread save failed:", err);
    }
  },
  /** Re-writes every thread with the current cipher (used when a passphrase is set or removed). */
  rewriteAll(threads) {
    return writeAll("threads", threads);
  },
  remove(id) {
    return run("threads", "readwrite", (s) => s.delete(id)).catch((err) => console.warn("Thread delete failed:", err));
  },
  clear() {
    return run("threads", "readwrite", (s) => s.clear());
  },
};

export const FeedbackStore = {
  async all() {
    try {
      return await readAll("feedback");
    } catch (err) {
      console.warn("Feedback load failed:", err);
      return [];
    }
  },
  async save(record) {
    const stored = await seal(record);
    return run("feedback", "readwrite", (s) => s.put(stored));
  },
  rewriteAll(records) {
    return writeAll("feedback", records);
  },
  remove(id) {
    return run("feedback", "readwrite", (s) => s.delete(id));
  },
  clear() {
    return run("feedback", "readwrite", (s) => s.clear());
  },
};
