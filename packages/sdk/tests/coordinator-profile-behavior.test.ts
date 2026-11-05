import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Event as NostrEvent } from "nostr-tools";

import { KeyManager } from "../src/crypto/key-manager.js";
import {
  CoordinatorProfilePublicationError,
  mergeCoordinatorProfileMetadata,
  parseCoordinatorProfileMetadata,
  publishCoordinatorProfile,
  type CoordinatorProfilePool,
} from "../src/runtime/coordinator-profile.js";

const nostr = vi.hoisted(() => ({
  pool: null as unknown,
  verify: null as ((event: unknown) => boolean) | null,
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    SimplePool: vi.fn(function SimplePool() { return nostr.pool; }),
    verifyEvent: (event: NostrEvent) => (nostr.verify ? nostr.verify(event) : actual.verifyEvent(event)),
  };
});

const relayUrls = ["wss://one.example"];

function profileEvent(createdAt: number, content: string, pubkey: string): NostrEvent {
  return { id: "0".repeat(64), pubkey, created_at: createdAt, kind: 0, tags: [], content, sig: "2".repeat(128) };
}

function createPool(overrides: Partial<CoordinatorProfilePool> = {}) {
  return {
    querySync: vi.fn(async () => []),
    publish: vi.fn(() => [Promise.resolve("ok")]),
    destroy: vi.fn(),
    ...overrides,
  } as CoordinatorProfilePool;
}

function input(coordinator = KeyManager.generate(), name = "Host") {
  return {
    name,
    coordinatorPubkey: coordinator.identity.publicKeyHex,
    getSecretKeyBytes: () => coordinator.getSecretKeyBytes(),
    relayUrls,
  };
}

beforeEach(() => {
  nostr.pool = null;
  nostr.verify = null;
});

