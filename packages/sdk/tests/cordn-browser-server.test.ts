import { describe, expect, test, vi } from "vitest";
import { encode, mlsMessageEncoder, wireformats } from "ts-mls";

import { decodeBase64, encodeBase64 } from "../src/server/base64.js";
import { CoordinatorAdapter, registerCoordinatorMethods } from "../src/server/coordinatorMethods.js";
import { COORDINATOR_METHODS } from "../src/contracts/index.js";
import { Coordinator } from "../src/coordinator/index.js";
import { InMemoryCoordinatorStorage } from "../src/coordinator/storage/inMemoryStorage.js";

const encoder = new TextEncoder();

function createExtra(clientPubkey = "client-pubkey") {
  return {
    _meta: { clientPubkey },
  } as never;
}

function createStreamingExtra() {
  return {
    _meta: {
      clientPubkey: "subscriber-pubkey",
      stream: {
        isActive: true,
        start: vi.fn().mockRejectedValue(new Error("stream stopped")),
        write: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(),
      },
    },
  } as never;
}

function createExternallyAbortableStreamingExtra() {
  const stream = {
    isActive: true,
    start: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    close: vi.fn().mockImplementation(() => {
      stream.isActive = false;
      return Promise.resolve();
    }),
    abort: vi.fn().mockImplementation(() => {
      stream.isActive = false;
      return Promise.resolve();
    }),
  };

  return {
    extra: {
      _meta: {
        clientPubkey: "subscriber-pubkey",
        stream,
      },
    } as never,
    stream,
  };
}

function createPrivateApplicationMessage(groupId: string, epoch: bigint): Uint8Array {
  return encode(mlsMessageEncoder, {
    version: 1,
    wireformat: wireformats.mls_private_message,
    privateMessage: {
      groupId: encoder.encode(groupId),
      epoch,
      contentType: 1,
      authenticatedData: new Uint8Array(),
      encryptedSenderData: new Uint8Array(),
      ciphertext: Uint8Array.from([1, 2, 3]),
    },
  });
}

