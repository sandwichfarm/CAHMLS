import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";

export const STORAGE_KEY = "cordn:v1:persistence";
export const PBKDF2_ITERATIONS = 600_000;
export const KEY_BACKUP_FORMAT = "cordn.coordinator-key-backup";
export const KEY_BACKUP_VERSION = 1;

export interface PersistedKeyBlob {
  version: 1;
  pbkdf2Iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface CoordinatorKeyBackup {
  format: typeof KEY_BACKUP_FORMAT;
  version: typeof KEY_BACKUP_VERSION;
  exportedAt: string;
  identity: {
    publicKeyHex: string;
    npub: string;
  };
  crypto: {
    kdf: {
      name: "PBKDF2";
      hash: "SHA-256";
    };
    cipher: {
      name: "AES-GCM";
      keyLength: 256;
    };
  };
  encryptedKey: PersistedKeyBlob;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase");
    this.name = "WrongPassphraseError";
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey("raw", toArrayBuffer(passphraseBytes), "PBKDF2", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function parsePersistedBlob(raw: string): PersistedKeyBlob {
  const blob = JSON.parse(raw) as PersistedKeyBlob;
  if (blob.version !== 1 || blob.pbkdf2Iterations !== PBKDF2_ITERATIONS) {
    throw new Error("Unsupported persisted key format");
  }

  return {
    version: blob.version,
    pbkdf2Iterations: blob.pbkdf2Iterations,
    salt: blob.salt,
    iv: blob.iv,
    ciphertext: blob.ciphertext,
  };
}

async function decryptPersistedBlob(blob: PersistedKeyBlob, passphrase: string): Promise<Uint8Array> {
  const salt = base64UrlToBytes(blob.salt);
  const iv = base64UrlToBytes(blob.iv);
  const key = await deriveKey(passphrase, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(base64UrlToBytes(blob.ciphertext)),
  );

  return new Uint8Array(decrypted);
}

export class KeyStorage {
  hasPersisted(): boolean {
    return localStorage.getItem(STORAGE_KEY) !== null;
  }

  async save(secretKey: Uint8Array, passphrase: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(secretKey),
    );

    const blob: PersistedKeyBlob = {
      version: 1,
      pbkdf2Iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64Url(salt),
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  }

  async load(passphrase: string): Promise<Uint8Array> {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      throw new WrongPassphraseError();
    }

    try {
      return await decryptPersistedBlob(parsePersistedBlob(raw), passphrase);
    } catch (error) {
      if (error instanceof WrongPassphraseError) {
        throw error;
      }

      throw new WrongPassphraseError();
    }
  }

  async exportBackup(passphrase: string): Promise<CoordinatorKeyBackup> {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      throw new WrongPassphraseError();
    }

    let decryptedKey: Uint8Array | undefined;
    try {
      const encryptedKey = parsePersistedBlob(raw);
      decryptedKey = await decryptPersistedBlob(encryptedKey, passphrase);
      const publicKeyHex = getPublicKey(decryptedKey);

      return {
        format: KEY_BACKUP_FORMAT,
        version: KEY_BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        identity: {
          publicKeyHex,
          npub: nip19.npubEncode(publicKeyHex),
        },
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
        encryptedKey,
      };
    } catch (error) {
      if (error instanceof WrongPassphraseError) {
        throw error;
      }

      throw new WrongPassphraseError();
    } finally {
      decryptedKey?.fill(0);
    }
  }

  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export const keyStorage = new KeyStorage();
