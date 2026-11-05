import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent, type Event as NostrEvent } from "nostr-tools/pure";

import {
  clearCoordinatorInstanceRecords,
  CordnAlreadyRunningError,
  INSTANCE_HEARTBEAT_KIND,
  SimplePoolNostrInstanceNetwork,
  SingleInstanceGuard,
  type DebugSink,
  type NostrInstanceNetwork,
} from "../src/runtime/single-instance-guard.js";

const pools = vi.hoisted(() => ({
  created: [] as Array<{
    options: unknown;
    querySync: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  query: (async () => []) as (...args: unknown[]) => Promise<unknown[]>,
  publish: ((relays: string[]) => relays.map(async () => "ok")) as (relays: string[], event: unknown) => Array<Promise<unknown>>,
}));

vi.mock("nostr-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("nostr-tools")>()),
  SimplePool: vi.fn(function SimplePool(this: unknown, options: unknown) {
    const pool = {
      options,
      querySync: vi.fn((...args: unknown[]) => pools.query(...args)),
      publish: vi.fn((relays: string[], event: unknown) => pools.publish(relays, event)),
      destroy: vi.fn(),
    };
    pools.created.push(pool);
    return pool;
  }),
}));

const publicKeyHex = "ab".repeat(32);
const relayUrls = ["wss://relay.example"];
const leaseKey = `cordn:v1:instance:${publicKeyHex}`;
const stoppedKey = `cordn:v1:stopped-instance:${publicKeyHex}`;

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function input(debug?: DebugSink) {
  return {
    publicKeyHex,
    relayUrls,
    getSecretKeyBytes: () => new Uint8Array(32).fill(1),
    ...(debug ? { debug } : {}),
  };
}

const isolated = { storage: null, locks: null, createBroadcastChannel: null, nostr: null } as const;

function logged(debug: Mock<DebugSink>): string[] {
  return debug.mock.calls.map((call) => call[1]);
}

class FakeChannel {
  static hub: FakeChannel[] = [];
  readonly sent: unknown[] = [];
  listeners = new Set<(event: MessageEvent) => void>();
  closed = false;
  constructor(readonly name: string) { FakeChannel.hub.push(this); }
  postMessage(message: unknown): void {
    this.sent.push(message);
    for (const channel of FakeChannel.hub) {
      if (channel === this || channel.closed) continue;
      for (const listener of [...channel.listeners]) listener({ data: message } as MessageEvent);
    }
  }
  close(): void { this.closed = true; }
  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void { this.listeners.add(listener); }
  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void { this.listeners.delete(listener); }
}

beforeEach(() => {
  FakeChannel.hub = [];
  pools.created.length = 0;
  pools.query = async () => [];
  pools.publish = (relays) => relays.map(async () => "ok");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Web Locks path", () => {
  function exclusiveLocks() {
    const held = new Set<string>();
    const requests: Array<{ name: string; options: unknown }> = [];
    return {
      held,
      requests,
      async request<T>(name: string, options: { ifAvailable: true; mode?: "exclusive" }, callback: (lock: unknown | null) => T | Promise<T>): Promise<T> {
        requests.push({ name, options });
        if (held.has(name)) return await callback(null);
        held.add(name);
        try {
          return await callback({});
        } finally {
          held.delete(name);
        }
      },
    };
  }

  test("requests an exclusive lock scoped to the key and holds it until release", async () => {
    const locks = exclusiveLocks();
    const debug = vi.fn<DebugSink>();

    const lease = await new SingleInstanceGuard({ ...isolated, locks }).acquire(input(debug));

    expect(locks.requests).toEqual([{ name: `cordn:${publicKeyHex}`, options: { ifAvailable: true, mode: "exclusive" } }]);
    expect(locks.held.has(`cordn:${publicKeyHex}`)).toBe(true);
    expect(logged(debug)).toContain("web lock acquired");

    await lease.release();
    expect(locks.held.size).toBe(0);
  });

  test("an unavailable lock reports a running instance", async () => {
    const locks = exclusiveLocks();
    locks.held.add(`cordn:${publicKeyHex}`);
    const debug = vi.fn<DebugSink>();

    await expect(new SingleInstanceGuard({ ...isolated, locks }).acquire(input(debug)))
      .rejects.toBeInstanceOf(CordnAlreadyRunningError);
    expect(logged(debug)).toContain("web lock detected running instance");
  });

  test("a rejected lock request does not hang acquisition and falls back to the other checks", async () => {
    // Web Locks rejects with SecurityError in opaque origins such as sandboxed iframes.
    const locks = {
      request: vi.fn(() => Promise.reject(new DOMException("denied", "SecurityError"))),
    };
    const debug = vi.fn<DebugSink>();

    const lease = await new SingleInstanceGuard({ ...isolated, locks: locks as never }).acquire(input(debug));

    expect(logged(debug)).toContain("web lock unavailable");
    await lease.release();
  });

  test("uses navigator.locks when no dependency is injected", async () => {
    const locks = exclusiveLocks();
    vi.stubGlobal("navigator", { locks });

    const lease = await new SingleInstanceGuard({ storage: null, createBroadcastChannel: null, nostr: null }).acquire(input());

    expect(locks.requests).toHaveLength(1);
    await lease.release();
  });

  test("continues without locks when navigator has none", async () => {
    vi.stubGlobal("navigator", {});
    const debug = vi.fn<DebugSink>();

    const lease = await new SingleInstanceGuard({ storage: null, createBroadcastChannel: null, nostr: null }).acquire(input(debug));

    expect(logged(debug)).toContain("web lock unavailable");
    await lease.release();
  });

  test("continues without locks when there is no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);
    const debug = vi.fn<DebugSink>();

    const lease = await new SingleInstanceGuard({ storage: null, createBroadcastChannel: null, nostr: null }).acquire(input(debug));

    expect(logged(debug)).toContain("web lock unavailable");
    await lease.release();
  });

  test("a later failed check releases the lock it already took", async () => {
    const locks = exclusiveLocks();
    const nostr: NostrInstanceNetwork = {
      isRunning: vi.fn(async () => true),
      startHeartbeat: vi.fn(),
    };

    await expect(new SingleInstanceGuard({ ...isolated, locks, nostr }).acquire(input()))
      .rejects.toBeInstanceOf(CordnAlreadyRunningError);

    expect(locks.held.size).toBe(0);
  });
});

