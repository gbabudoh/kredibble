// Optional passphrase lock for data stored in this browser (chat threads, feedback).
//
// Key: PBKDF2-SHA256 (600,000 iterations, random 16-byte salt) -> AES-GCM-256, created
// non-extractable and kept in memory only. Locking, reloading or closing the tab discards
// it, so the records on disk cannot be read without the passphrase. A stored key would sit
// on disk beside the data it protects, which is why there is no "remember me".
//
// What it protects against: someone reading the browser profile or a disk image, other OS
// users, a stolen unencrypted laptop. What it does not: malware running in the browser while
// the vault is unlocked. A forgotten passphrase cannot be recovered; the data is lost.

export const PBKDF2_ITERATIONS = 600_000;
const CHECK_PLAINTEXT = "kredibble-vault-v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

export async function encryptJSON(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** Throws if the key is wrong or the ciphertext was modified (GCM authentication). */
export async function decryptJSON(key, sealed) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv) }, key, fromB64(sealed.ct));
  return JSON.parse(dec.decode(pt));
}

export const MIN_PASSPHRASE_LENGTH = 10;

/** Creates a vault. Returns the non-secret config to persist and the in-memory key. */
export async function createVault(passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if ((passphrase || "").length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, iterations);
  const config = { version: 1, salt: toB64(salt), iterations, check: await encryptJSON(key, CHECK_PLAINTEXT) };
  return { config, key };
}

/** Returns the key if the passphrase is right, otherwise null. */
export async function unlockVault(passphrase, config) {
  const key = await deriveKey(passphrase, fromB64(config.salt), config.iterations);
  try {
    return (await decryptJSON(key, config.check)) === CHECK_PLAINTEXT ? key : null;
  } catch {
    return null;
  }
}

/**
 * Store cipher: seals a record so only `id` and `updatedAt` (needed for keys and ordering)
 * stay readable; everything else, including thread titles, is encrypted.
 */
export function recordCipher(key) {
  return {
    async seal(record) {
      const { id, updatedAt, ...rest } = record;
      return { id, updatedAt, sealed: await encryptJSON(key, rest) };
    },
    async open(stored) {
      if (!stored?.sealed) return stored;
      const { id, updatedAt, sealed } = stored;
      return { id, updatedAt, ...(await decryptJSON(key, sealed)) };
    },
  };
}

export const isSealed = (stored) => Boolean(stored?.sealed);
