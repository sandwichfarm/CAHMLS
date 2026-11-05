import type { RelayHandler } from "@contextvm/sdk/core";
import type { Filter, NostrEvent } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createRequiredRelayPool,
  RELAY_PUBLISH_DIAGNOSTIC_EVENT,
  RELAY_PUBLISH_POLICY,
  REQUIRED_LOCAL_RELAY_URL,
  shareableRelayUrls,
  withRequiredLocalRelay,
  type RelayPublishDiagnostic,
} from "../src/relay/relay-pool.js";

const applesauce = vi.hoisted(() => ({
  constructed: [] as Array<{ urls: string[]; options: unknown }>,
}));

vi.mock("@contextvm/sdk/relay", () => ({
  ApplesauceRelayPool: class {
    constructor(urls: string[], options: unknown) {
      applesauce.constructed.push({ urls, options });
    }
  },
}));

type PublishOptions = { abortSignal?: AbortSignal };

class FakePool implements RelayHandler {
  readonly connect = vi.fn(async (): Promise<void> => undefined);
  readonly disconnect = vi.fn(async (): Promise<void> => undefined);
  readonly unsubscribe = vi.fn();
  readonly publish = vi.fn<(event: NostrEvent, options?: PublishOptions) => Promise<void>>(async () => undefined);
  readonly unsubscribeOne = vi.fn();
  readonly subscribe = vi.fn<RelayHandler["subscribe"]>(async () => this.unsubscribeOne);

  constructor(readonly urls: string[]) {}

  getRelayUrls(): string[] {
    return this.urls;
  }
}

function event(): NostrEvent {
  return {
    id: "a".repeat(64),
    kind: 21059,
    pubkey: "b".repeat(64),
    created_at: 1,
    tags: [],
    content: "secret-ciphertext",
    sig: "d".repeat(128),
  };
}

function harness(
  overrides: Parameters<typeof createRequiredRelayPool>[1] = {},
  relayUrls: string[] = ["wss://relay.example"],
) {
  const pools: FakePool[] = [];
  const diagnostics: RelayPublishDiagnostic[] = [];
  const handler = createRequiredRelayPool(relayUrls, {
    createPool: (urls) => {
      const pool = new FakePool(urls);
      pools.push(pool);
      return pool;
    },
    probeRelay: async () => false,
    onPublishDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
  });
  return {
    handler,
    primary: pools[0]!,
    local: pools[1],
    pools,
    diagnostics,
    outcomes: (path: RelayPublishDiagnostic["path"]) =>
      diagnostics.filter((entry) => entry.path === path).map((entry) => entry.outcome),
  };
}

function rejectWhenAborted(_event: NostrEvent, options?: PublishOptions): Promise<void> {
  return new Promise((_resolve, reject) => {
    options?.abortSignal?.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
  });
}