describe("BroadcastChannel probe", () => {
  const withChannels = { ...isolated, createBroadcastChannel: (name: string) => new FakeChannel(name), broadcastProbeMs: 1 };

  test("a holder answers probes, blocking a second instance until it releases", async () => {
    const debug = vi.fn<DebugSink>();
    const first = await new SingleInstanceGuard({ ...withChannels, randomUUID: () => "first" }).acquire(input(debug));
    expect(logged(debug)).toEqual(expect.arrayContaining(["broadcast probe clear", "broadcast responder active"]));
    expect(FakeChannel.hub[0]!.name).toBe("cordn-browser:v1:instances");

    const secondDebug = vi.fn<DebugSink>();
    await expect(new SingleInstanceGuard({ ...withChannels, randomUUID: () => "second" }).acquire(input(secondDebug)))
      .rejects.toBeInstanceOf(CordnAlreadyRunningError);
    expect(logged(secondDebug)).toContain("broadcast probe detected running instance");

    await first.release();
    const responder = FakeChannel.hub[1]!;
    expect(responder.closed).toBe(true);
    expect(responder.listeners.size).toBe(0);

    const second = await new SingleInstanceGuard({ ...withChannels, randomUUID: () => "second" }).acquire(input());
    await second.release();
  });

  test("the probe closes its channel and timer on both outcomes", async () => {
    const clearTimeoutSpy = vi.fn(clearTimeout);
    const lease = await new SingleInstanceGuard({ ...withChannels, clearTimeout: clearTimeoutSpy as typeof clearTimeout }).acquire(input());
    const probe = FakeChannel.hub[0]!;

    expect(probe.closed).toBe(true);
    expect(probe.listeners.size).toBe(0);
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(probe.sent).toEqual([{ type: "probe", publicKeyHex, token: expect.any(String) }]);
    await lease.release();
  });

  test("ignores other keys and malformed messages", async () => {
    const createBroadcastChannel = (name: string) => {
      const channel = new FakeChannel(name);
      queueMicrotask(() => {
        for (const message of [
          null,
          "running",
          { type: "running" },
          { publicKeyHex },
          { type: "running", publicKeyHex: "cd".repeat(32) },
          { type: "probe", publicKeyHex },
        ]) {
          for (const listener of [...channel.listeners]) listener({ data: message } as MessageEvent);
        }
      });
      return channel;
    };

    const lease = await new SingleInstanceGuard({ ...isolated, createBroadcastChannel, broadcastProbeMs: 1 }).acquire(input());
    await lease.release();
  });

  test("the responder ignores probes for another key", async () => {
    const lease = await new SingleInstanceGuard(withChannels).acquire(input());
    const responder = FakeChannel.hub[1]!;

    new FakeChannel("other").postMessage({ type: "probe", publicKeyHex: "cd".repeat(32) });
    expect(responder.sent).toEqual([]);

    new FakeChannel("other").postMessage({ type: "probe", publicKeyHex });
    expect(responder.sent).toEqual([{ type: "running", publicKeyHex, token: expect.any(String) }]);
    await lease.release();
  });

  test("uses the global BroadcastChannel by default", async () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);

    const lease = await new SingleInstanceGuard({ storage: null, locks: null, nostr: null, broadcastProbeMs: 1 }).acquire(input());

    expect(FakeChannel.hub).toHaveLength(2);
    await lease.release();
  });

  test("continues without BroadcastChannel when the platform has none", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    const debug = vi.fn<DebugSink>();
    try {
      const lease = await new SingleInstanceGuard({ storage: null, locks: null, nostr: null }).acquire(input(debug));
      expect(logged(debug)).toContain("broadcast probe unavailable");
      await lease.release();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "BroadcastChannel", descriptor);
    }
  });

  test("a probe with no answer times out using the default window", async () => {
    vi.useFakeTimers();
    const acquire = new SingleInstanceGuard({ ...isolated, createBroadcastChannel: (name) => new FakeChannel(name) }).acquire(input());
    await vi.advanceTimersByTimeAsync(119);
    expect(FakeChannel.hub[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const lease = await acquire;
    expect(FakeChannel.hub[0]!.closed).toBe(true);
    await lease.release();
  });
});

