// localStorage that never throws (private mode, blocked storage): preferences only, never chats.
export const storage = {
  get(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  },
};
