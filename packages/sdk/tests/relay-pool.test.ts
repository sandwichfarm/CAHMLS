import type { RelayHandler } from "@contextvm/sdk/core";
import type { Filter, NostrEvent } from "nostr-tools";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createRequiredRelayPool,
  REQUIRED_LOCAL_RELAY_URL,
  type RelayPublishDiagnostic,
} from "../src/relay/relay-pool.js";

class FakePool implements RelayHandler {
  readonly connect = vi.fn(async () => undefined);
  readonly disconnect = vi.fn(async () => undefined);
  readonly unsubscribe = vi.fn();
  readonly publish = vi.fn<(event: NostrEvent, options?: { abortSignal?: AbortSignal }) => Promise<void>>(async () => undefined);
  readonly subscribe = vi.fn(async (filters: Filter[], onEvent: (event: NostrEvent) => void) => {
    void filters;
    void onEvent;
    return () => undefined;
  });

  constructor(readonly urls: string[]) {}

  getRelayUrls(): string[] {
    return this.urls;
  }
}

function event(id = "a".repeat(64), kind = 21059): NostrEvent {
  return {
    id,
    kind,
    pubkey: "b".repeat(64),
    created_at: 1,
    tags: [["p", "c".repeat(64)]],
    content: "encrypted-content-must-not-appear-in-diagnostics",
    sig: "d".repeat(128),
  };
}

function harness(overrides: Parameters<typeof createRequiredRelayPool>[1] = {}) {
  const pools: FakePool[] = [];
  const diagnostics: RelayPublishDiagnostic[] = [];
  const handler = createRequiredRelayPool(["wss://relay.example"], {
    operation: "unit-operation",
    createPool: (urls) => {
      const pool = new FakePool(urls);
      pools.push(pool);
      return pool;
    },
    probeRelay: async () => false,
    onPublishDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
  });
  return { handler, pools, diagnostics };
}

function rejectWhenAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

describe("bounded relay publication", () => {
  afterEach(() => vi.useRealTimers());

  test("skips an offline optional localhost and completes through the healthy remote", async () => {
    const probeRelay = vi.fn(async () => false);
    const { handler, pools, diagnostics } = harness({ probeRelay });

    await handler.connect();
    await expect(handler.publish(event())).resolves.toBeUndefined();
    await vi.waitFor(() => expect(probeRelay).toHaveBeenCalledOnce());

    expect(pools[0]?.urls).toEqual(["wss://relay.example"]);
    expect(pools[0]?.publish).toHaveBeenCalledOnce();
    expect(pools[1]?.urls).toEqual([REQUIRED_LOCAL_RELAY_URL]);
    expect(pools[1]?.publish).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      relayUrl: REQUIRED_LOCAL_RELAY_URL,
      operation: "unit-operation",
      path: "optional-local",
      outcome: "skipped",
      eventId: "a".repeat(64),
      eventKind: 21059,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain("encrypted-content");
    await handler.disconnect();
  });

  test("does not await an offline localhost subscription during primary startup", async () => {
    const probeRelay = vi.fn(async () => false);
    const { handler, pools } = harness({ probeRelay });
    const onEvent = vi.fn();

    const unsubscribe = await handler.subscribe([{ kinds: [21059] }], onEvent);

    expect(pools[0]?.subscribe).toHaveBeenCalledOnce();
    expect(pools[1]?.subscribe).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(probeRelay).toHaveBeenCalledWith(REQUIRED_LOCAL_RELAY_URL, expect.any(AbortSignal)));
    unsubscribe();
    await handler.disconnect();
  });

  test("bounds optional-local publication independently of primary success", async () => {
    vi.useFakeTimers();
    const { handler, pools, diagnostics } = harness({
      probeRelay: async () => true,
      policy: { localPublishTimeoutMs: 20, localReadyCacheMs: 1_000 },
    });
    pools[0]?.publish.mockResolvedValue(undefined);
    pools[1]?.publish.mockImplementation((_event, options) => rejectWhenAborted(options?.abortSignal));

    const published = handler.publish(event());
    await expect(published).resolves.toBeUndefined();
    await vi.waitFor(() => expect(pools[1]?.publish).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(21);
    await vi.waitFor(() => expect(diagnostics).toContainEqual(expect.objectContaining({
      path: "optional-local",
      outcome: "aborted",
      attempt: 1,
    })));
    await handler.disconnect();
  });

  test("retries a transient primary failure within the explicit attempt budget", async () => {
    const { handler, pools, diagnostics } = harness({
      policy: { primaryMaxAttempts: 3, primaryRetryDelaysMs: [0, 0] },
    });
    pools[0]?.publish
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce(undefined);

    await expect(handler.publish(event("e".repeat(64), 1059))).resolves.toBeUndefined();

    expect(pools[0]?.publish).toHaveBeenCalledTimes(2);
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "primary", attempt: 1, outcome: "retrying" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "primary", attempt: 2, outcome: "accepted" }));
    await handler.disconnect();
  });

  test("terminates a permanently unavailable primary after the configured lifetime", async () => {
    vi.useFakeTimers();
    const { handler, pools, diagnostics } = harness({
      policy: {
        primaryAttemptTimeoutMs: 20,
        primaryMaxAttempts: 2,
        primaryRetryDelaysMs: [5],
      },
    });
    pools[0]?.publish.mockImplementation((_event, options) => rejectWhenAborted(options?.abortSignal));

    const publication = handler.publish(event());
    const rejection = expect(publication).rejects.toThrow("Relay publication aborted");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(pools[0]?.publish).toHaveBeenCalledTimes(2);
    expect(diagnostics.filter((entry) => entry.path === "primary" && entry.outcome === "attempt")).toHaveLength(2);
    expect(diagnostics.filter((entry) => entry.path === "primary" && entry.outcome === "aborted")).toHaveLength(2);
    await handler.disconnect();
  });

  test("disconnect aborts every pending primary and optional publication", async () => {
    const { handler, pools, diagnostics } = harness({ probeRelay: async () => true });
    pools[0]?.publish.mockImplementation((_event, options) => rejectWhenAborted(options?.abortSignal));
    pools[1]?.publish.mockImplementation((_event, options) => rejectWhenAborted(options?.abortSignal));

    const publication = handler.publish(event());
    const rejection = expect(publication).rejects.toThrow("Relay publication aborted");
    await vi.waitFor(() => expect(pools.every((pool) => pool.publish.mock.calls.length === 1)).toBe(true));
    await handler.disconnect();
    await rejection;

    expect(diagnostics.filter((entry) => entry.outcome === "aborted")).toHaveLength(2);
    expect(pools[0]?.disconnect).toHaveBeenCalledOnce();
    expect(pools[1]?.disconnect).toHaveBeenCalledOnce();
  });
});