describe("storage lease", () => {
  test("writes a lease with the configured duration, renews it and removes it on release", async () => {
    let now = 1_000;
    const storage = createStorage();
    const renewals: Array<() => void> = [];
    const setIntervalSpy = vi.fn((callback: () => void, _ms: number) => {
      renewals.push(callback);
      return 7 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.fn();
    const debug = vi.fn<DebugSink>();
    const lease = await new SingleInstanceGuard({
      ...isolated,
      storage,
      now: () => now,
      randomUUID: () => "token",
      leaseDurationMs: 100,
      leaseRenewMs: 10,
      setInterval: setIntervalSpy as unknown as typeof setInterval,
      clearInterval: clearIntervalSpy as unknown as typeof clearInterval,
    }).acquire(input(debug));

    expect(JSON.parse(storage.getItem(leaseKey)!)).toEqual({ token: "token", publicKeyHex, updatedAt: 1_000, expiresAt: 1_100 });
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10);
    expect(logged(debug)).toContain("storage lease acquired");

    now = 1_050;
    renewals[0]!();
    expect(JSON.parse(storage.getItem(leaseKey)!)).toMatchObject({ updatedAt: 1_050, expiresAt: 1_150 });

    await lease.release();
    expect(clearIntervalSpy).toHaveBeenCalledWith(7);
    expect(storage.getItem(leaseKey)).toBeNull();
    expect(JSON.parse(storage.getItem(stoppedKey)!)).toEqual([{ token: "token", expiresAt: 21_050 }]);
  });

  test("uses the default duration and renew interval", async () => {
    vi.useFakeTimers({ now: 5_000 });
    const storage = createStorage();
    const lease = await new SingleInstanceGuard({ ...isolated, storage, randomUUID: () => "token" }).acquire(input());
    expect(JSON.parse(storage.getItem(leaseKey)!).expiresAt).toBe(50_000);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(JSON.parse(storage.getItem(leaseKey)!)).toMatchObject({ updatedAt: 20_000, expiresAt: 65_000 });

    await lease.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.getItem(leaseKey)).toBeNull();
  });

  test("blocks on an unexpired foreign lease and takes over at the moment it expires", async () => {
    const storage = createStorage({
      [leaseKey]: JSON.stringify({ token: "other", publicKeyHex, updatedAt: 0, expiresAt: 100 }),
    });
    const debug = vi.fn<DebugSink>();
    const guardAt = (now: number) => new SingleInstanceGuard({ ...isolated, storage, now: () => now, randomUUID: () => "mine" });

    await expect(guardAt(99).acquire(input(debug))).rejects.toBeInstanceOf(CordnAlreadyRunningError);
    expect(logged(debug)).toContain("storage lease detected running instance");

    const lease = await guardAt(100).acquire(input());
    expect(JSON.parse(storage.getItem(leaseKey)!).token).toBe("mine");
    await lease.release();
  });

  test("a guard can re-acquire over its own unexpired lease", async () => {
    const storage = createStorage({
      [leaseKey]: JSON.stringify({ token: "mine", publicKeyHex, updatedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER }),
    });
    const lease = await new SingleInstanceGuard({ ...isolated, storage, randomUUID: () => "mine" }).acquire(input());
    await lease.release();
    expect(storage.getItem(leaseKey)).toBeNull();
  });

  test.each([
    ["invalid JSON", "{"],
    ["JSON null", "null"],
    ["missing fields", JSON.stringify({ token: "other" })],
    ["wrong field types", JSON.stringify({ token: "other", publicKeyHex, updatedAt: "0", expiresAt: "9" })],
  ])("treats a corrupt lease (%s) as absent", async (_label, raw) => {
    const storage = createStorage({ [leaseKey]: raw });
    const lease = await new SingleInstanceGuard({ ...isolated, storage, randomUUID: () => "mine" }).acquire(input());
    expect(JSON.parse(storage.getItem(leaseKey)!).token).toBe("mine");
    await lease.release();
  });

  test("detects a lost write race immediately after writing", async () => {
    const storage = createStorage();
    const original = storage.setItem;
    storage.setItem = (key, value) => original(key, value.replace('"token":"mine"', '"token":"rival"'));
    const debug = vi.fn<DebugSink>();

    await expect(new SingleInstanceGuard({ ...isolated, storage, randomUUID: () => "mine" }).acquire(input(debug)))
      .rejects.toBeInstanceOf(CordnAlreadyRunningError);
    expect(logged(debug)).toContain("storage lease write lost race");
  });

  test("releasing does not remove a lease a newer instance took over", async () => {
    const storage = createStorage();
    const lease = await new SingleInstanceGuard({ ...isolated, storage, randomUUID: () => "mine" }).acquire(input());
    const rival = JSON.stringify({ token: "rival", publicKeyHex, updatedAt: 0, expiresAt: 9 });
    storage.setItem(leaseKey, rival);

    await lease.release();

    expect(storage.getItem(leaseKey)).toBe(rival);
  });

  test("uses global localStorage by default", async () => {
    const lease = await new SingleInstanceGuard({ locks: null, createBroadcastChannel: null, nostr: null, randomUUID: () => "mine" }).acquire(input());
    expect(JSON.parse(localStorage.getItem(leaseKey)!).token).toBe("mine");
    await lease.release();
    expect(localStorage.getItem(leaseKey)).toBeNull();
  });

  test("continues when reading localStorage is forbidden or it is missing", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    const debug = vi.fn<DebugSink>();
    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
      const lease = await new SingleInstanceGuard({ locks: null, createBroadcastChannel: null, nostr: null }).acquire(input(debug));
      await lease.release();
      expect(logged(debug)).toContain("storage lease unavailable");

      debug.mockClear();
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
      const second = await new SingleInstanceGuard({ locks: null, createBroadcastChannel: null, nostr: null }).acquire(input(debug));
      await second.release();
      expect(logged(debug)).toContain("storage lease unavailable");
    } finally {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });

  test("a failed renewal is reported instead of throwing out of the timer", async () => {
    const storage = createStorage();
    const renewals: Array<() => void> = [];
    const debug = vi.fn<DebugSink>();
    const lease = await new SingleInstanceGuard({
      ...isolated,
      storage,
      setInterval: ((callback: () => void) => { renewals.push(callback); return 1; }) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
    }).acquire(input(debug));
    const setItem = storage.setItem;
    storage.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };

    expect(() => renewals[0]!()).not.toThrow();
    expect(logged(debug)).toContain("storage lease renewal failed");

    storage.setItem = setItem;
    await lease.release();
  });
});

