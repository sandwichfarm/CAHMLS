import { describe, expect, test, vi } from "vitest";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools";

import { KeyManager } from "../src/crypto/key-manager.js";
import {
  CoordinatorProfilePublicationError,
  mergeCoordinatorProfileMetadata,
  publishCoordinatorProfile,
  type CoordinatorProfilePool,
} from "../src/runtime/coordinator-profile.js";

const relayUrls = ["wss://one.example", "wss://two.example"];

function profileEvent(createdAt: number, content: string, pubkey = "1".repeat(64)): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey,
    created_at: createdAt,
    kind: 0,
    tags: [],
    content,
    sig: "2".repeat(128),
  };
}

function createPool(events: NostrEvent[] = [], acknowledgements: Array<Promise<unknown>> = [Promise.resolve("ok")]) {
  const pool: CoordinatorProfilePool = {
    querySync: vi.fn(async () => events),
    publish: vi.fn(() => acknowledgements),
    destroy: vi.fn(),
  };
  return pool;
}

describe("coordinator profile metadata", () => {
  test("preserves JSON-safe public metadata while overwriting only the selected name", () => {
    expect(mergeCoordinatorProfileMetadata(
      JSON.stringify({
        name: "Old name",
        display_name: "Madeira host",
        about: "Encrypted local coordination",
        picture: "https://example.test/avatar.png",
        nip05: "host@example.test",
        custom: { theme: "night", badges: ["host", 1] },
      }),
      "New coordinator",
    )).toEqual({
      name: "New coordinator",
      display_name: "Madeira host",
      about: "Encrypted local coordination",
      picture: "https://example.test/avatar.png",
      nip05: "host@example.test",
      custom: { theme: "night", badges: ["host", 1] },
    });
  });

  test("falls back safely when an existing profile is malformed or oversized", () => {
    expect(mergeCoordinatorProfileMetadata("not json", "New coordinator")).toEqual({ name: "New coordinator" });
    expect(mergeCoordinatorProfileMetadata("[]", "New coordinator")).toEqual({ name: "New coordinator" });
    expect(mergeCoordinatorProfileMetadata(`{"about":"${"x".repeat(16_385)}"}`, "New coordinator"))
      .toEqual({ name: "New coordinator" });
  });
});

describe("publishCoordinatorProfile", () => {
  test("selects the newest usable event, signs with the coordinator key, and attempts every configured relay", async () => {
    const coordinator = KeyManager.generate();
    const copiedSecret = coordinator.getSecretKeyBytes();
    const pool = createPool([
      profileEvent(100, JSON.stringify({ display_name: "Foreign host" }), "f".repeat(64)),
      profileEvent(40, "not metadata", coordinator.identity.publicKeyHex),
      profileEvent(30, JSON.stringify({ display_name: "Previous host", about: "Preserved" }), coordinator.identity.publicKeyHex),
      profileEvent(20, JSON.stringify({ display_name: "Older host" }), coordinator.identity.publicKeyHex),
    ], [Promise.reject(new Error("relay one rejected")), Promise.resolve("accepted")]);
    const createPoolFactory = vi.fn(() => pool);

    const event = await publishCoordinatorProfile({
      name: "Madeira coordinator",
      coordinatorPubkey: coordinator.identity.publicKeyHex,
      getSecretKeyBytes: vi.fn(() => copiedSecret),
      relayUrls,
    }, { createPool: createPoolFactory, now: () => 1_700_000_000_321 });

    expect(pool.querySync).toHaveBeenCalledWith(relayUrls, {
      kinds: [0],
      authors: [coordinator.identity.publicKeyHex],
      limit: 20,
    }, { maxWait: 4_000 });
    expect(pool.publish).toHaveBeenCalledOnce();
    expect(pool.publish).toHaveBeenCalledWith(relayUrls, event);
    expect(event).toMatchObject({
      kind: 0,
      created_at: 1_700_000_000,
      tags: [],
      pubkey: coordinator.identity.publicKeyHex,
      content: JSON.stringify({ display_name: "Previous host", about: "Preserved", name: "Madeira coordinator" }),
    });
    expect(verifyEvent(event)).toBe(true);
    expect(copiedSecret.every((byte) => byte === 0)).toBe(true);
    expect(pool.destroy).toHaveBeenCalledOnce();
  });

  test("keeps publication retryable after all acknowledgements fail and still cleans up", async () => {
    const coordinator = KeyManager.generate();
    const copiedSecret = coordinator.getSecretKeyBytes();
    const pool = createPool([], [Promise.reject(new Error("first")), Promise.reject(new Error("second"))]);

    await expect(publishCoordinatorProfile({
      name: "Retry coordinator",
      coordinatorPubkey: coordinator.identity.publicKeyHex,
      getSecretKeyBytes: () => copiedSecret,
      relayUrls,
    }, { createPool: () => pool, now: () => 1_700_000_000_000 }))
      .rejects.toEqual(expect.objectContaining({
        name: "CoordinatorProfilePublicationError",
        message: "Coordinator profile publication failed",
      }));

    expect(pool.publish).toHaveBeenCalledWith(relayUrls, expect.objectContaining({ kind: 0 }));
    expect(copiedSecret.every((byte) => byte === 0)).toBe(true);
    expect(pool.destroy).toHaveBeenCalledOnce();
  });

  test("does not treat a fulfilled SimplePool connection failure as a relay acknowledgement", async () => {
    const coordinator = KeyManager.generate();
    const copiedSecret = coordinator.getSecretKeyBytes();
    const pool = createPool([], [
      Promise.resolve("connection failure: relay socket closed"),
      Promise.reject(new Error("second relay rejected")),
    ]);

    await expect(publishCoordinatorProfile({
      name: "Failed relay coordinator",
      coordinatorPubkey: coordinator.identity.publicKeyHex,
      getSecretKeyBytes: () => copiedSecret,
      relayUrls,
    }, { createPool: () => pool, now: () => 1_700_000_000_000 }))
      .rejects.toBeInstanceOf(CoordinatorProfilePublicationError);

    expect(pool.publish).toHaveBeenCalledWith(relayUrls, expect.objectContaining({ kind: 0 }));
    expect(copiedSecret.every((byte) => byte === 0)).toBe(true);
    expect(pool.destroy).toHaveBeenCalledOnce();
  });

  test("rejects an empty relay target list with a fixed safe error", async () => {
    const coordinator = KeyManager.generate();
    const pool = createPool();

    await expect(publishCoordinatorProfile({
      name: "No relay coordinator",
      coordinatorPubkey: coordinator.identity.publicKeyHex,
      getSecretKeyBytes: () => coordinator.getSecretKeyBytes(),
      relayUrls: [],
    }, { createPool: () => pool }))
      .rejects.toBeInstanceOf(CoordinatorProfilePublicationError);
    await expect(publishCoordinatorProfile({
      name: "No relay coordinator",
      coordinatorPubkey: coordinator.identity.publicKeyHex,
      getSecretKeyBytes: () => coordinator.getSecretKeyBytes(),
      relayUrls: [],
    }, { createPool: () => pool }))
      .rejects.toThrow("Coordinator profile publication failed");
    expect(pool.querySync).not.toHaveBeenCalled();
    expect(pool.publish).not.toHaveBeenCalled();
    expect(pool.destroy).not.toHaveBeenCalled();
  });
});
