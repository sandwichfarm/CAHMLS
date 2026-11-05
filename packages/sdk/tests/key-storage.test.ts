import { nip19 } from "nostr-tools";
import { beforeEach, describe, expect, test } from "vitest";

import { KeyManager } from "../src/crypto/key-manager.js";
import {
  KEY_BACKUP_FORMAT,
  KEY_BACKUP_VERSION,
  KeyStorage,
  PBKDF2_ITERATIONS,
  STORAGE_KEY,
  WrongPassphraseError,
} from "../src/crypto/key-storage.js";

describe("KeyStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("encrypts and decrypts key material with PBKDF2 and AES-GCM", async () => {
    const storage = new KeyStorage();
    const key = KeyManager.generate().getSecretKeyBytes();

    await storage.save(key, "correct horse battery staple");

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toEqual(expect.any(String));
    expect(raw).not.toContain(KeyManager.fromBytes(key).getSecretKeyHex());
    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      version: 1,
      pbkdf2Iterations: PBKDF2_ITERATIONS,
    });

    await expect(storage.load("correct horse battery staple")).resolves.toEqual(key);
  });

  test("throws a named error for wrong passphrases", async () => {
    const storage = new KeyStorage();

    await storage.save(KeyManager.generate().getSecretKeyBytes(), "right-passphrase");

    await expect(storage.load("wrong-passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("exports the persisted encrypted key after verifying the current passphrase", async () => {
    const storage = new KeyStorage();
    const keyManager = KeyManager.generate();
    const key = keyManager.getSecretKeyBytes();

    await storage.save(key, "current-passphrase");
    const persisted = localStorage.getItem(STORAGE_KEY);

    const backup = await storage.exportBackup("current-passphrase");
    expect(backup.identity).toEqual(keyManager.identity);
    expect(backup.encryptedKey).toEqual(JSON.parse(persisted ?? "{}"));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(persisted);

    keyManager.destroy();
  });

  test("rejects backup export when the current passphrase is wrong", async () => {
    const storage = new KeyStorage();

    await storage.save(KeyManager.generate().getSecretKeyBytes(), "current-passphrase");

    await expect(storage.exportBackup("wrong-passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("rejects backup export when no encrypted key is persisted", async () => {
    const storage = new KeyStorage();

    await expect(storage.exportBackup("any-passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("rejects malformed persisted data instead of exporting it", async () => {
    const storage = new KeyStorage();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, ciphertext: "not-a-key" }));

    await expect(storage.exportBackup("any-passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("includes versioned, JSON-serializable identity and crypto metadata", async () => {
    const storage = new KeyStorage();
    const keyManager = KeyManager.generate();

    await storage.save(keyManager.getSecretKeyBytes(), "passphrase");

    const backup = await storage.exportBackup("passphrase");
    expect(backup).toMatchObject({
      format: KEY_BACKUP_FORMAT,
      version: KEY_BACKUP_VERSION,
      identity: keyManager.identity,
      crypto: {
        kdf: {
          name: "PBKDF2",
          hash: "SHA-256",
        },
        cipher: {
          name: "AES-GCM",
          keyLength: 256,
        },
      },
      encryptedKey: {
        version: 1,
        pbkdf2Iterations: PBKDF2_ITERATIONS,
      },
    });
    expect(new Date(backup.exportedAt).toISOString()).toBe(backup.exportedAt);
    expect(JSON.parse(JSON.stringify(backup))).toEqual(backup);

    keyManager.destroy();
  });

  test("never includes the raw secret key or nsec in an exported backup", async () => {
    const storage = new KeyStorage();
    const keyManager = KeyManager.generate();
    const secretKey = keyManager.getSecretKeyBytes();
    const secretKeyHex = keyManager.getSecretKeyHex();
    const nsec = nip19.nsecEncode(secretKey);

    await storage.save(secretKey, "passphrase");

    const serialized = JSON.stringify(await storage.exportBackup("passphrase"));
    expect(serialized).not.toContain(secretKeyHex);
    expect(serialized).not.toContain(nsec);
    expect(serialized).not.toContain('"secretKey"');
    expect(serialized).not.toContain('"nsec"');

    secretKey.fill(0);
    keyManager.destroy();
  });

  test("clears the single persisted storage entry synchronously", async () => {
    const storage = new KeyStorage();

    await storage.save(KeyManager.generate().getSecretKeyBytes(), "passphrase");
    expect(storage.hasPersisted()).toBe(true);

    storage.clear();

    expect(storage.hasPersisted()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