describe("stopped instance tokens", () => {
  function nostrSpy(): NostrInstanceNetwork & { isRunning: ReturnType<typeof vi.fn> } {
    return {
      isRunning: vi.fn(async () => false),
      startHeartbeat: vi.fn(() => ({ release: () => undefined })),
    };
  }

  test("the next instance ignores heartbeats from an instance stopped on this device", async () => {
    let now = 1_000;
    const storage = createStorage();
    const nostr = nostrSpy();
    const first = await new SingleInstanceGuard({ ...isolated, storage, nostr, now: () => now, randomUUID: () => "first" }).acquire(input());
    await first.release();

    const second = await new SingleInstanceGuard({ ...isolated, storage, nostr, now: () => now, randomUUID: () => "second" }).acquire(input());
    expect(nostr.isRunning).toHaveBeenLastCalledWith(publicKeyHex, relayUrls, ["first"], undefined);
    await second.release();

    now += 10_000;
    const third = await new SingleInstanceGuard({ ...isolated, storage, nostr, now: () => now, randomUUID: () => "third" }).acquire(input());
    expect(nostr.isRunning).toHaveBeenLastCalledWith(publicKeyHex, relayUrls, ["first", "second"], undefined);
    await third.release();
    expect(JSON.parse(storage.getItem(stoppedKey)!).map((entry: { token: string }) => entry.token)).toEqual(["first", "second", "third"]);
  });

  test("expired tokens are dropped and the record is removed when empty", async () => {
    const storage = createStorage({ [stoppedKey]: JSON.stringify([{ token: "old", expiresAt: 500 }, { token: "new", expiresAt: 1_500 }]) });
    const nostr = nostrSpy();

    const lease = await new SingleInstanceGuard({ ...isolated, storage, nostr, now: () => 1_000, randomUUID: () => "x" }).acquire(input());
    expect(nostr.isRunning).toHaveBeenCalledWith(publicKeyHex, relayUrls, ["new"], undefined);
    expect(JSON.parse(storage.getItem(stoppedKey)!)).toEqual([{ token: "new", expiresAt: 1_500 }]);
    await lease.release();
    storage.removeItem(stoppedKey);

    storage.setItem(stoppedKey, JSON.stringify([{ token: "old", expiresAt: 500 }]));
    const next = await new SingleInstanceGuard({ ...isolated, storage, nostr, now: () => 1_000, randomUUID: () => "y" }).acquire(input());
    expect(nostr.isRunning).toHaveBeenLastCalledWith(publicKeyHex, relayUrls, [], undefined);
    await next.release();
  });

  test.each([
    ["invalid JSON", "{"],
    ["a non-array", '{"token":"x"}'],
    ["malformed entries", JSON.stringify([{ token: 1, expiresAt: 9e15 }, { token: "x" }])],
  ])("treats %s as no tokens", async (_label, raw) => {
    const storage = createStorage({ [stoppedKey]: raw });
    const nostr = nostrSpy();

    const lease = await new SingleInstanceGuard({ ...isolated, storage, nostr }).acquire(input());

    expect(nostr.isRunning).toHaveBeenCalledWith(publicKeyHex, relayUrls, [], undefined);
    await lease.release();
  });

  test("clearCoordinatorInstanceRecords forgets lease and tokens but only for that key", () => {
    localStorage.setItem(leaseKey, "x");
    localStorage.setItem(stoppedKey, "x");
    localStorage.setItem("cordn:v1:instance:other", "x");

    clearCoordinatorInstanceRecords(publicKeyHex);

    expect(localStorage.getItem(leaseKey)).toBeNull();
    expect(localStorage.getItem(stoppedKey)).toBeNull();
    expect(localStorage.getItem("cordn:v1:instance:other")).toBe("x");
  });

  test("clearCoordinatorInstanceRecords tolerates unavailable storage", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      expect(() => clearCoordinatorInstanceRecords(publicKeyHex)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });
});

