import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NostrConnectSigner } from "applesauce-signers/signers";
import { generateSecretKey, getPublicKey } from "nostr-tools";

const signerMocks = vi.hoisted(() => ({
  getPublicKey: vi.fn<() => Promise<string>>(),
}));

vi.mock("applesauce-signers/signers", () => ({
  ExtensionSigner: class {
    async getPublicKey(): Promise<string> {
      return signerMocks.getPublicKey();
    }
  },
  NostrConnectSigner: class {},
}));

vi.mock("nostr-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("nostr-tools")>()),
  SimplePool: class {
    async querySync(): Promise<[]> {
      return [];
    }

    destroy(): void {}
  },
}));

import {
  ANONYMOUS_IDENTITY_RECOVERY_STORAGE_KEY,
  createPubkeyAvatar,
  NIP46_CONNECT_RELAYS,
  parseKindZero,
  PROFILE_RELAYS,
  UserProfileStore,
} from "../../src/identity/user-profile.svelte";
import {
  ANONYMOUS_IDENTITY_STORAGE_KEY,
  prepareAnonymousIdentityReplacement,
} from "../../src/identity/anonymous-identity";
import * as anonymousIdentity from "../../src/identity/anonymous-identity";
import { BrowserNostrSigner } from "../../src/crypto/browser-nostr-signer";
import { loadRoom, ROOMS_CHANGED_EVENT, saveRoom, type StoredRoom } from "../../src/chat/room-store";

const NIP07_SESSION_STORAGE_KEY = "cordn:v1:nip07-session";
const NIP07_PUBKEY = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
const NIP46_PUBKEY = "4646464646464646464646464646464646464646464646464646464646464646";

function anonymousRoom(stablePubkey: string, coordinatorPubkey = "a".repeat(64)): StoredRoom {
  return {
    version: 1,
    id: "rotation-room",
    title: "Rotation room",
    coordinatorPubkey,
    relayUrls: ["wss://relay.example"],
    name: "River",
    stablePubkey,
    identityOwner: "anonymous",
    stateBase64: "",
    keyPackage: { reference: "rotation-key", publicBase64: "", privateBase64: "private" },
    lastCursor: 0,
    messages: [{ type: "message", id: "cached", sender: coordinatorPubkey, name: "Host", content: "Preserve history", createdAt: 1 }],
    pending: [],
    isHost: false,
    anonymousSecretKey: "00".repeat(32),
    inviteToken: "invite-authority",
  };
}