/** Lets already-settled promise chains finish without moving fake time. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("relay URL helpers", () => {
  test("appends the required local relay exactly once", () => {
    expect(withRequiredLocalRelay([])).toEqual([REQUIRED_LOCAL_RELAY_URL]);
    expect(withRequiredLocalRelay(["wss://a", "wss://a"])).toEqual(["wss://a", REQUIRED_LOCAL_RELAY_URL]);
    expect(withRequiredLocalRelay([REQUIRED_LOCAL_RELAY_URL, "wss://a"])).toEqual([REQUIRED_LOCAL_RELAY_URL, "wss://a"]);
  });

  test("shares only secure, publicly reachable relays, trimmed and deduplicated", () => {
    expect(shareableRelayUrls([
      " wss://relay.example ",
      "wss://relay.example",
      "wss://other.example/path",
      "ws://insecure.example",
      "https://not-a-relay.example",
      "wss://localhost:4870",
      "wss://127.0.0.1",
      "wss://[::1]:4870",
      REQUIRED_LOCAL_RELAY_URL,
      "not a url",
      "",
    ])).toEqual(["wss://relay.example", "wss://other.example/path"]);
  });
});

describe("relay pool construction", () => {
  beforeEach(() => {
    applesauce.constructed.length = 0;
  });

  test("uses the local relay as the only pool when no remote relay is configured", async () => {
    const { handler, pools, primary, diagnostics } = harness({}, []);

    expect(pools).toHaveLength(1);
    expect(primary.urls).toEqual([REQUIRED_LOCAL_RELAY_URL]);
    expect(handler.getRelayUrls?.()).toEqual([REQUIRED_LOCAL_RELAY_URL]);

    await handler.connect();
    await handler.publish(event());
    await handler.subscribe([{ kinds: [1] }], () => undefined);
    handler.unsubscribe();
    await handler.disconnect();

    expect(primary.publish).toHaveBeenCalledOnce();
    expect(primary.subscribe).toHaveBeenCalledOnce();
    expect(primary.unsubscribe).toHaveBeenCalledOnce();
    expect(primary.disconnect).toHaveBeenCalledOnce();
    expect(diagnostics.every((entry) => entry.path === "primary")).toBe(true);
  });

  test("advertises every relay, including the optional local one", () => {
    const { handler } = harness({}, ["wss://a", "wss://b"]);

    expect(handler.getRelayUrls?.()).toEqual(["wss://a", "wss://b", REQUIRED_LOCAL_RELAY_URL]);
  });

  test("builds real pools whose SDK publish budget fits inside each attempt", () => {
    createRequiredRelayPool(["wss://relay.example"], { probeRelay: async () => false });

    expect(applesauce.constructed).toEqual([
      {
        urls: ["wss://relay.example"],
        options: { publishOptions: { timeout: RELAY_PUBLISH_POLICY.primaryColdAttemptTimeoutMs - 250, retries: 0 } },
      },
      {
        urls: [REQUIRED_LOCAL_RELAY_URL],
        options: { publishOptions: { timeout: RELAY_PUBLISH_POLICY.localPublishTimeoutMs - 250, retries: 0 } },
      },
    ]);
  });

  test("never gives the SDK less than its minimum publish timeout", () => {
    createRequiredRelayPool([], { policy: { primaryAttemptTimeoutMs: 100 } });

    expect(applesauce.constructed[0]?.options).toEqual({ publishOptions: { timeout: 250, retries: 0 } });
  });
});

describe("relay connection lifecycle", () => {
  test("connects the primary and does not let a failing local relay affect it", async () => {
    const { handler, primary, local } = harness();
    local!.connect.mockRejectedValue(new Error("local offline"));

    await expect(handler.connect()).resolves.toBeUndefined();

    expect(primary.connect).toHaveBeenCalledOnce();
    expect(local!.connect).toHaveBeenCalledOnce();
  });

  test("propagates a primary connection failure", async () => {
    const { handler, primary, local } = harness();
    primary.connect.mockRejectedValue(new Error("primary offline"));

    await expect(handler.connect()).rejects.toThrow("primary offline");
    expect(local!.connect).not.toHaveBeenCalled();
  });

  test("refuses to connect, publish or subscribe after disconnecting", async () => {
    const { handler, primary } = harness();
    await handler.disconnect();

    await expect(handler.connect()).rejects.toMatchObject({ name: "AbortError" });
    await expect(handler.publish(event())).rejects.toMatchObject({ name: "AbortError" });
    await expect(handler.subscribe([], () => undefined)).rejects.toMatchObject({ name: "AbortError" });
    expect(primary.connect).not.toHaveBeenCalled();
    expect(primary.publish).not.toHaveBeenCalled();
    expect(primary.subscribe).not.toHaveBeenCalled();
  });

  test("disconnect tolerates failing pools and can be repeated", async () => {
    const { handler, primary, local } = harness();
    primary.disconnect.mockRejectedValue(new Error("already gone"));
    local!.disconnect.mockRejectedValue(new Error("already gone"));

    await expect(handler.disconnect()).resolves.toBeUndefined();
    await expect(handler.disconnect()).resolves.toBeUndefined();

    expect(primary.disconnect).toHaveBeenCalledTimes(2);
    expect(local!.disconnect).toHaveBeenCalledTimes(2);
  });
});

describe("primary publication", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("reports attempts with elapsed time from the injected clock and no event content", async () => {
    let clock = 1_000;
    const { handler, primary, diagnostics } = harness({ now: () => clock, operation: "op" });
    primary.publish.mockImplementation(async () => {
      clock += 25;
    });

    await handler.publish(event());
    await settle();

    expect(diagnostics.filter((entry) => entry.path === "primary")).toEqual([
      {
        relayUrl: "wss://relay.example",
        eventId: event().id,
        eventKind: 21059,
        operation: "op",
        path: "primary",
        attempt: 1,
        elapsedMs: 0,
        outcome: "attempt",
      },
      {
        relayUrl: "wss://relay.example",
        eventId: event().id,
        eventKind: 21059,
        operation: "op",
        path: "primary",
        attempt: 1,
        elapsedMs: 25,
        outcome: "accepted",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-ciphertext");
  });

  test("defaults the operation name and clamps elapsed time when the clock steps back", async () => {
    let clock = 1_000;
    const { handler, primary, diagnostics } = harness({ now: () => clock });
    primary.publish.mockImplementation(async () => {
      clock -= 500;
    });

    await handler.publish(event());

    expect(diagnostics.find((entry) => entry.outcome === "accepted")).toMatchObject({
      operation: "contextvm",
      elapsedMs: 0,
    });
  });

  test("emits one diagnostic per primary relay", async () => {
    const { handler, diagnostics } = harness({}, ["wss://a", "wss://b"]);

    await handler.publish(event());

    expect(diagnostics.filter((entry) => entry.outcome === "accepted").map((entry) => entry.relayUrl)).toEqual([
      "wss://a",
      "wss://b",
    ]);
  });

  test("surfaces the last error once the retry budget is exhausted", async () => {
    const { handler, primary, outcomes } = harness({ policy: { primaryRetryDelaysMs: [10] } });
    primary.publish
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("last failure"));

    const publication = handler.publish(event());
    const rejection = expect(publication).rejects.toThrow("last failure");
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(primary.publish).toHaveBeenCalledTimes(2);
    expect(outcomes("primary")).toEqual(["attempt", "failed", "retrying", "attempt", "failed"]);
  });

  test("waits for the configured delay between attempts", async () => {
    const { handler, primary } = harness({ policy: { primaryRetryDelaysMs: [100] } });
    primary.publish.mockRejectedValueOnce(new Error("transient"));

    const publication = handler.publish(event());
    await vi.advanceTimersByTimeAsync(99);
    expect(primary.publish).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await publication;
    expect(primary.publish).toHaveBeenCalledTimes(2);
  });

  test("retries immediately when no delay is configured for an attempt", async () => {
    const { handler, primary } = harness({ policy: { primaryMaxAttempts: 3, primaryRetryDelaysMs: [] } });
    primary.publish
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"));

    const publication = handler.publish(event());
    await vi.runAllTimersAsync();
    await publication;

    expect(primary.publish).toHaveBeenCalledTimes(3);
  });

  test("fails without publishing when the policy allows no attempts", async () => {
    const { handler, primary } = harness({ policy: { primaryMaxAttempts: 0 } });

    await expect(handler.publish(event())).rejects.toThrow("Relay publication failed");
    expect(primary.publish).not.toHaveBeenCalled();
  });

  test("treats a pool throwing synchronously as a failed attempt", async () => {
    const { handler, primary, outcomes } = harness({ policy: { primaryMaxAttempts: 1 } });
    primary.publish.mockImplementation(() => {
      throw new Error("sync failure");
    });

    await expect(handler.publish(event())).rejects.toThrow("sync failure");
    expect(outcomes("primary")).toEqual(["attempt", "failed"]);
  });

  test.each([
    ["an AbortError", Object.assign(new Error("stopped"), { name: "AbortError" })],
    ["the SDK's abort message", new Error("Publish aborted")],
  ])("classifies %s from the pool as aborted, then retries", async (_label, failure) => {
    const { handler, primary, outcomes } = harness({ policy: { primaryRetryDelaysMs: [0] } });
    primary.publish.mockRejectedValueOnce(failure);

    const publication = handler.publish(event());
    await settle();
    await publication;

    expect(outcomes("primary")).toEqual(["attempt", "aborted", "retrying", "attempt", "accepted"]);
  });

  test("does not count a non-Error rejection as an abort", async () => {
    const { handler, primary, outcomes } = harness({ policy: { primaryMaxAttempts: 1 } });
    primary.publish.mockRejectedValue("plain failure");

    await expect(handler.publish(event())).rejects.toBe("plain failure");
    expect(outcomes("primary")).toEqual(["attempt", "failed"]);
  });

  test("times out an unresponsive attempt and aborts the pool's signal", async () => {
    const { handler, primary, outcomes } = harness({
      policy: { primaryAttemptTimeoutMs: 20, primaryMaxAttempts: 1 },
    });
    primary.publish.mockImplementation(() => new Promise(() => undefined));

    const publication = handler.publish(event());
    const rejection = expect(publication).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;

    expect(primary.publish.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(true);
    expect(outcomes("primary")).toEqual(["attempt", "aborted"]);
  });

  test("rejects a publication that resolves after the signal was aborted synchronously", async () => {
    const abort = new AbortController();
    const { handler, primary, outcomes } = harness();
    primary.publish.mockImplementation(async () => {
      abort.abort();
    });

    await expect(handler.publish(event(), { abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });

    expect(primary.publish).toHaveBeenCalledOnce();
    expect(outcomes("primary")).toEqual(["attempt", "aborted"]);
  });

  test("does not publish at all when the caller already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const { handler, primary, local } = harness({ probeRelay: async () => true });

    await expect(handler.publish(event(), { abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    await settle();

    expect(primary.publish).not.toHaveBeenCalled();
    expect(local!.publish).not.toHaveBeenCalled();
  });

  test("does not retry after the caller aborts an in-flight attempt", async () => {
    const abort = new AbortController();
    const { handler, primary, outcomes } = harness();
    primary.publish.mockImplementation(rejectWhenAborted);

    const publication = handler.publish(event(), { abortSignal: abort.signal });
    const rejection = expect(publication).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    abort.abort();
    await rejection;

    expect(primary.publish).toHaveBeenCalledOnce();
    expect(outcomes("primary")).toEqual(["attempt", "aborted"]);
  });

  test("a caller abort during the retry delay cancels the remaining attempts", async () => {
    const abort = new AbortController();
    const { handler, primary } = harness({ policy: { primaryRetryDelaysMs: [1_000] } });
    primary.publish.mockRejectedValue(new Error("transient"));

    const publication = handler.publish(event(), { abortSignal: abort.signal });
    const rejection = expect(publication).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    await rejection;

    expect(primary.publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a caller abort raised while reporting the retry skips the delay", async () => {
    const abort = new AbortController();
    const { handler, primary } = harness({
      policy: { primaryRetryDelaysMs: [1_000] },
      onPublishDiagnostic: (diagnostic) => {
        if (diagnostic.outcome === "retrying") abort.abort();
      },
    });
    primary.publish.mockRejectedValue(new Error("transient"));

    await expect(handler.publish(event(), { abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });

    expect(primary.publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("disconnect during the retry delay ends the publication", async () => {
    const { handler, primary } = harness({ policy: { primaryRetryDelaysMs: [1_000] } });
    primary.publish.mockRejectedValue(new Error("transient"));

    const publication = handler.publish(event());
    const rejection = expect(publication).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10);
    await handler.disconnect();
    await rejection;

    expect(primary.publish).toHaveBeenCalledOnce();
  });

  test("removes its abort listeners after a successful publication", async () => {
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const { handler } = harness();

    await handler.publish(event(), { abortSignal: abort.signal });
    await settle();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a throwing diagnostics callback cannot fail or orphan a publication", async () => {
    const { handler, primary, local } = harness({
      probeRelay: async () => true,
      onPublishDiagnostic: () => {
        throw new Error("observer bug");
      },
    });

    await expect(handler.publish(event())).resolves.toBeUndefined();
    await settle();

    expect(primary.publish).toHaveBeenCalledOnce();
    expect(local!.publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(handler.disconnect()).resolves.toBeUndefined();
  });
});

describe("optional local publication", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("publishes to the local relay when it is reachable", async () => {
    const probeRelay = vi.fn(async () => true);
    const { handler, local, outcomes } = harness({ probeRelay });

    await handler.publish(event());
    await settle();

    expect(probeRelay).toHaveBeenCalledWith(REQUIRED_LOCAL_RELAY_URL, expect.any(AbortSignal));
    expect(local!.publish).toHaveBeenCalledOnce();
    expect(outcomes("optional-local")).toEqual(["attempt", "accepted"]);
  });

  test("caches readiness until the cache window ends", async () => {
    let clock = 0;
    const probeRelay = vi.fn(async () => true);
    const { handler, local } = harness({ probeRelay, now: () => clock, policy: { localReadyCacheMs: 100 } });

    await handler.publish(event());
    await settle();
    clock = 99;
    await handler.publish(event());
    await settle();
    expect(probeRelay).toHaveBeenCalledOnce();
    expect(local!.publish).toHaveBeenCalledTimes(2);

    clock = 100;
    await handler.publish(event());
    await settle();
    expect(probeRelay).toHaveBeenCalledTimes(2);
  });

  test("a local failure never fails the primary and invalidates cached readiness", async () => {
    const probeRelay = vi.fn(async () => true);
    const { handler, local, outcomes } = harness({ probeRelay, now: () => 0 });
    local!.publish.mockRejectedValueOnce(new Error("local failure"));

    await expect(handler.publish(event())).resolves.toBeUndefined();
    await settle();
    expect(outcomes("optional-local")).toEqual(["attempt", "failed"]);

    await handler.publish(event());
    await settle();
    expect(probeRelay).toHaveBeenCalledTimes(2);
  });

  test("a primary failure does not stop local delivery", async () => {
    const { handler, primary, local } = harness({
      probeRelay: async () => true,
      policy: { primaryMaxAttempts: 1 },
    });
    primary.publish.mockRejectedValue(new Error("primary down"));

    await expect(handler.publish(event())).rejects.toThrow("primary down");
    await settle();

    expect(local!.publish).toHaveBeenCalledOnce();
  });

  test("skips local delivery when the probe throws", async () => {
    const { handler, local, outcomes } = harness({
      probeRelay: async () => {
        throw new Error("probe failure");
      },
    });

    await handler.publish(event());
    await settle();

    expect(local!.publish).not.toHaveBeenCalled();
    expect(outcomes("optional-local")).toEqual(["skipped"]);
  });

  test("bounds the probe and skips when it reports ready only after its timeout", async () => {
    const seen: AbortSignal[] = [];
    const { handler, local, outcomes } = harness({
      policy: { localReadyTimeoutMs: 50 },
      probeRelay: (_url, signal) => {
        seen.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(true), { once: true });
        });
      },
    });

    await handler.publish(event());
    await settle();
    expect(seen[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(50);

    expect(seen[0]?.aborted).toBe(true);
    expect(local!.publish).not.toHaveBeenCalled();
    expect(outcomes("optional-local")).toEqual(["skipped"]);
  });

  test("a caller abort cancels a pending probe", async () => {
    const abort = new AbortController();
    const probeRelay = vi.fn((_url: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
    }));
    const { handler, primary, outcomes } = harness({ probeRelay });
    primary.publish.mockImplementation(rejectWhenAborted);

    const rejection = expect(handler.publish(event(), { abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    abort.abort();
    await rejection;
    await settle();

    expect(outcomes("optional-local")).toEqual(["skipped"]);
  });

  test("does not start local delivery once disconnected during the same tick", async () => {
    const { handler, local } = harness({ probeRelay: async () => true });
    await handler.disconnect();

    await expect(handler.publish(event())).rejects.toMatchObject({ name: "AbortError" });
    await settle();

    expect(local!.publish).not.toHaveBeenCalled();
  });

  test("disconnect waits for an in-flight local publication to wind down", async () => {
    const { handler, local, outcomes } = harness({ probeRelay: async () => true });
    local!.publish.mockImplementation(rejectWhenAborted);

    await handler.publish(event());
    await settle();
    expect(local!.publish).toHaveBeenCalledOnce();

    await handler.disconnect();

    expect(outcomes("optional-local")).toEqual(["attempt", "aborted"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("relay subscriptions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const filters: Filter[] = [{ kinds: [21059] }];

  test("subscribes both pools when the local relay is ready and releases both", async () => {
    const onEvent = vi.fn();
    const onEose = vi.fn();
    const { handler, primary, local } = harness({ probeRelay: async () => true });

    const unsubscribe = await handler.subscribe(filters, onEvent, onEose);
    await settle();

    expect(primary.subscribe).toHaveBeenCalledWith(filters, onEvent, onEose);
    expect(local!.subscribe).toHaveBeenCalledWith(filters, onEvent, onEose);

    unsubscribe();

    expect(primary.unsubscribeOne).toHaveBeenCalledOnce();
    expect(local!.unsubscribeOne).toHaveBeenCalledOnce();
  });

  test("does not subscribe locally when unsubscribed before the probe finishes", async () => {
    let finishProbe: (ready: boolean) => void = () => undefined;
    const { handler, primary, local } = harness({
      probeRelay: () => new Promise((resolve) => {
        finishProbe = resolve;
      }),
    });

    const unsubscribe = await handler.subscribe(filters, () => undefined);
    unsubscribe();
    finishProbe(true);
    await settle();

    expect(primary.unsubscribeOne).toHaveBeenCalledOnce();
    expect(local!.subscribe).not.toHaveBeenCalled();
  });

  test("releases a local subscription that resolves after the caller unsubscribed", async () => {
    let finishSubscribe: (unsubscribe: () => void) => void = () => undefined;
    const { handler, local } = harness({ probeRelay: async () => true });
    local!.subscribe.mockImplementation(() => new Promise((resolve) => {
      finishSubscribe = resolve;
    }));
    const lateUnsubscribe = vi.fn();

    const unsubscribe = await handler.subscribe(filters, () => undefined);
    await settle();
    expect(local!.subscribe).toHaveBeenCalledOnce();

    unsubscribe();
    finishSubscribe(lateUnsubscribe);
    await settle();

    expect(lateUnsubscribe).toHaveBeenCalledOnce();
  });

  test("global unsubscribe releases both pools and stops a pending local subscription", async () => {
    let finishProbe: (ready: boolean) => void = () => undefined;
    const { handler, primary, local } = harness({
      probeRelay: () => new Promise((resolve) => {
        finishProbe = resolve;
      }),
    });

    await handler.subscribe(filters, () => undefined);
    handler.unsubscribe();
    finishProbe(true);
    await settle();

    expect(primary.unsubscribe).toHaveBeenCalledOnce();
    expect(local!.unsubscribe).toHaveBeenCalledOnce();
    expect(local!.subscribe).not.toHaveBeenCalled();
  });

  test("releases a local subscription that resolves after a global unsubscribe", async () => {
    let finishSubscribe: (unsubscribe: () => void) => void = () => undefined;
    const { handler, local } = harness({ probeRelay: async () => true });
    local!.subscribe.mockImplementation(() => new Promise((resolve) => {
      finishSubscribe = resolve;
    }));
    const lateUnsubscribe = vi.fn();

    await handler.subscribe(filters, () => undefined);
    await settle();
    handler.unsubscribe();
    finishSubscribe(lateUnsubscribe);
    await settle();

    expect(lateUnsubscribe).toHaveBeenCalledOnce();
  });

  test("a subscription opened after a global unsubscribe still reaches the local relay", async () => {
    const { handler, local } = harness({ probeRelay: async () => true });

    await handler.subscribe(filters, () => undefined);
    await settle();
    handler.unsubscribe();
    await handler.subscribe(filters, () => undefined);
    await settle();

    expect(local!.subscribe).toHaveBeenCalledTimes(2);
  });

  test("releases a local subscription that resolves after disconnect", async () => {
    let finishSubscribe: (unsubscribe: () => void) => void = () => undefined;
    const { handler, local } = harness({ probeRelay: async () => true });
    local!.subscribe.mockImplementation(() => new Promise((resolve) => {
      finishSubscribe = resolve;
    }));
    const lateUnsubscribe = vi.fn();

    await handler.subscribe(filters, () => undefined);
    await settle();

    const disconnected = handler.disconnect();
    finishSubscribe(lateUnsubscribe);
    await disconnected;

    expect(lateUnsubscribe).toHaveBeenCalledOnce();
  });

  test("skips the local subscription when the relay is not ready or the probe times out", async () => {
    const offline = harness({ probeRelay: async () => false });
    await offline.handler.subscribe(filters, () => undefined);
    await settle();
    expect(offline.local!.subscribe).not.toHaveBeenCalled();

    const slow = harness({
      policy: { localReadyTimeoutMs: 10 },
      probeRelay: (_url, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(true), { once: true });
      }),
    });
    await slow.handler.subscribe(filters, () => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(slow.local!.subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    ["the probe", "probe"],
    ["the local pool", "pool"],
  ])("a rejection from %s leaves the primary subscription working", async (_label, source) => {
    const { handler, primary, local } = harness({
      probeRelay: async () => {
        if (source === "probe") throw new Error("probe failure");
        return true;
      },
    });
    local!.subscribe.mockRejectedValue(new Error("local failure"));

    const unsubscribe = await handler.subscribe(filters, () => undefined);
    await settle();
    unsubscribe();

    expect(primary.unsubscribeOne).toHaveBeenCalledOnce();
    expect(local!.unsubscribeOne).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("propagates a primary subscription failure without touching the local relay", async () => {
    const probeRelay = vi.fn(async () => true);
    const { handler, primary, local } = harness({ probeRelay });
    primary.subscribe.mockRejectedValue(new Error("primary refused"));

    await expect(handler.subscribe(filters, () => undefined)).rejects.toThrow("primary refused");
    await settle();

    expect(probeRelay).not.toHaveBeenCalled();
    expect(local!.subscribe).not.toHaveBeenCalled();
  });

  test("disconnect waits for and aborts a pending local subscription probe", async () => {
    const signals: AbortSignal[] = [];
    const { handler, local } = harness({
      probeRelay: (_url, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(true), { once: true });
        });
      },
    });

    await handler.subscribe(filters, () => undefined);
    await settle();
    await handler.disconnect();

    expect(signals[0]?.aborted).toBe(true);
    expect(local!.subscribe).not.toHaveBeenCalled();
  });
});

describe("default local relay probe", () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    static failOnConstruct = false;

    readyState = FakeWebSocket.CONNECTING;
    readonly close = vi.fn(() => {
      this.readyState = FakeWebSocket.CLOSED;
    });
    private readonly listeners = new Map<string, () => void>();

    constructor(readonly url: string) {
      if (FakeWebSocket.failOnConstruct) throw new Error("blocked by mixed content");
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }

    fire(type: "open" | "error" | "close", readyState = this.readyState): void {
      this.readyState = readyState;
      this.listeners.get(type)?.();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    FakeWebSocket.failOnConstruct = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function probeHarness() {
    return harness({ probeRelay: undefined });
  }

  const socket = () => FakeWebSocket.instances[0]!;

  test("an open socket means ready, and the probe closes it", async () => {
    const { handler, local } = probeHarness();

    await handler.publish(event());
    expect(socket().url).toBe(REQUIRED_LOCAL_RELAY_URL);
    socket().fire("open", FakeWebSocket.OPEN);
    await settle();

    expect(socket().close).toHaveBeenCalledOnce();
    expect(local!.publish).toHaveBeenCalledOnce();
  });

  test("an error event means not ready and closes the socket", async () => {
    const { handler, local, outcomes } = probeHarness();

    await handler.publish(event());
    socket().fire("error");
    await settle();

    expect(socket().close).toHaveBeenCalledOnce();
    expect(local!.publish).not.toHaveBeenCalled();
    expect(outcomes("optional-local")).toEqual(["skipped"]);
  });

  test("a socket that is already closing is not closed again", async () => {
    const { handler, local } = probeHarness();

    await handler.publish(event());
    socket().fire("close", FakeWebSocket.CLOSED);
    await settle();

    expect(socket().close).not.toHaveBeenCalled();
    expect(local!.publish).not.toHaveBeenCalled();
  });

  test("only the first socket event decides the result", async () => {
    const { handler, local } = probeHarness();

    await handler.publish(event());
    socket().fire("open", FakeWebSocket.OPEN);
    socket().fire("error");
    await settle();

    expect(socket().close).toHaveBeenCalledOnce();
    expect(local!.publish).toHaveBeenCalledOnce();
  });

  test("a connection that never opens is abandoned at the readiness timeout", async () => {
    const { handler, local, outcomes } = harness({
      probeRelay: undefined,
      policy: { localReadyTimeoutMs: 30 },
    });

    await handler.publish(event());
    await vi.advanceTimersByTimeAsync(30);

    expect(socket().close).toHaveBeenCalledOnce();
    expect(local!.publish).not.toHaveBeenCalled();
    expect(outcomes("optional-local")).toEqual(["skipped"]);
  });

  test("a socket constructor failure means not ready", async () => {
    FakeWebSocket.failOnConstruct = true;
    const { handler, local, outcomes } = probeHarness();

    await handler.publish(event());
    await settle();

    expect(local!.publish).not.toHaveBeenCalled();
    expect(outcomes("optional-local")).toEqual(["skipped"]);
  });

  test("does not open a socket when already aborted before probing", async () => {
    const abort = new AbortController();
    // The caller's signal aborts in the synchronous gap between the optional
    // path's own guard and the probe, on the second clock read.
    let reads = 0;
    const { handler, outcomes } = harness({
      probeRelay: undefined,
      now: () => {
        reads += 1;
        if (reads === 2) abort.abort();
        return 0;
      },
    });

    await expect(handler.publish(event(), { abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    await settle();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(outcomes("optional-local")).toEqual(["skipped"]);
  });
});

describe("default diagnostics sink", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("dispatches each diagnostic as a window event", async () => {
    const received: RelayPublishDiagnostic[] = [];
    const listener = (entry: Event) => received.push((entry as CustomEvent<RelayPublishDiagnostic>).detail);
    window.addEventListener(RELAY_PUBLISH_DIAGNOSTIC_EVENT, listener);
    try {
      const { handler } = harness({ onPublishDiagnostic: undefined });
      await handler.publish(event());
      await vi.waitFor(() => expect(received.map((entry) => entry.outcome)).toContain("accepted"));
      expect(received.map((entry) => entry.path)).toContain("primary");
      expect(received.find((entry) => entry.outcome === "accepted")).toMatchObject({ relayUrl: "wss://relay.example" });
    } finally {
      window.removeEventListener(RELAY_PUBLISH_DIAGNOSTIC_EVENT, listener);
    }
  });

  test("does nothing outside a browser window", async () => {
    vi.stubGlobal("window", undefined);
    const { handler, primary } = harness({ onPublishDiagnostic: undefined });

    await expect(handler.publish(event())).resolves.toBeUndefined();
    expect(primary.publish).toHaveBeenCalledOnce();
  });
});
