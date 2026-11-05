import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "@contextvm/mcp-sdk/client";
import { generateSecretKey } from "nostr-tools/pure";

import { ChatCoordinatorClient } from "../src/client/coordinator-client.js";
import type { ChatCoordinatorOperations } from "../src/client/coordinator-client.js";
import { LocalHostCoordinatorClient } from "../src/client/local-coordinator-client.js";
import { parseInviteUrl, createInviteUrl } from "../src/client/invite.js";
import {
  addMember,
  createKeyPackage,
  createRoomState,
  encodeState,
  groupId,
  joinWelcome,
} from "../src/client/protocol.js";
import { ChatRoomSession, type StoredRoom } from "../src/client/room-store.js";
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
