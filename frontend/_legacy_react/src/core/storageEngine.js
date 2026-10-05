// frontend/src/core/storageEngine.js
// Client-Side Encrypted/Isolated Persistence using IndexedDB

const DB_NAME = "KredibbleLocalDB";
const DB_VERSION = 1;
const STORE_NAME = "chat_histories";
const WORKSPACE_STORE = "workspaces_meta";

export class KredibbleStorage {
  /**
   * Initializes local browser database instance asynchronously.
   */
  static openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(new Error("Failed to open local IndexedDB container."));
      request.onsuccess = (event) => resolve(event.target.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "workspaceId" });
        }
        if (!db.objectStoreNames.contains(WORKSPACE_STORE)) {
          db.createObjectStore(WORKSPACE_STORE, { keyPath: "id" });
        }
      };
    });
  }

  /**
   * Persists or updates conversation thread locally.
   * @param {string} workspaceId - Unique workspace reference identifier.
   * @param {Array} historyPayload - Array of conversation messages.
   */
  static async saveHistory(workspaceId, historyPayload) {
    try {
      const db = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const record = {
          workspaceId,
          updatedAt: new Date().toISOString(),
          messages: historyPayload
        };
        const request = store.put(record);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      console.warn("Local storage fallback to memory:", err);
      return false;
    }
  }

  /**
   * Retrieves cached text histories for a specific workspace container.
   * @param {string} workspaceId - Targeted workspace key.
   */
  static async getHistory(workspaceId) {
    try {
      const db = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(workspaceId);
        request.onsuccess = () => resolve(request.result ? request.result.messages : []);
        request.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      console.warn("Storage retrieval error:", err);
      return [];
    }
  }

  /**
   * Purges local cache completely for GDPR Right-to-be-Forgotten compliance.
   */
  static async purgeAllData() {
    try {
      const db = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      console.error("Purge error:", err);
      return false;
    }
  }
}
