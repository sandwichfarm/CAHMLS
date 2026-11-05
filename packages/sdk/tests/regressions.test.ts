import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "@contextvm/mcp-sdk/client";
import type { RelayHandler } from "@contextvm/sdk/core";
import type { NostrEvent } from "nostr-tools";
import { generateSecretKey } from "nostr-tools/pure";

import { RELAY_PUBLISH_POLICY, createRequiredRelayPool } from "../src/relay/relay-pool.js";

import { ChatCoordinatorClient } from "../src/client/coordinator-client.js";
import type { ChatCoordinatorOperations } from "../src/client/coordinator-client.js";
import { LocalHostCoordinatorClient } from "../src/client/local-coordinator-client.js";
import { parseInviteUrl, createInviteUrl } from "../src/client/invite.js";
import {
  addMember,
  createKeyPackage,
  decryptMessage,
  encryptMessage,
  createRoomState,
  encodeState,
  groupId,
  joinWelcome,
} from "../src/client/protocol.js";
import { ChatRoomSession, loadRoom, saveRoom, type StoredRoom } from "../src/client/room-store.js";
import { createBrowserCoordinatorStorage } from "../src/coordinator/storage/browserSqliteStorage.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";
import { CoordinatorRuntime } from "../src/runtime/coordinator-runtime.js";
import { TransportFactory } from "../src/server/transport.js";
import { InMemoryCoordinatorStorage } from "../src/coordinator/storage/inMemoryStorage.js";
import { KeyStorage } from "../src/crypto/key-storage.js";
import { createRoomStorageFor, createFakeTransportDeps } from "./support/regression-helpers.js";
import { createRuntimeDeps, createTestConfig } from "./support/runtime-harness.js";
import type { InstanceLease } from "../src/runtime/single-instance-guard.js";

async function createTwoMemberRoom() {
  const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
  const hostSigner = new BrowserNostrSigner(generateSecretKey());
  const guestSigner = new BrowserNostrSigner(generateSecretKey());
  const hostPubkey = await hostSigner.getPublicKey();
  const guestPubkey = await guestSigner.getPublicKey();
  const hostKeys = await createKeyPackage(hostPubkey);
  const guestKeys = await createKeyPackage(guestPubkey);
  const initial = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
  const added = await addMember(initial, guestKeys.stored.publicBase64);
  const guestState = await joinWelcome(added.welcomeBase64, guestKeys.stored);
  const id = groupId(initial);
  const base = {
    version: 1 as const,
    id,
    title: "Room",
    coordinatorPubkey: "13".repeat(32),
    relayUrls: ["wss://relay.example"],
    lastCursor: 0,
    messages: [],
    pending: [],
    reactions: [],
  };
  const hostRoom: StoredRoom = { ...base, name: "Host", stablePubkey: hostPubkey, isHost: true, autoApprove: true, stateBase64: encodeState(added.state), keyPackage: hostKeys.stored };
  const guestRoom: StoredRoom = { ...base, name: "Guest", stablePubkey: guestPubkey, isHost: false, stateBase64: encodeState(guestState), keyPackage: guestKeys.stored };
  const createClient = () => new LocalHostCoordinatorClient(coordinator);
  return {
    coordinator,
    host: new ChatRoomSession(hostRoom, hostSigner, createClient),
    guest: new ChatRoomSession(guestRoom, guestSigner, createClient),
  };
}

describe("room session message delivery", () => {
  let restore: () => void;
  beforeEach(() => { restore = createRoomStorageFor(); });
  afterEach(() => restore());

  test("posting does not skip messages other members sent since the last sync", async () => {
    const { coordinator, host, guest } = await createTwoMemberRoom();
    try {
      await host.start();
      await guest.start();

      await host.send("from host while guest is between polls");
      await guest.send("from guest");

      expect(guest.room.messages.map((message) => message.content)).toEqual(
        expect.arrayContaining(["from host while guest is between polls", "from guest"]),
      );
      await host.sync();
      expect(host.room.messages.map((message) => message.content)).toEqual(
        expect.arrayContaining(["from host while guest is between polls", "from guest"]),
      );
      expect(guest.room.pending).toEqual([]);
      expect(guest.room.lastCursor).toBeGreaterThanOrEqual(2);
    } finally {
      host.stop();
      guest.stop();
      coordinator.close();
    }
  });
});

