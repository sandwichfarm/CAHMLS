import { afterEach, describe, expect, test, vi } from "vitest";

import { TokenBucketRateLimiter, type TokenBucketRateLimitConfig } from "../src/server/rateLimit.js";

function limiter(overrides: Partial<TokenBucketRateLimitConfig> = {}): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({
    enabled: true,
    refillPerMinute: 60,
    burst: 2,
    idleTtlMs: 10_000,
    ...overrides,
  });
}

describe("TokenBucketRateLimiter", () => {
  afterEach(() => vi.useRealTimers());

  test("always admits requests when disabled, even with an empty bucket configuration", () => {
    const disabled = limiter({ enabled: false, burst: 0, refillPerMinute: 0 });

    for (let request = 0; request < 5; request += 1) {
      expect(disabled.check("client", 0)).toBe(true);
    }
  });

  test("admits exactly the burst and then rejects until tokens refill", () => {
    const bucket = limiter();

    expect(bucket.check("client", 0)).toBe(true);
    expect(bucket.check("client", 0)).toBe(true);
    expect(bucket.check("client", 0)).toBe(false);
    // 60/min is one token per second; just short of a full token stays rejected.
    expect(bucket.check("client", 999)).toBe(false);
    expect(bucket.check("client", 1_000)).toBe(true);
    expect(bucket.check("client", 1_000)).toBe(false);
  });

  test("keeps the fractional tokens earned while rejected", () => {
    const bucket = limiter({ burst: 1 });

    expect(bucket.check("client", 0)).toBe(true);
    expect(bucket.check("client", 400)).toBe(false);
    expect(bucket.check("client", 800)).toBe(false);
    // 1,200ms in total have elapsed, even though each rejection reset the refill clock.
    expect(bucket.check("client", 1_200)).toBe(true);
  });

  test("never refills above the burst", () => {
    const bucket = limiter({ idleTtlMs: 0 });

    expect(bucket.check("client", 0)).toBe(true);
    expect(bucket.check("client", 0)).toBe(true);
    const muchLater = 3_600_000;
    expect(bucket.check("client", muchLater)).toBe(true);
    expect(bucket.check("client", muchLater)).toBe(true);
    expect(bucket.check("client", muchLater)).toBe(false);
  });

  test("tracks each client independently", () => {
    const bucket = limiter({ burst: 1 });

    expect(bucket.check("alice", 0)).toBe(true);
    expect(bucket.check("alice", 0)).toBe(false);
    expect(bucket.check("bob", 0)).toBe(true);
  });

  test("does not grant tokens when the clock moves backwards", () => {
    const bucket = limiter({ burst: 1 });

    expect(bucket.check("client", 5_000)).toBe(true);
    expect(bucket.check("client", 1_000)).toBe(false);
    expect(bucket.check("client", 1_500)).toBe(false);
    expect(bucket.check("client", 2_000)).toBe(true);
  });

  test("evicts a bucket once idle for the TTL, restoring its full burst", () => {
    const bucket = limiter({ burst: 1, refillPerMinute: 0, idleTtlMs: 1_000 });

    expect(bucket.check("idle", 0)).toBe(true);
    expect(bucket.check("idle", 999)).toBe(false);
    // The rejected request at 999ms counted as activity, so the TTL restarts there.
    expect(bucket.check("idle", 1_998)).toBe(false);
    expect(bucket.check("idle", 2_998)).toBe(true);
  });

  test("evicts other idle clients while checking an active one", () => {
    const bucket = limiter({ burst: 1, refillPerMinute: 0, idleTtlMs: 1_000 });
    const entries = () => (bucket as unknown as { buckets: Map<string, unknown> }).buckets;

    bucket.check("idle", 0);
    bucket.check("active", 500);
    expect([...entries().keys()]).toEqual(["idle", "active"]);

    bucket.check("active", 1_000);
    expect([...entries().keys()]).toEqual(["active"]);
  });

  test("retains buckets forever when the idle TTL is disabled", () => {
    const bucket = limiter({ burst: 1, refillPerMinute: 0, idleTtlMs: 0 });

    expect(bucket.check("client", 0)).toBe(true);
    expect(bucket.check("client", Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test.each([
    ["zero", 0],
    ["a fraction below one token", 0.5],
    ["a negative value", -3],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects every request when burst is %s", (_label, burst) => {
    const bucket = limiter({ burst });

    expect(bucket.check("client", 0)).toBe(false);
    expect(bucket.check("client", 60_000)).toBe(false);
  });

  test("treats an invalid refill rate as no refill", () => {
    const bucket = limiter({ burst: 1, refillPerMinute: Number.NaN, idleTtlMs: 0 });

    expect(bucket.check("client", 0)).toBe(true);
    expect(bucket.check("client", 3_600_000)).toBe(false);
  });

  test("uses the wall clock by default", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const bucket = limiter({ burst: 1 });

    expect(bucket.check("client")).toBe(true);
    expect(bucket.check("client")).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(bucket.check("client")).toBe(true);
  });
});
