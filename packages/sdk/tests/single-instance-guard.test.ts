import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CordnAlreadyRunningError,
  INSTANCE_RUNNING_MESSAGE,
  SingleInstanceGuard,
  type NostrInstanceNetwork,
} from "../src/runtime/single-instance-guard.js";

const publicKeyHex = "f".repeat(64);
const relayUrls = ["wss://relay.example"];

function acquireInput() {
  return {
    publicKeyHex,
    relayUrls,
    getSecretKeyBytes: () => new Uint8Array(32).fill(1),
  };
}

describe("SingleInstanceGuard", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test("blocks a second same-key instance through browser storage lease", async () => {
    const first = new SingleInstanceGuard({
      createBroadcastChannel: null,
      locks: null,
      nostr: null,
      randomUUID: () => "first-token",
    });
    const second = new SingleInstanceGuard({
      createBroadcastChannel: null,
      locks: null,
      nostr: null,
      randomUUID: () => "second-token",
    });

    const lease = await first.acquire(acquireInput());

    await expect(second.acquire(acquireInput())).rejects.toThrow(CordnAlreadyRunningError);
    await expect(second.acquire(acquireInput())).rejects.toThrow(INSTANCE_RUNNING_MESSAGE);

    await lease.release();
    const secondLease = await second.acquire(acquireInput());
    await secondLease.release();
  });

  test("waits for the browser Web Lock to be released before resolving the lease", async () => {
    let held = false;
    const locks = {
      async request<T>(
        _name: string,
        _options: { ifAvailable: true; mode?: "exclusive" },
        callback: (lock: unknown | null) => T | Promise<T>,
      ): Promise<T> {
        if (held) return await callback(null);
        held = true;
        try {
          return await callback({});
        } finally {
          held = false;
        }
      },
    };
    const first = new SingleInstanceGuard({
      storage: null,
      createBroadcastChannel: null,
      locks,
      nostr: null,
    });
    const second = new SingleInstanceGuard({
      storage: null,
      createBroadcastChannel: null,
      locks,
      nostr: null,
    });

    const lease = await first.acquire(acquireInput());
    await expect(second.acquire(acquireInput())).rejects.toThrow(INSTANCE_RUNNING_MESSAGE);

    await lease.release();
    const restartedLease = await second.acquire(acquireInput());
    await restartedLease.release();
  });

  test("blocks when the Nostr public-key probe finds an active heartbeat", async () => {
    const nostr: NostrInstanceNetwork = {
      isRunning: vi.fn().mockResolvedValue(true),
      startHeartbeat: vi.fn().mockReturnValue({ release: vi.fn() }),
    };
    const guard = new SingleInstanceGuard({
      createBroadcastChannel: null,
      locks: null,
      nostr,
      randomUUID: () => "nostr-token",
    });

    await expect(guard.acquire(acquireInput())).rejects.toThrow(INSTANCE_RUNNING_MESSAGE);
    expect(nostr.isRunning).toHaveBeenCalledWith(publicKeyHex, relayUrls, [], undefined);
    expect(nostr.startHeartbeat).not.toHaveBeenCalled();
  });

  test("starts Nostr heartbeat after browser-native checks pass", async () => {
    const release = vi.fn();
    const nostr: NostrInstanceNetwork = {
      isRunning: vi.fn().mockResolvedValue(false),
      startHeartbeat: vi.fn().mockReturnValue({ release }),
    };
    const guard = new SingleInstanceGuard({
      createBroadcastChannel: null,
      locks: null,
      nostr,
      randomUUID: () => "heartbeat-token",
    });

    const lease = await guard.acquire(acquireInput());

    expect(nostr.startHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ publicKeyHex, relayUrls, instanceToken: "heartbeat-token" }),
      undefined,
    );
    await lease.release();
    expect(release).toHaveBeenCalledOnce();
  });
});