describe("release", () => {
  test("is idempotent and tears down in reverse order of acquisition", async () => {
    const order: string[] = [];
    const storage = createStorage();
    const removeItem = storage.removeItem;
    storage.removeItem = (key) => { order.push("storage"); removeItem(key); };
    const nostr: NostrInstanceNetwork = {
      isRunning: async () => false,
      startHeartbeat: () => ({ release: async () => { order.push("heartbeat"); } }),
    };
    const channels: FakeChannel[] = [];
    const locks = {
      async request<T>(_name: string, _options: unknown, callback: (lock: unknown | null) => T | Promise<T>): Promise<T> {
        const result = await callback({});
        order.push("lock");
        return result;
      },
    };
    const lease = await new SingleInstanceGuard({
      storage,
      locks,
      nostr,
      broadcastProbeMs: 1,
      createBroadcastChannel: (name) => {
        const channel = new FakeChannel(name);
        channels.push(channel);
        const close = channel.close.bind(channel);
        channel.close = () => { if (channels.length === 2) order.push("responder"); close(); };
        return channel;
      },
    }).acquire(input());
    order.length = 0;

    await Promise.all([lease.release(), lease.release()]);
    await lease.release();

    expect(order).toEqual(["heartbeat", "responder", "storage", "lock"]);
  });

  test("a failed teardown step does not leak the steps after it", async () => {
    const storage = createStorage();
    const lockReleased = vi.fn();
    const locks = {
      async request<T>(_name: string, _options: unknown, callback: (lock: unknown | null) => T | Promise<T>): Promise<T> {
        const result = await callback({});
        lockReleased();
        return result;
      },
    };
    const lease = await new SingleInstanceGuard({ ...isolated, storage, locks, randomUUID: () => "mine" }).acquire(input());
    const setItem = storage.setItem;
    storage.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };

    await expect(lease.release()).resolves.toBeUndefined();

    expect(lockReleased).toHaveBeenCalledOnce();
    expect(storage.getItem(leaseKey)).toBeNull();
    storage.setItem = setItem;
  });

  test("a rejecting heartbeat release does not reject the lease", async () => {
    const nostr: NostrInstanceNetwork = {
      isRunning: async () => false,
      startHeartbeat: () => ({ release: () => Promise.reject(new Error("relay offline")) }),
    };

    const lease = await new SingleInstanceGuard({ ...isolated, nostr }).acquire(input());

    await expect(lease.release()).resolves.toBeUndefined();
  });
});

