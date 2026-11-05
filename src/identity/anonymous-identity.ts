import { generateSecretKey } from "nostr-tools";

import { BrowserNostrSigner } from "@cahmls/sdk/crypto";

export const ANONYMOUS_IDENTITY_STORAGE_KEY = "cordn:v1:anonymous-identity";

interface AnonymousIdentityRecord {
  version: 1;
  secretKeyHex: string;
}

export type AnonymousIdentityLoadResult =
  | { state: "absent" }
  | { state: "corrupt" }
  | { state: "ready"; signer: BrowserNostrSigner; pubkey: string };

export interface PreparedAnonymousIdentity {
  signer: BrowserNostrSigner;
  pubkey: string;
  commit: () => boolean;
  abort: () => void;
}

export async function loadAnonymousIdentity(): Promise<AnonymousIdentityLoadResult> {
  const storage = browserStorage();
  if (!storage) return { state: "corrupt" };

  let raw: string | null;
  try {
    raw = storage.getItem(ANONYMOUS_IDENTITY_STORAGE_KEY);
  } catch {
    return { state: "corrupt" };
  }
  if (raw === null) return { state: "absent" };

  const secretKey = parseSecretKey(raw);
  if (!secretKey) return { state: "corrupt" };
  try {
    const signer = new BrowserNostrSigner(secretKey);
    const pubkey = await signer.getPublicKey();
    return { state: "ready", signer, pubkey };
  } catch {
    return { state: "corrupt" };
  } finally {
    secretKey.fill(0);
  }
}

export async function createAnonymousIdentity(): Promise<AnonymousIdentityLoadResult> {
  const prepared = await prepareAnonymousIdentityReplacement();
  if (prepared.commit()) return { state: "ready", signer: prepared.signer, pubkey: prepared.pubkey };
  prepared.abort();
  return { state: "corrupt" };
}

export async function prepareAnonymousIdentityReplacement(): Promise<PreparedAnonymousIdentity> {
  const candidateSecretKey = generateSecretKey();
  const signer = new BrowserNostrSigner(candidateSecretKey);
  const pubkey = await signer.getPublicKey();
  let settled = false;

  return {
    signer,
    pubkey,
    commit: () => {
      if (settled) return false;
      const storage = browserStorage();
      if (!storage) return false;
      try {
        const record = JSON.stringify({ version: 1, secretKeyHex: bytesToHex(candidateSecretKey) });
        storage.setItem(ANONYMOUS_IDENTITY_STORAGE_KEY, record);
        const verifiedSecretKey = parseSecretKey(storage.getItem(ANONYMOUS_IDENTITY_STORAGE_KEY) ?? "");
        if (!verifiedSecretKey) return false;
        verifiedSecretKey.fill(0);
        settled = true;
        candidateSecretKey.fill(0);
        return true;
      } catch {
        return false;
      }
    },
    abort: () => {
      if (!settled) candidateSecretKey.fill(0);
      settled = true;
      signer.destroy();
    },
  };
}

function parseSecretKey(raw: string): Uint8Array | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isValidRecord(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = value.secretKeyHex.slice(index * 2, index * 2 + 2);
    const byte = Number.parseInt(pair, 16);
    if (!Number.isInteger(byte)) {
      bytes.fill(0);
      return null;
    }
    bytes[index] = byte;
  }
  return bytes;
}

function isValidRecord(value: unknown): value is AnonymousIdentityRecord {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  return value.version === 1
    && typeof value.secretKeyHex === "string"
    && /^[a-fA-F0-9]{64}$/.test(value.secretKeyHex);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserStorage(): Storage | null {
  return "localStorage" in globalThis ? globalThis.localStorage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
