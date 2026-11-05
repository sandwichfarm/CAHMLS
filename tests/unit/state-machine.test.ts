import { describe, expect, test, vi } from "vitest";

import { configStore } from "../../src/config/config.svelte";
import { isConfigLocked, transitionCoordinator } from "@cahmls/sdk/runtime";
import { CoordinatorStore, ROOM_RECOVERY_POLICY, type CoordinatorStoreRuntime } from "../../src/coordinator/coordinator.svelte";
import {
  CHAT_COORDINATOR_CONNECT_TIMEOUT_MS,
  CHAT_COORDINATOR_REQUEST_TIMEOUT_MS,
} from "@cahmls/sdk/client";
import type { RunningTransport } from "@cahmls/sdk/server";
import type { InstanceLease } from "@cahmls/sdk/runtime";
import type { CoordinatorProfilePublisherInput } from "@cahmls/sdk/runtime";
import type { HostedRoomRecoveryTarget } from "@cahmls/sdk/runtime";
import {
  createHostedRoomRecoveryProgress,
  type CoordinatorEvent,
  type CoordinatorStatus,
} from "@cahmls/sdk/runtime";

describe("transitionCoordinator", () => {
  test.each([
    ["idle", "start", "starting"],
    ["starting", "started", "running"],
    ["running", "stop", "stopping"],
    ["starting", "stop", "stopping"],
    ["stopping", "stopped", "idle"],
    ["starting", "error", "idle"],
    ["stopping", "error", "idle"],
  ] satisfies Array<[CoordinatorStatus, CoordinatorEvent, CoordinatorStatus]>)(
    "%s + %s -> %s",
    (state, event, expected) => {
      expect(transitionCoordinator(state, event)).toBe(expected);
    },
  );

  test.each([
    ["idle", "stop"],
    ["running", "start"],
    ["stopping", "start"],
  ] satisfies Array<[CoordinatorStatus, CoordinatorEvent]>)(
    "rejects invalid transition %s + %s",
    (state, event) => {
      expect(() => transitionCoordinator(state, event)).toThrow("Invalid coordinator transition");
    },
  );
});

describe("isConfigLocked", () => {
  test.each([
    ["idle", false],
    ["starting", true],
    ["running", true],
    ["stopping", true],
  ] satisfies Array<[CoordinatorStatus, boolean]>)("returns %s for %s", (state, expected) => {
    expect(isConfigLocked(state)).toBe(expected);
  });
});

test("hosted room recovery outlives the client connect and first request budgets", () => {
  expect(ROOM_RECOVERY_POLICY.attemptTimeoutMs.at(-1)).toBeGreaterThan(
    CHAT_COORDINATOR_CONNECT_TIMEOUT_MS + CHAT_COORDINATOR_REQUEST_TIMEOUT_MS,
  );
});

describe("hosted room recovery progress", () => {
  test("makes a zero-room recovery visibly complete before the coordinator becomes ready", () => {
    expect(createHostedRoomRecoveryProgress({
      state: "complete",
      completed: 0,
      total: 0,
    })).toMatchObject({
      state: "complete",
      completed: 0,
      total: 0,
      roomName: null,
      diagnostic: "No rooms to restore",
    });
  });

  test("retains the exact current room and completed count for a retry", () => {
    expect(createHostedRoomRecoveryProgress({
      state: "retrying",
      completed: 1,
      total: 2,
      roomName: "Project planning",
      attempt: 2,
    })).toMatchObject({
      state: "retrying",
      completed: 1,
      total: 2,
      roomName: "Project planning",
      attempt: 2,
      diagnostic: "Trying again…",
    });
  });
});