describe("room session recovery", () => {
  let restore: () => void;
  beforeEach(() => { restore = createRoomStorageFor(); });
  afterEach(() => restore());

  test("an aborted recovery does not leave a closed client for the next attempt", async () => {
    const { coordinator, host } = await createTwoMemberRoom();
    const controller = new AbortController();
    const closed = new WeakSet<object>();
    let abortDuringFetch = true;
    const session = new ChatRoomSession(host.room, new BrowserNostrSigner(generateSecretKey()), () => {
      const local = new LocalHostCoordinatorClient(coordinator);
      const client: ChatCoordinatorOperations = Object.assign(Object.create(local) as ChatCoordinatorOperations, {
        close: async () => { closed.add(client); },
        fetchJoinRequests: async (id: string) => {
          if (closed.has(client)) throw new Error("client closed");
          if (abortDuringFetch) {
            abortDuringFetch = false;
            controller.abort();
          }
          return local.fetchJoinRequests(id);
        },
        fetchMessages: async (id: string, after?: number) => {
          if (closed.has(client)) throw new Error("client closed");
          return local.fetchMessages(id, after);
        },
      });
      return client;
    });
    try {
      await expect(session.recover(controller.signal)).rejects.toMatchObject({ name: "AbortError" });

      await session.recover(new AbortController().signal);
      expect(session.status.connection).toBe("connected");
    } finally {
      session.discard();
      coordinator.close();
    }
  });

  test("a host reads delivered messages before committing a new member", async () => {
    const { coordinator, host, guest } = await createTwoMemberRoom();
    const newcomerPubkey = "44".repeat(32);
    const newcomer = await createKeyPackage(newcomerPubkey);
    try {
      await host.start();
      await guest.start();
      await guest.send("sent just before the admission");

      coordinator.publishKeyPackage({
        stablePubkey: newcomerPubkey,
        keyPackage: newcomer.keyPackage,
        keyPackageRef: newcomer.stored.reference,
        publicationEvent: { content: JSON.stringify({ params: { arguments: { kp_64: newcomer.stored.publicBase64 } } }) } as never,
      });
      coordinator.storeJoinRequest({ groupId: host.room.id, requesterStablePubkey: newcomerPubkey, keyPackageRef: newcomer.stored.reference });

      await host.sync();

      expect(host.room.messages.map((message) => message.content)).toContain("sent just before the admission");
      expect(host.room.pendingWelcomes ?? []).toEqual([]);
    } finally {
      host.stop();
      guest.stop();
      coordinator.close();
    }
  });
});