describe("user profile helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "nostr", { configurable: true, value: {} });
    signerMocks.getPublicKey.mockReset();
    signerMocks.getPublicKey.mockResolvedValue(NIP07_PUBKEY);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nostr");
  });

  test("uses the requested profile relays", () => {
    expect(PROFILE_RELAYS).toEqual(["wss://purplepag.es", "wss://relay.damus.io"]);
  });

  test("uses the Coracle bucket relay for NIP-46 connection requests", () => {
    expect(NIP46_CONNECT_RELAYS).toEqual(["wss://bucket.coracle.social"]);
  });

  test("parses supported kind 0 fields and ignores invalid metadata", () => {
    expect(parseKindZero(JSON.stringify({
      name: "river",
      display_name: "River",
      picture: "https://example.test/avatar.png",
      nip05: "river@example.test",
      ignored: 42,
    }))).toEqual({
      name: "river",
      display_name: "River",
      picture: "https://example.test/avatar.png",
      nip05: "river@example.test",
    });
    expect(parseKindZero("{not-json")).toBeNull();
  });

  test("creates stable, pubkey-specific local avatar images", () => {
    const first = createPubkeyAvatar("aa11bb22cc33dd44");
    expect(first).toBe(createPubkeyAvatar("aa11bb22cc33dd44"));
    expect(first).not.toBe(createPubkeyAvatar("ff11bb22cc33dd44"));
    expect(first.startsWith("data:image/svg+xml,")).toBe(true);
  });

  test("creates and reloads one durable anonymous identity while keeping the display name separate", async () => {
    const store = new UserProfileStore();
    expect(store.initialized).toBe(false);
    expect(store.hasIdentity).toBe(false);

    await store.initialize("River");
    expect(store.initialized).toBe(true);
    expect(store.method).toBe("anonymous");
    expect(store.status).toBe("ready");
    expect(store.activeSigner).not.toBeNull();

    const firstPubkey = store.pubkey;
    const firstAvatar = store.avatarUrl;
    const record = JSON.parse(localStorage.getItem(ANONYMOUS_IDENTITY_STORAGE_KEY) ?? "null") as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["secretKeyHex", "version"]);
    expect(record.version).toBe(1);
    expect(typeof record.secretKeyHex).toBe("string");

    const reloaded = new UserProfileStore();
    await reloaded.initialize("River");
    expect(reloaded.pubkey).toBe(firstPubkey);
    expect(reloaded.avatarUrl).toBe(firstAvatar);
    expect(reloaded.displayName).toBe("River");
  });

  test("memoizes anonymous initialization without coordinator identity input", async () => {
    const store = new UserProfileStore();

    const initial = store.initialize("River");
    const afterUnlock = store.initialize("Other");

    expect(afterUnlock).toBe(initial);
    await initial;
    expect(store.initialized).toBe(true);
    expect(store.method).toBe("anonymous");
    expect(store.displayName).toBe("River");
    expect(store.hasIdentity).toBe(true);
  });

  test("memoizes initialization and restores a stored NIP-07 session at most once", async () => {
    localStorage.setItem(NIP07_SESSION_STORAGE_KEY, JSON.stringify({ version: 1, method: "nip07" }));
    const store = new UserProfileStore();

    const first = store.initialize("River");
    const second = store.initialize("Other");
    expect(second).toBe(first);

    await Promise.all([first, second]);
    expect(signerMocks.getPublicKey).toHaveBeenCalledTimes(1);
    expect(store.initialized).toBe(true);
    expect(store.method).toBe("nip07");
    expect(store.pubkey).toBe(NIP07_PUBKEY);
  });

  test("falls back to a ready anonymous identity when NIP-07 restoration fails", async () => {
    localStorage.setItem(NIP07_SESSION_STORAGE_KEY, JSON.stringify({ version: 1, method: "nip07" }));
    signerMocks.getPublicKey.mockRejectedValueOnce(new Error("Extension denied access"));
    const store = new UserProfileStore();

    await store.initialize("River");

    expect(store.initialized).toBe(true);
    expect(store.hasIdentity).toBe(true);
    expect(store.method).toBe("anonymous");
    expect(store.activeSigner).not.toBeNull();
    expect(store.displayName).toBe("River");
    expect(store.status).toBe("ready");
    expect(store.error).toBe("");
  });

  test("restores a selected NIP-07 session when the extension injects shortly after bootstrap", async () => {
    localStorage.setItem(NIP07_SESSION_STORAGE_KEY, JSON.stringify({ version: 1, method: "nip07" }));
    Reflect.deleteProperty(window, "nostr");
    const store = new UserProfileStore();
    const initialized = store.initialize("River");

    window.setTimeout(() => {
      Object.defineProperty(window, "nostr", { configurable: true, value: {} });
    }, 5);

    await initialized;
    expect(store.method).toBe("nip07");
    expect(store.pubkey).toBe(NIP07_PUBKEY);
  });

  test("restores a selected NIP-07 session in a new store", async () => {
    const signedIn = new UserProfileStore();
    await signedIn.connectNip07();
    expect(localStorage.getItem(NIP07_SESSION_STORAGE_KEY)).toBe(JSON.stringify({ version: 1, method: "nip07" }));

    const reloaded = new UserProfileStore();
    await reloaded.initialize("River");
    expect(reloaded.initialized).toBe(true);
    expect(reloaded.method).toBe("nip07");
    expect(reloaded.pubkey).toBe(NIP07_PUBKEY);
  });

  test("keeps the initialized anonymous identity without a prior NIP-07 selection", async () => {
    const reloaded = new UserProfileStore();
    await reloaded.initialize("River");
    expect(reloaded.initialized).toBe(true);
    expect(reloaded.hasIdentity).toBe(true);
    expect(reloaded.method).toBe("anonymous");
    expect(reloaded.activeSigner).not.toBeNull();
  });

  test("ignores a malformed NIP-07 session marker", async () => {
    localStorage.setItem(NIP07_SESSION_STORAGE_KEY, JSON.stringify({ version: 2, method: "nip07" }));
    const reloaded = new UserProfileStore();
    await reloaded.initialize("River");
    expect(reloaded.initialized).toBe(true);
    expect(reloaded.hasIdentity).toBe(true);
    expect(reloaded.method).toBe("anonymous");
    expect(reloaded.activeSigner).not.toBeNull();
  });

  test("does not replace an active NIP-46 identity during initialization", async () => {
    const remoteSigner = {
      getPublicKey: vi.fn().mockResolvedValue(NIP46_PUBKEY),
    } as unknown as NostrConnectSigner;
    const store = new UserProfileStore();
    await store.adoptNip46(remoteSigner);

    await store.initialize("River");

    expect(store.initialized).toBe(true);
    expect(store.method).toBe("nip46");
    expect(store.pubkey).toBe(NIP46_PUBKEY);
    expect(store.activeSigner).toBe(remoteSigner);
  });

  test("clears a selected NIP-07 session on logout", async () => {
    const signedIn = new UserProfileStore();
    await signedIn.connectNip07();
    await signedIn.logout();
    expect(localStorage.getItem(NIP07_SESSION_STORAGE_KEY)).toBeNull();
  });

  test.each([
    "{",
    JSON.stringify({ version: 2, secretKeyHex: "00".repeat(32) }),
    JSON.stringify({ version: 1, secretKeyHex: "z".repeat(64) }),
    JSON.stringify({ version: 1, secretKeyHex: "00".repeat(31) }),
    JSON.stringify({ version: 1, secretKeyHex: "00".repeat(33) }),
  ])("requires explicit recovery for corrupt persisted identity", async (corruptRecord) => {
    localStorage.setItem(ANONYMOUS_IDENTITY_STORAGE_KEY, corruptRecord);
    const store = new UserProfileStore();

    await store.initialize("River");

    expect(store.recoveryRequired).toBe(true);
    expect(store.initialized).toBe(false);
    expect(store.hasIdentity).toBe(false);
    expect(localStorage.getItem(ANONYMOUS_IDENTITY_STORAGE_KEY)).toBe(corruptRecord);
    expect(store.error).toBe("Local identity needs recovery");
  });

  test("keeps the anonymous signer across authenticated selection and logout", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    const anonymousSigner = store.activeSigner;
    const anonymousPubkey = store.pubkey;

    await store.connectNip07();
    expect(store.activeSigner).not.toBe(anonymousSigner);
    await store.logout();

    expect(store.method).toBe("anonymous");
    expect(store.activeSigner).toBe(anonymousSigner);
    expect(store.pubkey).toBe(anonymousPubkey);
  });

  test("keeps the anonymous signer across NIP-46 selection and logout", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    const anonymousSigner = store.activeSigner;
    const anonymousPubkey = store.pubkey;
    const remoteSigner = {
      getPublicKey: vi.fn().mockResolvedValue(NIP46_PUBKEY),
    } as unknown as NostrConnectSigner;

    await store.adoptNip46(remoteSigner);
    await store.logout();

    expect(store.method).toBe("anonymous");
    expect(store.activeSigner).toBe(anonymousSigner);
    expect(store.pubkey).toBe(anonymousPubkey);
  });

  test("destroys secret-dependent signer operations without exposing private material", async () => {
    const secretKey = generateSecretKey();
    const signer = new BrowserNostrSigner(secretKey);
    secretKey.fill(0);
    const peerSecretKey = generateSecretKey();
    const peerPubkey = getPublicKey(peerSecretKey);
    peerSecretKey.fill(0);

    signer.destroy();

    await expect(signer.signEvent({ kind: 1, created_at: 1, tags: [], content: "" })).rejects.toThrow("Signer is no longer available");
    await expect(signer.nip44.encrypt(peerPubkey, "private message")).rejects.toThrow("Signer is no longer available");
    await expect(signer.nip44.decrypt(peerPubkey, "not-a-ciphertext")).rejects.toThrow("Signer is no longer available");
  });

  test("aborts a staged replacement without changing the canonical identity", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    const canonicalPubkey = store.pubkey;
    const prepared = await prepareAnonymousIdentityReplacement();

    prepared.abort();

    await expect(prepared.signer.signEvent({ kind: 1, created_at: 1, tags: [], content: "" })).rejects.toThrow("Signer is no longer available");
    const reloaded = new UserProfileStore();
    await reloaded.initialize("River");
    expect(reloaded.pubkey).toBe(canonicalPubkey);
  });

  test("rotates an anonymous identity only after creating a replacement", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    const originalPubkey = store.pubkey;
    const originalSigner = store.activeSigner;

    await store.rotateAnonymousIdentity();

    expect(store.recoveryRequired).toBe(false);
    expect(store.rotationInProgress).toBe(false);
    expect(store.pubkey).not.toBe(originalPubkey);
    expect(store.activeSigner).not.toBe(originalSigner);
    await expect(originalSigner?.signEvent({ kind: 1, created_at: 1, tags: [], content: "" }) ?? Promise.resolve()).rejects.toThrow("Signer is no longer available");
  });

  test("requires explicit recovery rather than loading identity data after the recovery boundary", async () => {
    localStorage.setItem("cordn:v1:anonymous-identity-recovery", JSON.stringify({ version: 1 }));
    const store = new UserProfileStore();

    await store.initialize("River");

    expect(store.recoveryRequired).toBe(true);
    expect(store.activeSigner).toBeNull();
    expect(store.hasIdentity).toBe(false);

    await store.recoverAnonymousIdentity();

    expect(store.recoveryRequired).toBe(false);
    expect(store.activeSigner).not.toBeNull();
    expect(store.hasIdentity).toBe(true);
    expect(localStorage.getItem("cordn:v1:anonymous-identity-recovery")).toBeNull();
  });

  test("retires anonymous room authority before replacing a corrupt local identity", async () => {
    localStorage.setItem(ANONYMOUS_IDENTITY_STORAGE_KEY, "{");
    const stored = anonymousRoom("1".repeat(64));
    stored.stateBase64 = "private-state";
    stored.keyPackage = { reference: "private-ref", publicBase64: "public", privateBase64: "private" };
    stored.pending = [{ id: "queued", opaqueBase64: "private-pending" }];
    saveRoom(stored);
    const store = new UserProfileStore();

    await store.initialize("River");
    await store.recoverAnonymousIdentity();

    expect(loadRoom(stored.id, stored.coordinatorPubkey)).toMatchObject({
      membershipStatus: "retired",
      stateBase64: "",
      keyPackage: { reference: "", publicBase64: "", privateBase64: "" },
      pending: [],
    });
    expect(loadRoom(stored.id, stored.coordinatorPubkey)?.anonymousSecretKey).toBeUndefined();
    expect(loadRoom(stored.id, stored.coordinatorPubkey)?.inviteToken).toBeUndefined();
    expect(store.recoveryRequired).toBe(false);
  });

  test("clears recovery busy state when replacement candidate generation fails so it can retry", async () => {
    localStorage.setItem(ANONYMOUS_IDENTITY_STORAGE_KEY, "{");
    const store = new UserProfileStore();
    await store.initialize("River");
    const prepareSpy = vi.spyOn(anonymousIdentity, "prepareAnonymousIdentityReplacement").mockRejectedValueOnce(new Error("Web Crypto unavailable"));

    try {
      await expect(store.recoverAnonymousIdentity()).rejects.toThrow("Unable to create a new local identity. No identity is active. Try again.");
      expect(store.rotationInProgress).toBe(false);
      expect(store.recoveryRequired).toBe(true);

      await store.recoverAnonymousIdentity();
    } finally {
      prepareSpy.mockRestore();
    }

    expect(store.rotationInProgress).toBe(false);
    expect(store.recoveryRequired).toBe(false);
    expect(store.activeSigner).not.toBeNull();
  });

  test("retires matching local room authority and every live session before publishing a replacement", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    const oldPubkey = store.pubkey;
    const retired = vi.fn();
    const restored = vi.fn();
    saveRoom(anonymousRoom(oldPubkey));
    store.registerAnonymousSession({ stablePubkey: oldPubkey, retire: retired, restore: restored });

    await store.rotateAnonymousIdentity();

    const room = loadRoom("rotation-room", "a".repeat(64));
    expect(retired).toHaveBeenCalledTimes(1);
    expect(restored).not.toHaveBeenCalled();
    expect(room).toMatchObject({ membershipStatus: "retired", messages: [expect.objectContaining({ id: "cached" })] });
    expect(room?.anonymousSecretKey).toBeUndefined();
    expect(room?.stateBase64).toBe("");
    expect(room?.keyPackage.privateBase64).toBe("");
    expect(store.pubkey).not.toBe(oldPubkey);
  });

  test("writes the durable recovery marker before retiring room authority", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    saveRoom(anonymousRoom(store.pubkey));

    const writes: Array<{ key: string; value: string }> = [];
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const setItemSpy = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      writes.push({ key, value });
      originalSetItem(key, value);
    });

    try {
      await store.rotateAnonymousIdentity();
    } finally {
      setItemSpy.mockRestore();
    }

    const markerWrite = writes.findIndex(({ key }) => key === ANONYMOUS_IDENTITY_RECOVERY_STORAGE_KEY);
    const retirementWrite = writes.findIndex(({ value }) => value.includes('"membershipStatus":"retired"'));
    expect(markerWrite).toBeGreaterThanOrEqual(0);
    expect(retirementWrite).toBeGreaterThan(markerWrite);
  });

  test("rolls back session and room retirement when a lifecycle fails before the durable boundary", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    const oldPubkey = store.pubkey;
    const retired = vi.fn().mockRejectedValue(new Error("session retirement failed"));
    const restored = vi.fn();
    saveRoom(anonymousRoom(oldPubkey));
    store.registerAnonymousSession({ stablePubkey: oldPubkey, retire: retired, restore: restored });

    await expect(store.rotateAnonymousIdentity()).rejects.toThrow("Unable to rotate your identity. Your current identity and local room access are unchanged. Try again.");

    expect(store.pubkey).toBe(oldPubkey);
    expect(store.recoveryRequired).toBe(false);
    expect(loadRoom("rotation-room", "a".repeat(64))).toMatchObject({ stateBase64: "", anonymousSecretKey: "00".repeat(32) });
    expect(restored).not.toHaveBeenCalled();
  });

  test("restores every room without publishing retirement when membership storage fails", async () => {
    const store = new UserProfileStore();
    await store.initialize("River");
    const originalPubkey = store.pubkey;
    const originalSigner = store.activeSigner;
    const first = anonymousRoom(originalPubkey, "a".repeat(64));
    first.stateBase64 = "first-private-state";
    const second = anonymousRoom(originalPubkey, "b".repeat(64));
    second.id = "second-rotation-room";
    second.stateBase64 = "second-private-state";
    saveRoom(first);
    saveRoom(second);
    const originalStorage = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, key === null ? null : localStorage.getItem(key)] as const;
    }).sort(([left], [right]) => (left ?? "").localeCompare(right ?? ""));
    const listener = vi.fn();
    window.addEventListener(ROOMS_CHANGED_EVENT, listener);
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let writes = 0;
    const setItemSpy = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 2) throw new Error("storage full");
      originalSetItem(key, value);
    });

    try {
      await expect(store.rotateAnonymousIdentity()).rejects.toThrow("Unable to rotate your identity. Your current identity and local room access are unchanged. Try again.");
    } finally {
      setItemSpy.mockRestore();
      window.removeEventListener(ROOMS_CHANGED_EVENT, listener);
    }

    const restoredStorage = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, key === null ? null : localStorage.getItem(key)] as const;
    }).sort(([left], [right]) => (left ?? "").localeCompare(right ?? ""));
    expect(restoredStorage).toEqual(originalStorage);
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ action: "membership-retired" }),
    }));
    expect(store.pubkey).toBe(originalPubkey);
    expect(store.activeSigner).toBe(originalSigner);
    expect(store.recoveryRequired).toBe(false);
  });
});