describe("acquire", () => {
  test("generates an instance token with crypto.randomUUID by default", async () => {
    const nostr: NostrInstanceNetwork = {
      isRunning: async () => false,
      startHeartbeat: vi.fn(() => ({ release: () => undefined })),
    };
    const lease = await new SingleInstanceGuard({ ...isolated, nostr }).acquire(input());
    expect(nostr.startHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ instanceToken: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
      undefined,
    );
    await lease.release();
  });

  test("logs progress through every check when all are unavailable, shortening the key", async () => {
    const debug = vi.fn<DebugSink>();

    const lease = await new SingleInstanceGuard(isolated).acquire(input(debug));

    expect(logged(debug)).toEqual([
      "checking browser instance locks",
      "web lock unavailable",
      "broadcast probe unavailable",
      "storage lease unavailable",
      "nostr instance probe unavailable",
      "single instance guard acquired",
    ]);
    expect(debug).toHaveBeenCalledWith("info", "single instance guard acquired", "abababab...abababab");
    await lease.release();
  });

  test("logs the Nostr check and rejection", async () => {
    const debug = vi.fn<DebugSink>();
    const nostr: NostrInstanceNetwork = { isRunning: async () => true, startHeartbeat: vi.fn() };

    await expect(new SingleInstanceGuard({ ...isolated, nostr }).acquire(input(debug)))
      .rejects.toThrow("cordn already running");

    expect(logged(debug)).toEqual(expect.arrayContaining(["checking nostr for active public key", "nostr probe detected running instance"]));
    expect(new CordnAlreadyRunningError().name).toBe("CordnAlreadyRunningError");
  });

  test("uses the SimplePool network by default", async () => {
    pools.query = async () => [];

    const lease = await new SingleInstanceGuard({ storage: null, locks: null, createBroadcastChannel: null }).acquire(input());

    expect(pools.created).toHaveLength(2);
    await lease.release();
  });
});

