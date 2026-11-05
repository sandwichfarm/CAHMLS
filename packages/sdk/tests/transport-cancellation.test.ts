import type { JSONRPCMessage } from "@contextvm/mcp-sdk/types";
import { describe, expect, test, vi } from "vitest";

import { abortCancelledOpenStream } from "../src/server/transport.js";

function createInspectableTransport(
  writers: Map<string, { isActive: boolean; abort: (reason?: string) => Promise<void> }>,
  routes: Map<string, { originalRequestId: string | number }> = new Map(),
) {
  return {
    getInternalStateForTesting: () => ({
      correlationStore: {
        getEventRoute: (eventId: string) => routes.get(eventId),
      },
      openStreamWriters: writers,
    }),
  };
}

function cancellation(requestId: string | number, reason = "client closed view"): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: {
      requestId,
      reason,
    },
  };
}

describe("abortCancelledOpenStream", () => {
  test("aborts an active open stream when cancellation uses the Nostr event id", async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const transport = createInspectableTransport(new Map([["event-123", { isActive: true, abort }]]));

    await expect(abortCancelledOpenStream(transport as never, cancellation("event-123", "gone"))).resolves.toBe("event-123");

    expect(abort).toHaveBeenCalledWith("gone");
  });

  test("aborts an active open stream when cancellation uses the original JSON-RPC request id", async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const transport = createInspectableTransport(
      new Map([["nostr-event-id", { isActive: true, abort }]]),
      new Map([["nostr-event-id", { originalRequestId: "client-request-id" }]]),
    );

    await expect(
      abortCancelledOpenStream(transport as never, cancellation("client-request-id", "user cancelled")),
    ).resolves.toBe("nostr-event-id");

    expect(abort).toHaveBeenCalledWith("user cancelled");
  });

  test("ignores cancellations that do not match an active open stream", async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const transport = createInspectableTransport(new Map([["event-123", { isActive: false, abort }]]));

    await expect(abortCancelledOpenStream(transport as never, cancellation("missing-request"))).resolves.toBeUndefined();
    await expect(abortCancelledOpenStream(transport as never, cancellation("event-123"))).resolves.toBeUndefined();

    expect(abort).not.toHaveBeenCalled();
  });
});
