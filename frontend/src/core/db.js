// IndexedDB persistence for chat threads and answer feedback. Data is stored in plaintext
// in this browser profile; encryption at rest is a planned follow-up.
const DB_NAME = "KredibbleChatDB";
const DB_VERSION = 3; // v3 adds the "feedback" store

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

export const ThreadStore = {
  async all() {
    try {
      const list = (await run("threads", "readonly", (s) => s.getAll())) || [];
      return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (err) {
      console.warn("Thread load failed:", err);
      return [];
    }
  },
  save(thread) {
    thread.updatedAt = new Date().toISOString();
    return run("threads", "readwrite", (s) => s.put(thread)).catch((err) => console.warn("Thread save failed:", err));
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
      return (await run("feedback", "readonly", (s) => s.getAll())) || [];
    } catch (err) {
      console.warn("Feedback load failed:", err);
      return [];
    }
  },
  save(record) {
    return run("feedback", "readwrite", (s) => s.put(record));
  },
  remove(id) {
    return run("feedback", "readwrite", (s) => s.delete(id));
  },
  clear() {
    return run("feedback", "readwrite", (s) => s.clear());
  },
};