describe("coordinator recovery policy", () => {
  const targetA: HostedRoomRecoveryTarget = {
    coordinatorPubkey: "a".repeat(64),
    roomId: "alpha",
    roomName: "Alpha",
    roomIdentityKey: `${"a".repeat(64)}:alpha`,
  };
  const targetB: HostedRoomRecoveryTarget = {
    coordinatorPubkey: "b".repeat(64),
    roomId: "bravo",
    roomName: "Bravo",
    roomIdentityKey: `${"b".repeat(64)}:bravo`,
  };

  interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason?: unknown): void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function lifecycleRuntime(completeSetup = true) {
    configStore.resetToDefaults();
    if (completeSetup) configStore.completeSetup("Test coordinator");
    const leases: Array<InstanceLease & { release: ReturnType<typeof vi.fn> }> = [];
    const transports: Array<RunningTransport & { close: ReturnType<typeof vi.fn> }> = [];
    const acquireInstanceLease = vi.fn<CoordinatorStoreRuntime["acquireInstanceLease"]>(async () => {
      const lease = { release: vi.fn(async () => undefined) };
      leases.push(lease);
      return lease;
    });
    const createTransport = vi.fn<CoordinatorStoreRuntime["createTransport"]>(async () => {
      const transport = { close: vi.fn() } as unknown as RunningTransport & { close: ReturnType<typeof vi.fn> };
      transports.push(transport);
      return transport;
    });
    const closeTransport = vi.fn<CoordinatorStoreRuntime["closeTransport"]>((transport) => transport.close());
    const startResourceMonitor = vi.fn<CoordinatorStoreRuntime["startResourceMonitor"]>();
    const stopResourceMonitor = vi.fn<CoordinatorStoreRuntime["stopResourceMonitor"]>();
    const wait = vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>(async () => undefined);
    const runAttempt = vi.fn<(operation: (signal: AbortSignal) => Promise<void>, timeout: number, signal: AbortSignal) => Promise<void>>(
      async (operation, _timeout, signal) => operation(signal),
    );
    const profilePublisher = vi.fn<(input: CoordinatorProfilePublisherInput) => Promise<unknown>>(async () => undefined);
    const runtime: CoordinatorStoreRuntime = {
      acquireInstanceLease,
      createTransport,
      closeTransport,
      startResourceMonitor,
      stopResourceMonitor,
      wait,
      runAttempt,
      profilePublisher,
    };
    return {
      runtime,
      leases,
      transports,
      acquireInstanceLease,
      createTransport,
      closeTransport,
      startResourceMonitor,
      stopResourceMonitor,
      wait,
      runAttempt,
      profilePublisher,
    };
  }

  test("persists setup before publishing the coordinator profile without touching runtime state", async () => {
    const harness = lifecycleRuntime(false);
    const store = new CoordinatorStore(harness.runtime);
    const coordinatorPubkey = store.identity.publicKeyHex;

    const result = await store.completeSetupAndPublish("  Madeira host  ");

    expect(result).toEqual({ localSaved: true, published: true });
    expect(configStore.isSetupComplete).toBe(true);
    expect(configStore.coordinatorName).toBe("Madeira host");
    expect(store.profilePublicationState).toBe("published");
    expect(harness.profilePublisher).toHaveBeenCalledWith(expect.objectContaining({
      name: "Madeira host",
      coordinatorPubkey,
      relayUrls: configStore.inviteRelayUrls,
    }));
    expect(store.identity.publicKeyHex).toBe(coordinatorPubkey);
    expect(store.status).toBe("idle");
    expect(harness.acquireInstanceLease).not.toHaveBeenCalled();
    expect(harness.createTransport).not.toHaveBeenCalled();
    expect(harness.startResourceMonitor).not.toHaveBeenCalled();
  });

  test("reports invalid local saves without attempting publication", async () => {
    const harness = lifecycleRuntime(false);
    const store = new CoordinatorStore(harness.runtime);

    await expect(store.completeSetupAndPublish("  ")).resolves.toEqual({ localSaved: false, published: false });

    expect(store.profilePublicationState).toBe("idle");
    expect(harness.profilePublisher).not.toHaveBeenCalled();
  });

  test("retains persisted names and identity after publication failure, then retries with current relays", async () => {
    const harness = lifecycleRuntime();
    const store = new CoordinatorStore(harness.runtime);
    const coordinatorPubkey = store.identity.publicKeyHex;
    const unsafeFailure = "synthetic-secret bunker://relay.example raw-event-signature";
    await store.start();
    harness.profilePublisher.mockRejectedValueOnce(new Error(unsafeFailure));

    const failed = await store.saveCoordinatorNameAndPublish("Retry host");

    expect(failed).toEqual({ localSaved: true, published: false });
    expect(configStore.coordinatorName).toBe("Retry host");
    expect(store.profilePublicationState).toBe("failed");
    expect(store.status).toBe("running");
    expect(store.identity.publicKeyHex).toBe(coordinatorPubkey);
    expect(harness.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(harness.createTransport).toHaveBeenCalledOnce();
    expect(harness.startResourceMonitor).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.debugLog)).not.toContain(unsafeFailure);

    expect(configStore.addRelay("wss://retry.example")).toBe(true);
    const retried = await store.retryCoordinatorProfilePublication();

    expect(retried).toEqual({ localSaved: true, published: true });
    expect(store.profilePublicationState).toBe("published");
    expect(harness.profilePublisher).toHaveBeenLastCalledWith(expect.objectContaining({
      name: "Retry host",
      coordinatorPubkey,
      relayUrls: configStore.inviteRelayUrls,
    }));
    expect(store.identity.publicKeyHex).toBe(coordinatorPubkey);
    expect(store.status).toBe("running");
    await store.stop();
  });

  test("serializes duplicate profile publication activation", async () => {
    const harness = lifecycleRuntime(false);
    const store = new CoordinatorStore(harness.runtime);
    let release!: () => void;
    harness.profilePublisher.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    const initial = store.completeSetupAndPublish("Serialized host");
    const duplicate = store.retryCoordinatorProfilePublication();
    await vi.waitFor(() => expect(store.profilePublicationState).toBe("publishing"));
    release();
    await expect(Promise.all([initial, duplicate])).resolves.toEqual([
      { localSaved: true, published: true },
      { localSaved: true, published: true },
    ]);
    expect(harness.profilePublisher).toHaveBeenCalledOnce();
  });

  test("refuses incomplete setup before every startup side effect", async () => {
    const harness = lifecycleRuntime(false);
    const store = new CoordinatorStore(harness.runtime);

    await expect(store.start()).rejects.toThrow("Complete coordinator setup before starting.");

    expect(store.status).toBe("idle");
    expect(store.error).toBeNull();
    expect(store.debugLog).toEqual([]);
    expect(store.relayStatuses).toEqual({});
    expect(harness.acquireInstanceLease).not.toHaveBeenCalled();
    expect(harness.createTransport).not.toHaveBeenCalled();
    expect(harness.startResourceMonitor).not.toHaveBeenCalled();

    expect(configStore.completeSetup("Ready coordinator")).toBe(true);
    await store.start();
    expect(harness.acquireInstanceLease).toHaveBeenCalledOnce();
    await store.stop();
  });

  test("public start shares one transaction and restores deduplicated rooms in stable order", async () => {
    const harness = lifecycleRuntime();
    const store = new CoordinatorStore(harness.runtime);
    const alpha = deferred<void>();
    const bravo = deferred<void>();
    const order: string[] = [];
    store.registerHostedRoomRecovery({
      listTargets: () => [targetB, targetA, { ...targetB, roomName: "Duplicate Bravo" }],
      recover: async (target) => {
        order.push(target.roomIdentityKey);
        await (target.roomIdentityKey === targetA.roomIdentityKey ? alpha.promise : bravo.promise);
      },
    });

    const firstStart = store.start();
    const sharedStart = store.start();
    await vi.waitFor(() => expect(order).toEqual([targetA.roomIdentityKey]));
    expect(store.status).toBe("starting");
    expect(store.startupProgress.roomRecovery).toMatchObject({ completed: 0, total: 2 });
    alpha.resolve(undefined);
    await vi.waitFor(() => expect(order).toEqual([targetA.roomIdentityKey, targetB.roomIdentityKey]));
    expect(store.startupProgress.roomRecovery).toMatchObject({ completed: 1, total: 2 });
    bravo.resolve(undefined);
    await Promise.all([firstStart, sharedStart]);

    expect(harness.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(harness.createTransport).toHaveBeenCalledOnce();
    expect(harness.runAttempt).toHaveBeenCalledTimes(2);
    expect(harness.startResourceMonitor).toHaveBeenCalledOnce();
    expect(store.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 2, total: 2 });
    expect(store.status).toBe("running");
    await store.stop();
  });

  test("restart awaits and discards stale non-abortable recovery before replacement owns resources", async () => {
    const harness = lifecycleRuntime();
    const store = new CoordinatorStore(harness.runtime);
    const staleRecovery = deferred<void>();
    let recoverCalls = 0;
    const discard = vi.fn(async () => undefined);
    store.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => {
        recoverCalls += 1;
        if (recoverCalls === 1) await staleRecovery.promise;
      },
      discard,
    });

    const firstStart = store.start();
    await vi.waitFor(() => expect(recoverCalls).toBe(1));
    const restarting = store.restart();
    await Promise.resolve();
    expect(harness.acquireInstanceLease).toHaveBeenCalledOnce();
    staleRecovery.resolve(undefined);
    await Promise.all([firstStart, restarting]);

    expect(recoverCalls).toBe(2);
    expect(discard).toHaveBeenCalledOnce();
    expect(harness.acquireInstanceLease).toHaveBeenCalledTimes(2);
    expect(harness.createTransport).toHaveBeenCalledTimes(2);
    expect(harness.closeTransport).toHaveBeenCalledTimes(1);
    expect(harness.closeTransport).toHaveBeenCalledWith(harness.transports[0]);
    expect(harness.leases[0]?.release).toHaveBeenCalledOnce();
    expect(harness.leases[1]?.release).not.toHaveBeenCalled();
    expect(harness.startResourceMonitor).toHaveBeenCalledTimes(1);
    expect(harness.startResourceMonitor).toHaveBeenCalledWith(harness.transports[1]);
    expect(store.status).toBe("running");
    expect(store.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 1, total: 1 });
    await store.stop();
  });

  test("exhausted public recovery retries once, keeps completed rooms, and preserves policy", async () => {
    const harness = lifecycleRuntime();
    const store = new CoordinatorStore(harness.runtime);
    const calls: string[] = [];
    let bravoAttempts = 0;
    store.registerHostedRoomRecovery({
      listTargets: () => [targetB, targetA],
      recover: async (target) => {
        calls.push(target.roomIdentityKey);
        if (target.roomIdentityKey === targetB.roomIdentityKey) {
          bravoAttempts += 1;
          if (bravoAttempts <= ROOM_RECOVERY_POLICY.maxAttempts) throw new Error("internal relay detail");
        }
      },
    });

    await store.start();

    expect(store.status).toBe("starting");
    expect(store.startupProgress.roomRecovery).toMatchObject({
      state: "exhausted",
      completed: 1,
      total: 2,
      roomName: "Bravo",
      diagnostic: "Check your connection, then retry recovery.",
    });
    expect(harness.runAttempt.mock.calls.map((call) => call[1])).toEqual([
      ROOM_RECOVERY_POLICY.attemptTimeoutMs[0],
      ROOM_RECOVERY_POLICY.attemptTimeoutMs[0],
      ROOM_RECOVERY_POLICY.attemptTimeoutMs[1],
      ROOM_RECOVERY_POLICY.attemptTimeoutMs[2],
    ]);
    expect(harness.wait.mock.calls.map((call) => call[0])).toEqual([250, 750]);

    const firstRetry = store.retryRoomRecovery();
    const duplicateRetry = store.retryRoomRecovery();
    await Promise.all([firstRetry, duplicateRetry]);

    expect(calls).toEqual([
      targetA.roomIdentityKey,
      targetB.roomIdentityKey,
      targetB.roomIdentityKey,
      targetB.roomIdentityKey,
      targetB.roomIdentityKey,
    ]);
    expect(harness.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(harness.createTransport).toHaveBeenCalledOnce();
    expect(harness.startResourceMonitor).toHaveBeenCalledOnce();
    expect(store.status).toBe("running");
    expect(store.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 2, total: 2 });
    await store.stop();
  });

  test("deleting the exact exhausted recovery target resumes startup without reacquiring resources", async () => {
    const harness = lifecycleRuntime();
    const store = new CoordinatorStore(harness.runtime);
    let targets: HostedRoomRecoveryTarget[] = [targetB, targetA];
    store.registerHostedRoomRecovery({
      listTargets: () => targets,
      recover: async (target) => {
        if (target.roomIdentityKey === targetB.roomIdentityKey) {
          throw new Error("saved room signer no longer matches");
        }
      },
    });

    await store.start();

    expect(store.status).toBe("starting");
    expect(store.startupProgress.roomRecovery).toMatchObject({ state: "exhausted", completed: 1, total: 2 });
    expect(store.exhaustedRoomRecoveryTarget).toEqual(targetB);
    await expect(store.resumeAfterRemovingFailedRoom({
      roomId: targetA.roomId,
      coordinatorPubkey: targetA.coordinatorPubkey,
    })).rejects.toThrow("Failed recovery room changed");
    expect(store.status).toBe("starting");
    expect(store.exhaustedRoomRecoveryTarget).toEqual(targetB);

    targets = [targetA];
    await store.resumeAfterRemovingFailedRoom({
      roomId: targetB.roomId,
      coordinatorPubkey: targetB.coordinatorPubkey,
    });

    expect(store.status).toBe("running");
    expect(store.exhaustedRoomRecoveryTarget).toBeNull();
    expect(store.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 1, total: 1 });
    expect(harness.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(harness.createTransport).toHaveBeenCalledOnce();
    expect(harness.startResourceMonitor).toHaveBeenCalledOnce();
    await store.stop();
  });

  test("zero targets complete publicly as 0 of 0 without exposing retry", async () => {
    const harness = lifecycleRuntime();
    const store = new CoordinatorStore(harness.runtime);
    store.registerHostedRoomRecovery({ listTargets: () => [], recover: vi.fn() });

    await store.start();

    expect(store.status).toBe("running");
    expect(store.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 0, total: 0 });
    expect(harness.runAttempt).not.toHaveBeenCalled();
    expect(harness.wait).toHaveBeenCalledWith(500, expect.any(AbortSignal));
    await store.stop();
  });
});
