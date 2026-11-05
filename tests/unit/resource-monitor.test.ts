import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { normalizeLocalMessageRate, ResourceMonitor } from "../../src/coordinator/resource-monitor.svelte";
import type { RunningTransport } from "@cahmls/sdk/server";

type Handler = () => void;

class EventTransport {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string): void {
    this.handlers.get(event)?.forEach((handler) => handler());
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function runningTransport(
  transport: EventTransport,
  adapter: Partial<RunningTransport["adapter"]> = {},
): RunningTransport {
  return {
    server: {} as RunningTransport["server"],
    transport: transport as unknown as RunningTransport["transport"],
    coordinator: {} as RunningTransport["coordinator"],
    adapter: adapter as RunningTransport["adapter"],
    close: vi.fn(),
  };
}

describe("ResourceMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-06-23T00:00:00Z"));
    Reflect.deleteProperty(globalThis.performance, "memory");
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis.performance, "memory");
    vi.useRealTimers();
  });

  test("tracks subscription and rolling message rate estimates from transport events", () => {
    Object.defineProperty(globalThis.performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 42 * 1_048_576 },
    });
    const source = new EventTransport();
    const monitor = new ResourceMonitor();

    monitor.start(runningTransport(source));
    source.emit("subscribed");
    source.emit("subscribed");
    source.emit("unsubscribed");
    source.emit("message");
    vi.advanceTimersByTime(30_000);
    source.emit("event");

    expect(monitor.subscriptionCount).toBe(1);
    expect(monitor.groupSubscriptionLegCount).toBe(1);
    expect(monitor.messageRate).toBe(2);
    expect(monitor.messageRateMinimum).toBe(0);
    expect(monitor.messageRateMaximum).toBe(1);
    expect(monitor.messageRateIntensity).toBe(1);
    expect(monitor.memoryBytes).toBe(42 * 1_048_576);

    vi.advanceTimersByTime(31_000);

    expect(monitor.messageRate).toBe(1);
  });

  test("normalizes message rates against the recent local range", () => {
    expect(normalizeLocalMessageRate(0, 0, 12)).toBe(0);
    expect(normalizeLocalMessageRate(4, 4, 4)).toBe(0.5);
    expect(normalizeLocalMessageRate(4, 2, 10)).toBe(0.25);
    expect(normalizeLocalMessageRate(12, 2, 10)).toBe(1);
    expect(normalizeLocalMessageRate(1, 2, 10)).toBe(0);
  });

  test("resets state and unbinds listeners on stop", () => {
    const source = new EventTransport();
    const monitor = new ResourceMonitor();

    monitor.start(runningTransport(source));
    source.emit("subscribed");
    source.emit("request");

    monitor.stop();
    source.emit("subscribed");
    source.emit("request");

    expect(monitor.subscriptionCount).toBe(0);
    expect(monitor.groupSubscriptionLegCount).toBe(0);
    expect(monitor.messageRate).toBe(0);
    expect(monitor.messageRateMinimum).toBe(0);
    expect(monitor.messageRateMaximum).toBe(0);
    expect(monitor.messageRateIntensity).toBe(0);
    expect(monitor.memoryBytes).toBeNull();
    expect(source.listenerCount("subscribed")).toBe(0);
    expect(source.listenerCount("request")).toBe(0);
  });

  test("keeps telemetry unavailable when browser memory API is absent", () => {
    const monitor = new ResourceMonitor();

    monitor.start(runningTransport(new EventTransport()));

    expect(monitor.memoryBytes).toBeNull();
  });

  test("tracks active stream and fan-out leg metrics from adapter telemetry", () => {
    let sink: Parameters<RunningTransport["adapter"]["setTelemetrySink"]>[0] | undefined;
    const adapter: Partial<RunningTransport["adapter"]> = {
      setTelemetrySink: vi.fn((nextSink) => {
        sink = nextSink;
      }),
    };
    const monitor = new ResourceMonitor();

    monitor.start(runningTransport(new EventTransport(), adapter));
    sink?.setSubscriptionMetrics?.({ activeStreams: 1, groupLegs: 34 });

    expect(monitor.subscriptionCount).toBe(1);
    expect(monitor.groupSubscriptionLegCount).toBe(34);

    monitor.stop();

    expect(adapter.setTelemetrySink).toHaveBeenLastCalledWith();
    expect(monitor.subscriptionCount).toBe(0);
    expect(monitor.groupSubscriptionLegCount).toBe(0);
  });
});