describe("SimplePoolNostrInstanceNetwork.isRunning", () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  function heartbeat(overrides: {
    createdAt?: number;
    status?: string | null;
    instance?: string | null;
    expiration?: number | null;
    d?: string;
  } = {}): NostrEvent {
    const { createdAt = nowSeconds(), status = "running", instance = "peer", expiration = nowSeconds() + 20, d = "cordn-browser-instance" } = overrides;
    const tags = [["d", d]];
    if (status !== null) tags.push(["status", status]);
    if (instance !== null) tags.push(["instance", instance]);
    if (expiration !== null) tags.push(["expiration", String(expiration)]);
    return { id: "0".repeat(64), pubkey: publicKeyHex, created_at: createdAt, kind: INSTANCE_HEARTBEAT_KIND, tags, content: "", sig: "1".repeat(128) };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  test("has nothing to ask without relays", async () => {
    await expect(new SimplePoolNostrInstanceNetwork().isRunning(publicKeyHex, [], [])).resolves.toBe(false);
    expect(pools.created).toHaveLength(0);
  });

  test("queries the expected filter with the configured timeout and destroys the pool", async () => {
    await new SimplePoolNostrInstanceNetwork(77).isRunning(publicKeyHex, relayUrls, []);

    const pool = pools.created[0]!;
    expect(pool.querySync).toHaveBeenCalledWith(relayUrls, {
      kinds: [INSTANCE_HEARTBEAT_KIND],
      authors: [publicKeyHex],
      "#d": ["cordn-browser-instance"],
      since: nowSeconds() - 20,
      limit: 8,
    }, { maxWait: 77, label: "cordn-instance-probe" });
    expect(pool.destroy).toHaveBeenCalledOnce();
    expect(pool.options).toEqual({ enablePing: false, enableReconnect: false });
  });

  test.each([
    ["a fresh running heartbeat", () => [heartbeat()], true, "running heartbeat fresh"],
    ["a heartbeat at the freshness boundary", () => [heartbeat({ createdAt: nowSeconds() - 12 })], true, "running heartbeat fresh"],
    ["a heartbeat without expiration", () => [heartbeat({ expiration: null })], true, "running heartbeat fresh"],
    ["a heartbeat from no specific instance", () => [heartbeat({ instance: null })], true, "running heartbeat fresh"],
    ["a stale heartbeat", () => [heartbeat({ createdAt: nowSeconds() - 13 })], false, "running heartbeat ignored"],
    ["an expired heartbeat", () => [heartbeat({ expiration: nowSeconds() })], false, "running heartbeat ignored"],
    ["a stopped heartbeat", () => [heartbeat({ status: "stopped" })], false, "stopped heartbeat ignored"],
    ["a heartbeat without status", () => [heartbeat({ status: null })], false, "unknown heartbeat ignored"],
    ["an event with another d tag", () => [heartbeat({ d: "something-else" })], false, "no heartbeat"],
    ["an ignored instance", () => [heartbeat({ instance: "stopped-here" })], false, "no heartbeat"],
    ["no events", () => [], false, "no heartbeat"],
    ["a newer stop overriding an older running event", () => [
      heartbeat({ createdAt: nowSeconds() - 2 }),
      heartbeat({ status: "stopped" }),
    ], false, "stopped heartbeat ignored"],
    ["a newer running event overriding an older stop", () => [
      heartbeat({ createdAt: nowSeconds() - 2, status: "stopped" }),
      heartbeat(),
    ], true, "running heartbeat fresh"],
  ] satisfies Array<[string, () => NostrEvent[], boolean, string]>)("%s", async (_label, events, expected, detail) => {
    pools.query = async () => events();
    const debug = vi.fn<DebugSink>();

    await expect(new SimplePoolNostrInstanceNetwork().isRunning(publicKeyHex, relayUrls, ["stopped-here"], debug))
      .resolves.toBe(expected);

    expect(debug).toHaveBeenCalledWith("info", "nostr instance probe complete", detail);
  });

  test("a failed probe does not block startup and still closes the pool", async () => {
    const debug = vi.fn<DebugSink>();
    pools.query = async () => { throw new Error("relay offline"); };
    await expect(new SimplePoolNostrInstanceNetwork().isRunning(publicKeyHex, relayUrls, [], debug)).resolves.toBe(false);
    expect(debug).toHaveBeenCalledWith("warn", "nostr instance probe failed", "relay offline");

    pools.query = () => Promise.reject("plain failure");
    await expect(new SimplePoolNostrInstanceNetwork().isRunning(publicKeyHex, relayUrls, [], debug)).resolves.toBe(false);
    expect(debug).toHaveBeenCalledWith("warn", "nostr instance probe failed", "plain failure");

    await expect(new SimplePoolNostrInstanceNetwork().isRunning(publicKeyHex, relayUrls, [])).resolves.toBe(false);
    expect(pools.created.every((pool) => pool.destroy.mock.calls.length === 1)).toBe(true);
  });

  test("works without a debug sink", async () => {
    pools.query = async () => [heartbeat()];
    await expect(new SimplePoolNostrInstanceNetwork().isRunning(publicKeyHex, relayUrls, [])).resolves.toBe(true);
  });
});

