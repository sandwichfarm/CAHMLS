import { nip19 } from "nostr-tools";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, test, vi } from "vitest";

import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";
import { KeyManager } from "../src/crypto/key-manager.js";
import {
  KEY_BACKUP_FORMAT,
  KeyStorage,
  PBKDF2_ITERATIONS,
  STORAGE_KEY,
  WrongPassphraseError,
  keyStorage,
  type KeyStorageBackend,
  type PersistedKeyBlob,
} from "../src/crypto/key-storage.js";

const template = { kind: 1, created_at: 1_700_000_000, tags: [], content: "hello" };

function memoryBackend(): KeyStorageBackend & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("BrowserNostrSigner", () => {
  test("derives the public key and produces events that verify", async () => {
    const secret = generateSecretKey();
    const signer = new BrowserNostrSigner(secret);

    await expect(signer.getPublicKey()).resolves.toBe(getPublicKey(secret));
    const signed = await signer.signEvent(template);
    expect(signed.pubkey).toBe(getPublicKey(secret));
    expect(verifyEvent(JSON.parse(JSON.stringify(signed)))).toBe(true);
  });

  test("keeps its own copy of the key so the caller can wipe theirs", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const signer = new BrowserNostrSigner(secret);

    secret.fill(0);

    const signed = await signer.signEvent(template);
    expect(signed.pubkey).toBe(pubkey);
    expect(verifyEvent(JSON.parse(JSON.stringify(signed)))).toBe(true);
  });

  test("NIP-44 traffic round trips between two signers and rejects tampering", async () => {
    const alice = new BrowserNostrSigner(generateSecretKey());
    const bob = new BrowserNostrSigner(generateSecretKey());

    const ciphertext = await alice.nip44.encrypt(await bob.getPublicKey(), "secret note");
    expect(ciphertext).not.toContain("secret note");
    await expect(bob.nip44.decrypt(await alice.getPublicKey(), ciphertext)).resolves.toBe("secret note");

    const eve = new BrowserNostrSigner(generateSecretKey());
    await expect(eve.nip44.decrypt(await alice.getPublicKey(), ciphertext)).rejects.toThrow();

    const flipped = `${ciphertext.slice(0, 20)}${ciphertext[20] === "A" ? "B" : "A"}${ciphertext.slice(21)}`;
    await expect(bob.nip44.decrypt(await alice.getPublicKey(), flipped)).rejects.toThrow();
  });

  test("destroy zeroes key material and refuses every private operation", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());
    const peer = new BrowserNostrSigner(generateSecretKey());
    const peerPubkey = await peer.getPublicKey();
    const ciphertext = await peer.nip44.encrypt(await signer.getPublicKey(), "note");
    const internal = (signer as unknown as { privateKey: Uint8Array }).privateKey;
    const publicKey = await signer.getPublicKey();

    signer.destroy();

    expect(internal.every((byte) => byte === 0)).toBe(true);
    await expect(signer.signEvent(template)).rejects.toThrow("Signer is no longer available");
    await expect(signer.nip44.encrypt(peerPubkey, "x")).rejects.toThrow("Signer is no longer available");
    await expect(signer.nip44.decrypt(peerPubkey, ciphertext)).rejects.toThrow("Signer is no longer available");
    // The public identity is not secret and stays readable for cleanup paths.
    await expect(signer.getPublicKey()).resolves.toBe(publicKey);
  });

  test("destroy is idempotent", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());
    signer.destroy();
    expect(() => signer.destroy()).not.toThrow();
    await expect(signer.signEvent(template)).rejects.toThrow("Signer is no longer available");
  });

  test("rejects an invalid private key at construction", () => {
    expect(() => new BrowserNostrSigner(new Uint8Array(32))).toThrow();
    expect(() => new BrowserNostrSigner(new Uint8Array(5).fill(1))).toThrow();
  });
});

describe("KeyManager", () => {
  test("fromBytes yields the identity of the supplied key and copies it", () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const hex = Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const manager = KeyManager.fromBytes(secret);

    secret.fill(0);

    expect(manager.identity).toEqual({ publicKeyHex: pubkey, npub: nip19.npubEncode(pubkey) });
    expect(manager.getSecretKeyHex()).toBe(hex);
  });

  test("getSecretKeyBytes hands out a copy that cannot corrupt the manager", () => {
    const manager = KeyManager.generate();
    const hex = manager.getSecretKeyHex();

    manager.getSecretKeyBytes().fill(0);

    expect(manager.getSecretKeyHex()).toBe(hex);
    expect(getPublicKey(manager.getSecretKeyBytes())).toBe(manager.identity.publicKeyHex);
  });

  test("generate produces distinct keys", () => {
    expect(KeyManager.generate().getSecretKeyHex()).not.toBe(KeyManager.generate().getSecretKeyHex());
  });

  test("destroy zeroes the key, blocks both accessors, and is idempotent", () => {
    const manager = KeyManager.generate();
    const internal = (manager as unknown as { secretKey: Uint8Array }).secretKey;
    const { publicKeyHex } = manager.identity;

    manager.destroy();
    manager.destroy();

    expect(internal.every((byte) => byte === 0)).toBe(true);
    expect(() => manager.getSecretKeyHex()).toThrow("Coordinator key has been destroyed");
    expect(() => manager.getSecretKeyBytes()).toThrow("Coordinator key has been destroyed");
    expect(manager.identity.publicKeyHex).toBe(publicKeyHex);
  });

  test("rejects an invalid secret key", () => {
    expect(() => KeyManager.fromBytes(new Uint8Array(32))).toThrow();
  });
});