describe("browser Cordn server adapter", () => {
  test("registers the full Cordn coordinator tool surface", () => {
    const registerTool = vi.fn();
    const server = { registerTool };
    const adapter = new CoordinatorAdapter(new Coordinator());

    registerCoordinatorMethods(server as never, adapter);

    expect(registerTool).toHaveBeenCalledTimes(Object.values(COORDINATOR_METHODS).length);
    expect(registerTool.mock.calls.map(([name]) => name).sort()).toEqual(
      Object.values(COORDINATOR_METHODS).sort(),
    );
  });

  test("posts and fetches MLS group messages through coordinator methods", () => {
    const adapter = new CoordinatorAdapter(new Coordinator());
    const encodedMessage = createPrivateApplicationMessage("group-browser", 7n);

    const posted = adapter.postGroupMessage(
      { gid: "group-browser", msg_64: encodeBase64(encodedMessage) },
      createExtra("sender-pubkey"),
    );
    const fetched = adapter.fetchGroupMessages({ gid: "group-browser" });

    expect(posted.structuredContent).toMatchObject({
      cursor: 1,
      gid: "group-browser",
    });
    expect(fetched.structuredContent.messages).toEqual([
      {
        cursor: 1,
        gid: "group-browser",
        msg_64: encodeBase64(encodedMessage),
        at: posted.structuredContent.at,
      },
    ]);
  });

  test("round-trips coordinator message state through a persistent snapshot", () => {
    const firstStorage = new InMemoryCoordinatorStorage();
    const firstAdapter = new CoordinatorAdapter(new Coordinator({ storage: firstStorage }));
    const encodedMessage = createPrivateApplicationMessage("group-persisted", 9n);

    firstAdapter.postGroupMessage(
      { gid: "group-persisted", msg_64: encodeBase64(encodedMessage) },
      createExtra("sender-pubkey"),
    );

    const secondAdapter = new CoordinatorAdapter(
      new Coordinator({
        storage: new InMemoryCoordinatorStorage(firstStorage.toSnapshot()),
      }),
    );

    expect(secondAdapter.fetchGroupMessages({ gid: "group-persisted" }).structuredContent.messages).toEqual([
      {
        cursor: 1,
        gid: "group-persisted",
        msg_64: encodeBase64(encodedMessage),
        at: expect.any(Number),
      },
    ]);
  });

  test("tombstones deleted rooms and rejects stale joins and messages", () => {
    const storage = new InMemoryCoordinatorStorage();
    const encodedMessage = createPrivateApplicationMessage("group-deleted", 9n);

    storage.storeJoinRequest({
      groupId: "group-deleted",
      requesterStablePubkey: "requester",
      keyPackageRef: "key-package",
      inviteToken: "stale-invite",
      createdAt: 1,
      readAt: null,
    });
    storage.appendGroupMessage({
      groupId: "group-deleted",
      latestHandshakeEpoch: 9n,
      epoch: 9n,
      ephemeralSenderPubkey: "sender",
      opaqueMessage: encodedMessage,
      createdAt: 2,
    });

    storage.deleteGroup("group-deleted");

    expect(storage.isGroupDeleted("group-deleted")).toBe(true);
    expect(storage.getGroupRouting("group-deleted")).toBeNull();
    expect(storage.toSnapshot()).toMatchObject({
      deletedGroups: ["group-deleted"],
      groups: [],
      joinRequests: [],
    });
    expect(() => storage.fetchGroupMessages({ groupId: "group-deleted" })).toThrow(
      "Room deleted by host",
    );
    expect(() =>
      storage.storeJoinRequest({
        groupId: "group-deleted",
        requesterStablePubkey: "requester",
        keyPackageRef: "key-package",
        inviteToken: "stale-invite",
        createdAt: 3,
        readAt: null,
      }),
    ).toThrow("Room deleted by host");
    expect(() =>
      storage.appendGroupMessage({
        groupId: "group-deleted",
        latestHandshakeEpoch: 9n,
        epoch: 9n,
        ephemeralSenderPubkey: "sender",
        opaqueMessage: encodedMessage,
        createdAt: 4,
      }),
    ).toThrow("Room deleted by host");
  });

  test("restores v1 snapshots with or without deleted-room tombstones", () => {
    const legacySnapshot = new InMemoryCoordinatorStorage().toSnapshot();
    delete legacySnapshot.deletedGroups;

    expect(new InMemoryCoordinatorStorage(legacySnapshot).isGroupDeleted("legacy-room")).toBe(
      false,
    );

    const firstStorage = new InMemoryCoordinatorStorage();
    firstStorage.deleteGroup("deleted-room");
    const restoredStorage = new InMemoryCoordinatorStorage(firstStorage.toSnapshot());

    expect(restoredStorage.isGroupDeleted("deleted-room")).toBe(true);
    expect(() => restoredStorage.fetchGroupMessages({ groupId: "deleted-room" })).toThrow(
      "Room deleted by host",
    );
  });

  test("closes every leg of a live subscription when its room is deleted", async () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const subscription = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "deleted-room" }, { groupId: "other-room" }],
    });
    const pendingMessage = subscription.messages[Symbol.asyncIterator]().next();

    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({
      activeStreams: 1,
      groupLegs: 2,
    });

    coordinator.deleteGroup("deleted-room");

    await expect(pendingMessage).resolves.toEqual({ value: undefined, done: true });
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({
      activeStreams: 0,
      groupLegs: 0,
    });
    expect(() =>
      coordinator.subscribeGroupMessages({ groupId: "deleted-room" }),
    ).toThrow("Room deleted by host");
    expect(() =>
      coordinator.postGroupMessage({
        groupId: "deleted-room",
        ephemeralSenderPubkey: "sender",
        opaqueMessage: createPrivateApplicationMessage("deleted-room", 1n),
      }),
    ).toThrow("Room deleted by host");
  });

  test("uses browser base64 APIs without Buffer", () => {
    const encoded = encodeBase64(Uint8Array.from([1, 2, 3, 254]));

    expect(encoded).toBe("AQID/g==");
    expect([...decodeBase64(encoded)]).toEqual([1, 2, 3, 254]);
  });

  test("reports Cordn method activity to browser telemetry", () => {
    const recordOperation = vi.fn();
    const adapter = new CoordinatorAdapter(new Coordinator());
    const encodedMessage = createPrivateApplicationMessage("group-telemetry", 3n);

    adapter.setTelemetrySink({ recordOperation });
    adapter.postGroupMessage(
      { gid: "group-telemetry", msg_64: encodeBase64(encodedMessage) },
      createExtra("sender-pubkey"),
    );

    expect(recordOperation).toHaveBeenCalledWith("postGroupMessage");
  });

  test("reports active stream metrics to browser telemetry", async () => {
    const setSubscriptionMetrics = vi.fn();
    const adapter = new CoordinatorAdapter(new Coordinator());

    adapter.setTelemetrySink({ setSubscriptionMetrics });

    await expect(
      adapter.subscribeGroupMessages({ gid: "group-telemetry" }, createStreamingExtra()),
    ).rejects.toThrow("stream stopped");

    expect(setSubscriptionMetrics).toHaveBeenCalledTimes(3);
    expect(setSubscriptionMetrics.mock.calls.map(([metrics]) => metrics)).toEqual([
      { activeStreams: 0, groupLegs: 0 },
      { activeStreams: 1, groupLegs: 1 },
      { activeStreams: 0, groupLegs: 0 },
    ]);
  });

  test("reports active stream metrics after external stream cancellation", async () => {
    const setSubscriptionMetrics = vi.fn();
    const adapter = new CoordinatorAdapter(new Coordinator());
    const { extra, stream } = createExternallyAbortableStreamingExtra();

    adapter.setTelemetrySink({ setSubscriptionMetrics });
    const subscription = adapter.subscribeGroupMessages({ gid: "group-telemetry" }, extra);
    await vi.waitFor(() => {
      expect(setSubscriptionMetrics.mock.calls.map(([metrics]) => metrics)).toContainEqual({
        activeStreams: 1,
        groupLegs: 1,
      });
    });

    await stream.abort("client cancelled");
    await subscription;

    expect(setSubscriptionMetrics.mock.calls.map(([metrics]) => metrics)).toEqual([
      { activeStreams: 0, groupLegs: 0 },
      { activeStreams: 1, groupLegs: 1 },
      { activeStreams: 0, groupLegs: 0 },
    ]);
  });

  test("counts one multi-group subscription as one active stream with many fan-out legs", async () => {
    const setSubscriptionMetrics = vi.fn();
    const adapter = new CoordinatorAdapter(new Coordinator());
    const { extra, stream } = createExternallyAbortableStreamingExtra();
    const groups = Array.from({ length: 34 }, (_, index) => ({ gid: `group-${index}` }));

    adapter.setTelemetrySink({ setSubscriptionMetrics });
    const subscription = adapter.subscribeManyGroupMessages({ groups }, extra);
    await vi.waitFor(() => {
      expect(setSubscriptionMetrics.mock.calls.map(([metrics]) => metrics)).toContainEqual({
        activeStreams: 1,
        groupLegs: 34,
      });
    });

    await stream.abort("client cancelled");
    await subscription;

    expect(setSubscriptionMetrics.mock.calls.map(([metrics]) => metrics)).toEqual([
      { activeStreams: 0, groupLegs: 0 },
      { activeStreams: 1, groupLegs: 34 },
      { activeStreams: 0, groupLegs: 0 },
    ]);
  });

  test("enforces injected caller identity before handling methods", () => {
    const adapter = new CoordinatorAdapter(new Coordinator());

    expect(() =>
      adapter.assertWithinRateLimit({ _meta: {} } as never, COORDINATOR_METHODS.postGroupMessage),
    ).toThrow("Missing injected client pubkey");
  });
});