describe("parseCoordinatorProfileMetadata", () => {
  test.each([
    ["an array", "[]"],
    ["a scalar", "5"],
    ["null", "null"],
    ["invalid JSON", "{"],
    ["a non-finite number", '{"followers":1e999}'],
    ["a nested non-finite number", '{"stats":{"followers":[1e999]}}'],
  ])("rejects %s", (_label, content) => {
    expect(parseCoordinatorProfileMetadata(content)).toBeNull();
  });

  test("accepts content exactly at the size limit and rejects one byte more", () => {
    const shell = '{"about":""}'.length;
    const atLimit = `{"about":"${"x".repeat(16_384 - shell)}"}`;
    expect(parseCoordinatorProfileMetadata(atLimit)).not.toBeNull();
    expect(parseCoordinatorProfileMetadata(`{"about":"${"x".repeat(16_385 - shell)}"}`)).toBeNull();
  });

  test("rejects metadata nested past the depth limit but keeps a shallower one", () => {
    const nest = (depth: number) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    expect(parseCoordinatorProfileMetadata(nest(16))).not.toBeNull();
    expect(parseCoordinatorProfileMetadata(nest(17))).toBeNull();
  });

  test("keeps every JSON type", () => {
    expect(parseCoordinatorProfileMetadata('{"a":null,"b":true,"c":1,"d":"x","e":[{"f":[]}]}')).toEqual({
      a: null, b: true, c: 1, d: "x", e: [{ f: [] }],
    });
  });

  test("a __proto__ key stays plain data and does not change any prototype", () => {
    const parsed = parseCoordinatorProfileMetadata('{"__proto__":{"polluted":true},"nested":{"__proto__":{"polluted":true}}}');

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect((parsed as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.keys(parsed!)).toEqual(["__proto__", "nested"]);
    expect(Object.getPrototypeOf(parsed!.nested)).toBe(Object.prototype);
  });
});

describe("mergeCoordinatorProfileMetadata", () => {
  test("starts from nothing when there is no existing profile", () => {
    expect(mergeCoordinatorProfileMetadata(null, "Host")).toEqual({ name: "Host" });
  });
});

describe("publishCoordinatorProfile", () => {
  test.each([["   "], [""]])("refuses the invalid name %j before opening a pool", async (name) => {
    const createPoolFactory = vi.fn(() => createPool());

    await expect(publishCoordinatorProfile(input(undefined, name), { createPool: createPoolFactory }))
      .rejects.toBeInstanceOf(CoordinatorProfilePublicationError);
    expect(createPoolFactory).not.toHaveBeenCalled();
  });

  test("normalizes the published name", async () => {
    const event = await publishCoordinatorProfile(input(undefined, "  Host  "), { createPool: () => createPool() });
    expect(JSON.parse(event.content)).toEqual({ name: "Host" });
  });

  test("opens a real pool by default and uses the wall clock", async () => {
    const pool = createPool();
    nostr.pool = pool;
    vi.useFakeTimers({ now: 1_700_000_000_500 });
    try {
      const event = await publishCoordinatorProfile(input());
      expect(event.created_at).toBe(1_700_000_000);
      expect(pool.publish).toHaveBeenCalledOnce();
      expect(pool.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("still publishes the name when reading the existing profile fails", async () => {
    const pool = createPool({ querySync: vi.fn(async () => { throw new Error("relay offline"); }) });

    const event = await publishCoordinatorProfile(input(), { createPool: () => pool });

    expect(JSON.parse(event.content)).toEqual({ name: "Host" });
    expect(pool.publish).toHaveBeenCalledOnce();
  });

  test("matches its own profile events regardless of pubkey case and does not mutate the query result", async () => {
    const coordinator = KeyManager.generate();
    const pubkey = coordinator.identity.publicKeyHex;
    const events = [
      profileEvent(10, '{"about":"older"}', pubkey),
      profileEvent(20, '{"about":"newer"}', pubkey.toUpperCase()),
    ];
    const pool = createPool({ querySync: vi.fn(async () => events) });

    const event = await publishCoordinatorProfile(input(coordinator), { createPool: () => pool });

    expect(JSON.parse(event.content)).toEqual({ about: "newer", name: "Host" });
    expect(events.map((candidate) => candidate.created_at)).toEqual([10, 20]);
  });

  test("falls back to an empty profile when every event is foreign or unusable", async () => {
    const coordinator = KeyManager.generate();
    const pool = createPool({ querySync: vi.fn(async () => [
      profileEvent(30, '{"about":"foreign"}', "f".repeat(64)),
      profileEvent(20, "nope", coordinator.identity.publicKeyHex),
    ]) });

    const event = await publishCoordinatorProfile(input(coordinator), { createPool: () => pool });

    expect(JSON.parse(event.content)).toEqual({ name: "Host" });
  });

  test("an existing name is overwritten", async () => {
    const coordinator = KeyManager.generate();
    const pool = createPool({ querySync: vi.fn(async () => [
      profileEvent(30, '{"name":"Old","about":"kept"}', coordinator.identity.publicKeyHex),
    ]) });

    const event = await publishCoordinatorProfile(input(coordinator, "New"), { createPool: () => pool });

    expect(JSON.parse(event.content)).toEqual({ name: "New", about: "kept" });
  });

  test("refuses to publish when the signing key is not the coordinator's", async () => {
    const pool = createPool();
    const coordinator = KeyManager.generate();

    await expect(publishCoordinatorProfile({
      ...input(coordinator),
      coordinatorPubkey: "1".repeat(64),
    }, { createPool: () => pool })).rejects.toBeInstanceOf(CoordinatorProfilePublicationError);

    expect(pool.publish).not.toHaveBeenCalled();
    expect(pool.destroy).toHaveBeenCalledOnce();
  });

  test("refuses to publish an event that fails verification and wipes the key", async () => {
    nostr.verify = () => false;
    const pool = createPool();
    const coordinator = KeyManager.generate();
    const secret = coordinator.getSecretKeyBytes();

    await expect(publishCoordinatorProfile({
      ...input(coordinator),
      getSecretKeyBytes: () => secret,
    }, { createPool: () => pool })).rejects.toBeInstanceOf(CoordinatorProfilePublicationError);

    expect(pool.publish).not.toHaveBeenCalled();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  test("hides the reason when the key is unavailable and still closes the pool", async () => {
    const pool = createPool();
    const failure = publishCoordinatorProfile({
      ...input(),
      getSecretKeyBytes: () => { throw new Error("secret detail"); },
    }, { createPool: () => pool });

    await expect(failure).rejects.toBeInstanceOf(CoordinatorProfilePublicationError);
    await expect(failure).rejects.toThrow("Coordinator profile publication failed");
    expect(pool.destroy).toHaveBeenCalledOnce();
  });

  test("hides a synchronous publish failure", async () => {
    const pool = createPool({ publish: vi.fn(() => { throw new Error("secret detail"); }) });

    await expect(publishCoordinatorProfile(input(), { createPool: () => pool }))
      .rejects.toThrow("Coordinator profile publication failed");
    expect(pool.destroy).toHaveBeenCalledOnce();
  });

  test("counts a non-string acknowledgement as accepted", async () => {
    const pool = createPool({ publish: vi.fn(() => [Promise.resolve(undefined)]) });

    await expect(publishCoordinatorProfile(input(), { createPool: () => pool })).resolves.toMatchObject({ kind: 0 });
  });

  test("snapshots relay urls so later edits do not change the target", async () => {
    const urls = ["wss://one.example"];
    const pool = createPool();
    const coordinator = KeyManager.generate();

    const publishing = publishCoordinatorProfile({ ...input(coordinator), relayUrls: urls }, { createPool: () => pool });
    urls.push("wss://late.example");
    await publishing;

    expect(pool.publish).toHaveBeenCalledWith(["wss://one.example"], expect.anything());
  });
});
