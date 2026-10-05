// IndexedDB persistence for chat threads. Data is stored in plaintext in this
// browser profile; encryption at rest is a planned follow-up.
const DB_NAME = "KredibbleChatDB";
const DB_VERSION = 2;
const STORE = "threads";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE], mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const ThreadStore = {
  async all() {
    try {
      const list = (await run("readonly", (s) => s.getAll())) || [];
      return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (err) {
      console.warn("Thread load failed:", err);
      return [];
    }
  },
  save(thread) {
    thread.updatedAt = new Date().toISOString();
    return run("readwrite", (s) => s.put(thread)).catch((err) => console.warn("Thread save failed:", err));
  },
  remove(id) {
    return run("readwrite", (s) => s.delete(id)).catch((err) => console.warn("Thread delete failed:", err));
  },
  clear() {
    return run("readwrite", (s) => s.clear());
  },
};