describe("SimplePoolNostrInstanceNetwork.startHeartbeat", () => {
  function heartbeatInput(secret = generateSecretKey()) {
    const pubkey = getPublicKey(secret);
    const copies: Uint8Array[] = [];
    return {
      pubkey,
      copies,
      value: {
        publicKeyHex: pubkey,
        relayUrls,
        instanceToken: "token",
        getSecretKeyBytes: () => {
          const copy = new Uint8Array(secret);
          copies.push(copy);
          return copy;
        },
      },
    };
  }

  function publishedEvents(): NostrEvent[] {
    return pools.created[0]!.publish.mock.calls.map((call) => call[1] as NostrEvent);
  }

  function tagOf(event: NostrEvent, name: string): string | undefined {
    return event.tags.find((tag) => tag[0] === name)?.[1];
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  test("is a no-op without relays", async () => {
    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat({ ...heartbeatInput().value, relayUrls: [] });
    expect(pools.created).toHaveLength(0);
    await expect(lease.release()).toBeUndefined();
  });

  test("publishes signed running events on an interval, then a final stop, wiping every key copy", async () => {
    const debug = vi.fn<DebugSink>();
    const heartbeatArgs = heartbeatInput();

    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat(heartbeatArgs.value, debug);
    await vi.advanceTimersByTimeAsync(0);
    expect(publishedEvents()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publishedEvents()).toHaveLength(2);

    await lease.release();
    await vi.advanceTimersByTimeAsync(20_000);

    const events = publishedEvents();
    expect(events).toHaveLength(3);
    expect(events.map((event) => tagOf(event, "status"))).toEqual(["running", "running", "stopped"]);
    for (const event of events) {
      expect(event.kind).toBe(INSTANCE_HEARTBEAT_KIND);
      expect(event.pubkey).toBe(heartbeatArgs.pubkey);
      expect(verifyEvent(event)).toBe(true);
      expect(tagOf(event, "d")).toBe("cordn-browser-instance");
      expect(tagOf(event, "instance")).toBe("token");
    }
    expect(Number(tagOf(events[0]!, "expiration"))).toBe(events[0]!.created_at + 20);
    expect(Number(tagOf(events[2]!, "expiration"))).toBe(events[2]!.created_at + 1);
    expect(events[2]!.content).toBe("cordn browser stopped");
    expect(heartbeatArgs.copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
    expect(pools.created[0]!.destroy).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith("info", "nostr instance running heartbeat published", "1/1 relays");
    expect(debug).toHaveBeenCalledWith("info", "nostr instance stopped heartbeat published", "1/1 relays");
  });

  test("a stop in the same second still has a newer timestamp than the last running event", async () => {
    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat(heartbeatInput().value);
    await lease.release();

    const [running, stopped] = publishedEvents();
    expect(stopped!.created_at).toBeGreaterThan(running!.created_at);
  });

  test("counts only relays that accepted the event", async () => {
    const debug = vi.fn<DebugSink>();
    pools.publish = () => [Promise.reject(new Error("rejected"))];

    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat(heartbeatInput().value, debug);
    await lease.release();

    expect(debug).toHaveBeenCalledWith("info", "nostr instance stopped heartbeat published", "0/1 relays");
  });

  test("a throwing publish is reported and still closes the pool on stop", async () => {
    const debug = vi.fn<DebugSink>();
    pools.publish = () => { throw new Error("pool closed"); };

    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat(heartbeatInput().value, debug);
    await lease.release();

    expect(debug).toHaveBeenCalledWith("warn", "nostr instance heartbeat publish failed", "pool closed");
    expect(pools.created[0]!.destroy).toHaveBeenCalledOnce();
  });

  test("an unusable key is reported, wiped and still closes the pool on stop", async () => {
    const debug = vi.fn<DebugSink>();
    const badKey = new Uint8Array(3).fill(9);

    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat({
      ...heartbeatInput().value,
      getSecretKeyBytes: () => badKey,
    }, debug);
    await lease.release();

    expect(debug).toHaveBeenCalledWith("warn", "nostr instance heartbeat failed", expect.any(String));
    expect(badKey.every((byte) => byte === 0)).toBe(true);
    expect(pools.created[0]!.publish).not.toHaveBeenCalled();
    expect(pools.created[0]!.destroy).toHaveBeenCalledOnce();
  });

  test("a destroyed key manager does not leak the pool or reject", async () => {
    const debug = vi.fn<DebugSink>();
    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat({
      ...heartbeatInput().value,
      getSecretKeyBytes: () => { throw new Error("Coordinator key has been destroyed"); },
    }, debug);

    await expect(lease.release()).resolves.toBeUndefined();

    expect(debug).toHaveBeenCalledWith("warn", "nostr instance heartbeat failed", "Coordinator key has been destroyed");
    expect(pools.created[0]!.destroy).toHaveBeenCalledOnce();
  });

  test("works without a debug sink on every failure path", async () => {
    pools.publish = () => { throw new Error("pool closed"); };
    const first = new SimplePoolNostrInstanceNetwork().startHeartbeat(heartbeatInput().value);
    await expect(first.release()).resolves.toBeUndefined();

    const second = new SimplePoolNostrInstanceNetwork().startHeartbeat({
      ...heartbeatInput().value,
      getSecretKeyBytes: () => new Uint8Array(1),
    });
    await expect(second.release()).resolves.toBeUndefined();
  });

  test("releasing twice publishes one stop and closes the pool once", async () => {
    const lease = new SimplePoolNostrInstanceNetwork().startHeartbeat(heartbeatInput().value);

    await Promise.all([lease.release(), lease.release()]);
    await lease.release();

    expect(publishedEvents().filter((event) => tagOf(event, "status") === "stopped")).toHaveLength(1);
    expect(pools.created[0]!.destroy).toHaveBeenCalledOnce();
  });
});