describe("ChatCoordinatorClient lifecycle", () => {
  test("closing stops pending idempotent-write retries instead of reconnecting", async () => {
    vi.useFakeTimers();
    const connect = vi.spyOn(Client.prototype, "connect").mockRejectedValue(new Error("relay offline"));
    try {
      const client = new ChatCoordinatorClient(
        { coordinatorPubkey: "ab".repeat(32), relayUrls: ["wss://relay.example"] },
        new BrowserNostrSigner(generateSecretKey()),
      );
      const write = client.publishKeyPackage("ref", "kp");
      const outcome = expect(write).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      const callsBeforeClose = connect.mock.calls.length;
      expect(callsBeforeClose).toBe(1);
      await client.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
      expect(connect.mock.calls.length).toBe(callsBeforeClose);
    } finally {
      connect.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a closed client refuses new calls", async () => {
    const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    try {
      const client = new ChatCoordinatorClient(
        { coordinatorPubkey: "ab".repeat(32), relayUrls: ["wss://relay.example"] },
        new BrowserNostrSigner(generateSecretKey()),
      );
      await client.close();
      await expect(client.fetchMessages("group")).rejects.toThrow(/closed/i);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});

describe("CoordinatorRuntime lifecycle", () => {
  const keyStorage = () => new KeyStorage({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined });

  test("closes the transport when hosted room recovery fails unexpectedly", async () => {
    const { deps, transports, leases } = createRuntimeDeps();
    const runtime = new CoordinatorRuntime({ config: createTestConfig(), deps, keyStorage: keyStorage() });
    runtime.registerHostedRoomRecovery({
      listTargets: () => { throw new Error("room list unavailable"); },
      recover: async () => undefined,
    });

    await runtime.start();

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBe("room list unavailable");
    expect(transports[0]?.close).toHaveBeenCalledOnce();
    expect(leases[0]?.release).toHaveBeenCalledOnce();
  });

  test("destroying during startup cancels it instead of finishing on the new identity", async () => {
    let finishLease!: (lease: InstanceLease) => void;
    const { deps } = createRuntimeDeps({
      acquireInstanceLease: vi.fn(() => new Promise<InstanceLease>((resolve) => { finishLease = resolve; })),
    });
    const config = createTestConfig();
    const runtime = new CoordinatorRuntime({ config, deps, keyStorage: keyStorage() });
    const release = vi.fn(async () => undefined);

    const startup = runtime.start();
    const destroyed = runtime.destroy();
    finishLease({ release });
    await Promise.all([startup, destroyed]);

    expect(runtime.status).toBe("idle");
    expect(release).toHaveBeenCalledOnce();
    expect(deps.createTransport).not.toHaveBeenCalled();
  });

  test("stop is a no-op when the coordinator is already idle", async () => {
    const { deps } = createRuntimeDeps();
    const runtime = new CoordinatorRuntime({ config: createTestConfig(), deps, keyStorage: keyStorage() });

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.status).toBe("idle");
  });
});

describe("TransportFactory startup failure", () => {
  test("closes storage when the relay connection fails", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const close = vi.spyOn(storage, "close");
    const failing = createFakeTransportDeps(storage);
    await expect(
      new TransportFactory(failing).create(generateSecretKey(), ["wss://relay.invalid"], { announce: false, maxUsers: 8 }, false),
    ).rejects.toThrow("relay offline");
    expect(close).toHaveBeenCalled();
  });
});

describe("invite parsing outside a browser", () => {
  test("parses an absolute invite URL without a window global", () => {
    const url = createInviteUrl("https://app.example", { groupId: "group", coordinatorPubkey: "ab".repeat(32), relayUrls: ["wss://relay.example"], title: "Room" });
    vi.stubGlobal("window", undefined);
    try {
      expect(parseInviteUrl(url)?.groupId).toBe("group");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("room delivery across epoch changes", () => {
  let restore: () => void;
  beforeEach(() => { restore = createRoomStorageFor(); });
  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  async function requestAdmission(coordinator: Coordinator, roomId: string) {
    const pubkey = "44".repeat(32);
    const keys = await createKeyPackage(pubkey);
    coordinator.publishKeyPackage({
      stablePubkey: pubkey,
      keyPackage: keys.keyPackage,
      keyPackageRef: keys.stored.reference,
      publicationEvent: { content: JSON.stringify({ params: { arguments: { kp_64: keys.stored.publicBase64 } } }) } as never,
    });
    coordinator.storeJoinRequest({ groupId: roomId, requesterStablePubkey: pubkey, keyPackageRef: keys.stored.reference });
  }

  test("a member who has not seen a commit yet still reaches the room", async () => {
    const { coordinator, host, guest } = await createTwoMemberRoom();
    try {
      await host.start();
      await guest.start();
      await requestAdmission(coordinator, host.room.id);
      await host.sync();

      await guest.send("sent before seeing the commit");
      await host.sync();

      expect(guest.room.pending).toEqual([]);
      expect(host.room.messages.map((message) => message.content)).toContain("sent before seeing the commit");
    } finally {
      host.stop();
      guest.stop();
      coordinator.close();
    }
  });

  test("a host delivers its queued message before committing a new member", async () => {
    const { coordinator, host, guest } = await createTwoMemberRoom();
    try {
      await host.start();
      await guest.start();
      const post = vi.spyOn(LocalHostCoordinatorClient.prototype, "postGroupMessage").mockRejectedValueOnce(new Error("relay offline"));
      await host.send("queued while posts fail");
      expect(host.room.pending).toHaveLength(1);
      post.mockRestore();

      await requestAdmission(coordinator, host.room.id);
      await host.sync();
      await guest.sync();

      expect(host.room.pending).toEqual([]);
      expect(guest.room.messages.map((message) => message.content)).toContain("queued while posts fail");
    } finally {
      host.stop();
      guest.stop();
      coordinator.close();
    }
  });

  test("a message queued across an epoch change is resealed for the current epoch", async () => {
    const { coordinator, host, guest } = await createTwoMemberRoom();
    try {
      await host.start();
      await guest.start();
      const post = vi.spyOn(LocalHostCoordinatorClient.prototype, "postGroupMessage").mockRejectedValueOnce(new Error("relay offline"));
      await guest.send("queued across the commit");
      post.mockRestore();
      const sealed = guest.room.pending[0]?.opaqueBase64;
      await requestAdmission(coordinator, host.room.id);
      await host.sync();

      await guest.sync();
      await host.sync();

      expect(sealed).toBeDefined();
      expect(guest.room.pending).toEqual([]);
      expect(host.room.messages.map((message) => message.content)).toContain("queued across the commit");
    } finally {
      host.stop();
      guest.stop();
      coordinator.close();
    }
  });

  test("an aborted recovery does not go on to admit guests", async () => {
    const { coordinator, host } = await createTwoMemberRoom();
    const controller = new AbortController();
    await requestAdmission(coordinator, host.room.id);
    vi.spyOn(LocalHostCoordinatorClient.prototype, "fetchMessages").mockImplementationOnce(async () => {
      controller.abort();
      return [];
    });
    try {
      await expect(host.recover(controller.signal)).rejects.toMatchObject({ name: "AbortError" });

      expect(coordinator.fetchGroupMessages({ groupId: host.room.id })).toEqual([]);
    } finally {
      host.discard();
      coordinator.close();
    }
  });
});

describe("timestamps from other members", () => {
  let restore: () => void;
  beforeEach(() => { restore = createRoomStorageFor(); });
  afterEach(() => restore());

  test("rejects a message whose time cannot be represented as a date", async () => {
    const senderKeys = await createKeyPackage("12".repeat(32));
    const state = await createRoomState(senderKeys.keyPackage, senderKeys.privateKeyPackage);
    const outOfRange = await encryptMessage(state, {
      type: "message", id: "x", sender: "12".repeat(32), name: "Host", content: "hello", createdAt: 1e16,
    });

    await expect(decryptMessage(state, outOfRange.opaqueBase64)).rejects.toThrow();
  });

  test("drops a stored message with an unusable time without losing the room", () => {
    const room: StoredRoom = {
      version: 1, id: "room", title: "Room", coordinatorPubkey: "13".repeat(32), relayUrls: [], name: "Host",
      stablePubkey: "12".repeat(32), isHost: true, stateBase64: "", keyPackage: { reference: "", publicBase64: "", privateBase64: "" },
      lastCursor: 0, pending: [],
      messages: [
        { type: "message", id: "bad", sender: "12".repeat(32), name: "A", content: "bad", createdAt: 1e16 },
        { type: "message", id: "good", sender: "12".repeat(32), name: "A", content: "good", createdAt: 1_000 },
      ],
    };
    saveRoom(room);

    expect(loadRoom("room", room.coordinatorPubkey)?.messages.map((message) => message.id)).toEqual(["good"]);
  });
});

describe("ephemeral coordinator restart", () => {
  test("cursors keep increasing so members with a saved cursor still receive messages", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      const first = await createBrowserCoordinatorStorage(false, "ab".repeat(32));
      const before = first.appendGroupMessage({ groupId: "group", ephemeralSenderPubkey: "cd".repeat(32), opaqueMessage: new Uint8Array([1]), epoch: 0n, latestHandshakeEpoch: 0n, createdAt: 1 });
      first.close();

      now.mockReturnValue(2_000_000);
      const restarted = await createBrowserCoordinatorStorage(false, "ab".repeat(32));
      const after = restarted.appendGroupMessage({ groupId: "group", ephemeralSenderPubkey: "cd".repeat(32), opaqueMessage: new Uint8Array([2]), epoch: 0n, latestHandshakeEpoch: 0n, createdAt: 1 });
      restarted.close();

      expect(after.cursor).toBeGreaterThan(before.cursor);
    } finally {
      now.mockRestore();
    }
  });

  test("a storage with no first cursor starts at one", () => {
    const storage = new InMemoryCoordinatorStorage();
    expect(storage.appendGroupMessage({ groupId: "group", ephemeralSenderPubkey: "cd".repeat(32), opaqueMessage: new Uint8Array([1]), epoch: 0n, latestHandshakeEpoch: 0n, createdAt: 1 }).cursor).toBe(1);
  });
});

describe("closing a client with a request in flight", () => {
  test("closes the connections before cancelling, so no cancellation is published", async () => {
    let signal: AbortSignal | undefined;
    const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    const callTool = vi.spyOn(Client.prototype, "callTool").mockImplementation(async (_params, _schema, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    });
    let abortedDuringClose: boolean | undefined;
    const close = vi.spyOn(Client.prototype, "close").mockImplementation(async () => {
      abortedDuringClose = signal?.aborted;
    });
    try {
      const client = new ChatCoordinatorClient(
        { coordinatorPubkey: "ab".repeat(32), relayUrls: ["wss://relay.example"] },
        new BrowserNostrSigner(generateSecretKey()),
      );
      void client.fetchMessages("group").catch(() => undefined);
      await vi.waitFor(() => expect(signal).toBeDefined());

      await client.close();

      expect(abortedDuringClose).toBe(false);
      expect(signal?.aborted).toBe(true);
    } finally {
      connect.mockRestore();
      callTool.mockRestore();
      close.mockRestore();
    }
  });
});

describe("relay publishing on a new connection", () => {
  const event = { id: "e".repeat(64), kind: 21059 } as NostrEvent;

  function pool(publish: RelayHandler["publish"]): RelayHandler {
    return {
      connect: async () => undefined,
      disconnect: async () => undefined,
      publish,
      subscribe: async () => () => undefined,
      unsubscribe: () => undefined,
      getRelayUrls: () => [],
    };
  }

  test("gives a connection that has not accepted anything time to establish", async () => {
    vi.useFakeTimers();
    try {
      let accepted = false;
      const relay = createRequiredRelayPool(["wss://relay.example"], {
        probeRelay: async () => false,
        createPool: () => pool(() => new Promise((resolve) => {
          setTimeout(() => { accepted = true; resolve(); }, 2_000);
        })),
      });

      const publish = relay.publish(event);
      await vi.advanceTimersByTimeAsync(2_000);
      await publish;

      expect(accepted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns to the short budget once a publish has been accepted", async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: string[] = [];
      let calls = 0;
      const relay = createRequiredRelayPool(["wss://relay.example"], {
        probeRelay: async () => false,
        onPublishDiagnostic: ({ path, outcome }) => { if (path === "primary") diagnostics.push(outcome); },
        createPool: () => pool(() => {
          calls += 1;
          return calls === 1 ? Promise.resolve() : new Promise(() => undefined);
        }),
      });
      await relay.publish(event);

      const second = relay.publish(event);
      const outcome = expect(second).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(RELAY_PUBLISH_POLICY.primaryAttemptTimeoutMs * 2 + 100);
      await outcome;

      expect(diagnostics.filter((entry) => entry === "aborted")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("still gives up on an unreachable relay within the bounded budget", async () => {
    vi.useFakeTimers();
    try {
      const relay = createRequiredRelayPool(["wss://relay.example"], {
        probeRelay: async () => false,
        createPool: () => pool(() => new Promise(() => undefined)),
      });

      const publish = relay.publish(event);
      const outcome = expect(publish).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(RELAY_PUBLISH_POLICY.primaryColdAttemptTimeoutMs * 2 + 100);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
