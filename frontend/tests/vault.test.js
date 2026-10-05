import { describe, expect, it } from "vitest";
import { createVault, decryptJSON, encryptJSON, isSealed, recordCipher, unlockVault, PBKDF2_ITERATIONS } from "../src/core/vault.js";

// Fewer iterations keep the suite fast; production uses PBKDF2_ITERATIONS.
const FAST = { iterations: 1_000 };
const thread = { id: "thread-1", updatedAt: "2026-10-05T10:00:00Z", title: "Liability cap?", messages: [{ role: "user", content: "What is the liability cap for Acme Ltd?" }] };

describe("vault", () => {
  it("uses the OWASP-recommended PBKDF2-SHA256 work factor by default", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });

  it("unlocks only with the right passphrase", async () => {
    const { config } = await createVault("correct horse battery", FAST);
    expect(await unlockVault("correct horse battery", config)).not.toBeNull();
    expect(await unlockVault("wrong passphrase!", config)).toBeNull();
    expect(JSON.stringify(config)).not.toContain("correct horse");
  });

  it("rejects short passphrases", async () => {
    await expect(createVault("short", FAST)).rejects.toThrow(/at least 10/);
  });

  it("seals everything except id and updatedAt, and round-trips", async () => {
    const { key } = await createVault("correct horse battery", FAST);
    const cipher = recordCipher(key);
    const stored = await cipher.seal(thread);
    expect(Object.keys(stored)).toEqual(["id", "updatedAt", "sealed"]);
    expect(isSealed(stored)).toBe(true);
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain("Acme");
    expect(raw).not.toContain("Liability");
    expect(await cipher.open(stored)).toEqual(thread);
  });

  it("uses a fresh IV per record and detects tampering", async () => {
    const { key } = await createVault("correct horse battery", FAST);
    const a = await encryptJSON(key, { x: 1 });
    const b = await encryptJSON(key, { x: 1 });
    expect(a.iv).not.toBe(b.iv);
    const tampered = { ...a, ct: a.ct.slice(0, -4) + (a.ct.endsWith("AAAA") ? "BBBB" : "AAAA") };
    await expect(decryptJSON(key, tampered)).rejects.toThrow();
  });

  it("cannot open records with another vault's key", async () => {
    const one = await createVault("correct horse battery", FAST);
    const two = await createVault("another long passphrase", FAST);
    const stored = await recordCipher(one.key).seal(thread);
    await expect(recordCipher(two.key).open(stored)).rejects.toThrow();
  });

  it("passes plaintext records through unchanged (before a vault is set up)", async () => {
    const { key } = await createVault("correct horse battery", FAST);
    expect(await recordCipher(key).open(thread)).toBe(thread);
  });
});