describe("KeyStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("uses a supplied backend and leaves localStorage alone", async () => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);
    const secret = generateSecretKey();

    expect(storage.hasPersisted()).toBe(false);
    await storage.save(secret, "pass");

    expect(storage.hasPersisted()).toBe(true);
    expect(backend.values.has(STORAGE_KEY)).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await expect(storage.load("pass")).resolves.toEqual(secret);

    storage.clear();
    expect(backend.values.size).toBe(0);
  });

  test("the shared instance falls back to localStorage", async () => {
    localStorage.setItem(STORAGE_KEY, "{}");
    expect(keyStorage.hasPersisted()).toBe(true);
    keyStorage.clear();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("names the problem when no storage exists at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => new KeyStorage().hasPersisted()).toThrow("No key storage is available");
  });

  test("each save uses a fresh salt and IV and never stores the key in the clear", async () => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);
    const secret = generateSecretKey();
    const hex = Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join("");

    await storage.save(secret, "pass");
    const first = JSON.parse(backend.values.get(STORAGE_KEY)!) as PersistedKeyBlob;
    await storage.save(secret, "pass");
    const second = JSON.parse(backend.values.get(STORAGE_KEY)!) as PersistedKeyBlob;

    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(backend.values.get(STORAGE_KEY)).not.toContain(hex);
    expect(first.pbkdf2Iterations).toBe(PBKDF2_ITERATIONS);
  });

  test("load treats a missing or empty entry as a wrong passphrase", async () => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);

    await expect(storage.load("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
    backend.setItem(STORAGE_KEY, "");
    await expect(storage.load("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(storage.exportBackup("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("WrongPassphraseError is a named Error without key material", () => {
    const error = new WrongPassphraseError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WrongPassphraseError");
    expect(error.message).toBe("Wrong passphrase");
  });

  test.each<[string, (blob: PersistedKeyBlob) => unknown]>([
    ["an unsupported version", (blob) => ({ ...blob, version: 2 })],
    ["a weakened PBKDF2 iteration count", (blob) => ({ ...blob, pbkdf2Iterations: 1 })],
    ["a null blob", () => null],
  ])("load and export refuse %s", async (_label, mutate) => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);
    await storage.save(generateSecretKey(), "pass");
    const blob = JSON.parse(backend.values.get(STORAGE_KEY)!) as PersistedKeyBlob;
    backend.setItem(STORAGE_KEY, JSON.stringify(mutate(blob)));

    await expect(storage.load("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(storage.exportBackup("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("load refuses non-JSON and invalid base64 fields", async () => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);

    backend.setItem(STORAGE_KEY, "not json");
    await expect(storage.load("pass")).rejects.toBeInstanceOf(WrongPassphraseError);

    backend.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      pbkdf2Iterations: PBKDF2_ITERATIONS,
      salt: "!!!",
      iv: "!!!",
      ciphertext: "!!!",
    }));
    await expect(storage.load("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("AES-GCM authentication detects a tampered ciphertext, IV or salt", async () => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);
    await storage.save(generateSecretKey(), "pass");
    const original = JSON.parse(backend.values.get(STORAGE_KEY)!) as PersistedKeyBlob;
    const flip = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

    for (const field of ["ciphertext", "iv", "salt"] as const) {
      backend.setItem(STORAGE_KEY, JSON.stringify({ ...original, [field]: flip(original[field]) }));
      await expect(storage.load("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
    }
  });

  test("export refuses a blob that decrypts to something other than a valid key", async () => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);
    await storage.save(new Uint8Array(32), "pass");

    await expect(storage.load("pass")).resolves.toEqual(new Uint8Array(32));
    await expect(storage.exportBackup("pass")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("export reports the identity of the stored key and leaves storage unchanged", async () => {
    const backend = memoryBackend();
    const storage = new KeyStorage(backend);
    const secret = generateSecretKey();
    await storage.save(secret, "pass");
    const before = backend.values.get(STORAGE_KEY);

    const backup = await storage.exportBackup("pass");

    expect(backup.format).toBe(KEY_BACKUP_FORMAT);
    expect(backup.identity.publicKeyHex).toBe(getPublicKey(secret));
    expect(backup.identity.npub).toBe(nip19.npubEncode(getPublicKey(secret)));
    expect(backend.values.get(STORAGE_KEY)).toBe(before);
    // A backup keeps the passphrase requirement: it can be re-imported and reopened.
    const restored = memoryBackend();
    restored.setItem(STORAGE_KEY, JSON.stringify(backup.encryptedKey));
    await expect(new KeyStorage(restored).load("pass")).resolves.toEqual(secret);
    await expect(new KeyStorage(restored).load("other")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("non-ASCII passphrases work", async () => {
    const storage = new KeyStorage(memoryBackend());
    const secret = generateSecretKey();
    await storage.save(secret, "pässwörd 🔐");
    await expect(storage.load("pässwörd 🔐")).resolves.toEqual(secret);
    await expect(storage.load("passwhat")).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});
