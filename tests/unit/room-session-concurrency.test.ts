import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrSigner } from "@contextvm/sdk/core";
import type { StoredRoom } from "../../src/chat/room-store";

const protocolMocks = vi.hoisted(() => ({
  addMember: vi.fn(),
  createKeyPackage: vi.fn(),
  createRoomState: vi.fn(),
  decodeState: vi.fn((state: unknown) => state),
  decryptMessage: vi.fn(),
  encodeState: vi.fn((state: unknown) => String(state)),
  encryptMessage: vi.fn(),
  groupCreatorPubkey: vi.fn(),
  hasValidChatEnvelopeAuth: vi.fn(() => true),
  groupId: vi.fn(),
  joinWelcome: vi.fn(),
  normalizeRecipientPubkeys: vi.fn((value: unknown) => Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && /^[0-9a-f]{64}$/i.test(entry)).map((entry) => entry.toLowerCase()))]
    : []),
  sanitizeChatEnvelopeHostBadge: vi.fn((envelope: unknown) => envelope),
  signChatEnvelope: vi.fn((envelope: unknown) => envelope),
}));

const coordinatorMocks = vi.hoisted(() => ({
  close: vi.fn(),
  consumeKeyPackage: vi.fn(),
  fetchJoinRequests: vi.fn(),
  fetchMessages: vi.fn(),
  fetchWelcomes: vi.fn(),
  postGroupMessage: vi.fn(),
  publishKeyPackage: vi.fn(),
  storeJoinRequest: vi.fn(),
  storeWelcome: vi.fn(),
}));

vi.mock("../../src/chat/protocol", () => protocolMocks);

vi.mock("../../src/chat/coordinator-client", () => ({
  ChatCoordinatorClient: class {
    close = coordinatorMocks.close;
    consumeKeyPackage = coordinatorMocks.consumeKeyPackage;
    fetchJoinRequests = coordinatorMocks.fetchJoinRequests;
    fetchMessages = coordinatorMocks.fetchMessages;
    fetchWelcomes = coordinatorMocks.fetchWelcomes;
    postGroupMessage = coordinatorMocks.postGroupMessage;
    publishKeyPackage = coordinatorMocks.publishKeyPackage;
    storeJoinRequest = coordinatorMocks.storeJoinRequest;
    storeWelcome = coordinatorMocks.storeWelcome;
  },
}));

vi.mock("../../src/notifications/notification-center.svelte", () => ({
  notificationCenter: { enqueue: vi.fn() },
}));

import { ChatRoomSession, loadRoom, removeStoredRoom, roomUnreadCount, saveRoom } from "../../src/chat/room-store";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
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

function storedRoom(): StoredRoom {
  return {
    version: 1,
    id: "room-id",
    title: "Concurrent room",
    coordinatorPubkey: "c".repeat(64),
    relayUrls: ["wss://relay.example"],
    name: "Guest",
    stablePubkey: "a".repeat(64),
    isHost: false,
    stateBase64: "state-0",
    keyPackage: {
      reference: "key-reference",
      publicBase64: "public-key-package",
      privateBase64: "private-key-package",
    },
    lastCursor: 0,
    messages: [],
    pending: [],
    joinRequestSent: false,
  };
}

function connectedSession(room = storedRoom()): ChatRoomSession {
  const session = new ChatRoomSession(room, {} as NostrSigner);
  session.status = { connection: "connected" };
  return session;
}

describe("ChatRoomSession concurrency", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(protocolMocks)) mock.mockReset();
    for (const mock of Object.values(coordinatorMocks)) mock.mockReset();

    protocolMocks.decodeState.mockImplementation((state: unknown) => state);
    protocolMocks.encodeState.mockImplementation((state: unknown) => String(state));
    protocolMocks.groupCreatorPubkey.mockReturnValue(null);
    protocolMocks.sanitizeChatEnvelopeHostBadge.mockImplementation((envelope: unknown) => envelope);
    protocolMocks.signChatEnvelope.mockImplementation(async (envelope: unknown) => ({
      ...(envelope as object),
      auth: { id: "signed-event-id", sig: "signed-event-signature" },
    }));
    coordinatorMocks.fetchMessages.mockResolvedValue([]);
    coordinatorMocks.fetchJoinRequests.mockResolvedValue([]);
    coordinatorMocks.fetchWelcomes.mockResolvedValue([]);
    coordinatorMocks.postGroupMessage.mockResolvedValue({ cursor: 1, gid: "room-id", at: 1 });
    coordinatorMocks.publishKeyPackage.mockResolvedValue(undefined);
    coordinatorMocks.storeJoinRequest.mockResolvedValue(undefined);
    coordinatorMocks.close.mockResolvedValue(undefined);
  });

  it("rejects reactions targeting the current participant's own message", async () => {
    const room = storedRoom();
    room.messages = [{
      type: "message",
      id: "own-message",
      sender: room.stablePubkey,
      name: room.name,
      content: "Mine",
      createdAt: 1,
    }];
    const session = connectedSession(room);

    await expect(session.setReaction("own-message", "👍", true))
      .rejects.toThrow("You cannot react to your own message");
    expect(protocolMocks.signChatEnvelope).not.toHaveBeenCalled();
    expect(protocolMocks.encryptMessage).not.toHaveBeenCalled();
    expect(coordinatorMocks.postGroupMessage).not.toHaveBeenCalled();
  });

  it("serializes concurrent sends so each encryption advances from the previous MLS state", async () => {
    const firstEncryption = deferred<void>();
    const secondEncryption = deferred<void>();
    const gates = [firstEncryption, secondEncryption];
    const inputStates: unknown[] = [];
    let activeEncryptions = 0;
    let maximumConcurrentEncryptions = 0;

    protocolMocks.encryptMessage.mockImplementation(async (state: unknown, event: { content: string }) => {
      const callIndex = inputStates.length;
      inputStates.push(state);
      activeEncryptions += 1;
      maximumConcurrentEncryptions = Math.max(maximumConcurrentEncryptions, activeEncryptions);
      await gates[callIndex].promise;
      activeEncryptions -= 1;
      return {
        state: `${String(state)}>${event.content}`,
        opaqueBase64: `opaque-${event.content}`,
      };
    });

    const session = connectedSession();
    const firstSend = session.send("first");
    const secondSend = session.send("second");

    await vi.waitFor(() => expect(protocolMocks.encryptMessage).toHaveBeenCalledTimes(1));
    expect(maximumConcurrentEncryptions).toBe(1);

    firstEncryption.resolve(undefined);
    await vi.waitFor(() => expect(protocolMocks.encryptMessage).toHaveBeenCalledTimes(2));
    expect(maximumConcurrentEncryptions).toBe(1);

    secondEncryption.resolve(undefined);
    await Promise.all([firstSend, secondSend]);

    expect(inputStates).toEqual(["state-0", "state-0>first"]);
    expect(protocolMocks.signChatEnvelope).toHaveBeenCalledTimes(2);
    expect(protocolMocks.encryptMessage).toHaveBeenNthCalledWith(1, "state-0", expect.objectContaining({
      content: "first",
      auth: { id: "signed-event-id", sig: "signed-event-signature" },
    }));
    expect(session.room.stateBase64).toBe("state-0>first>second");
    expect(session.room.messages.map((message) => message.content)).toEqual(["first", "second"]);
  });

  it("carries normalized recipients through the queued pending send", async () => {
    protocolMocks.encryptMessage.mockResolvedValue({ state: "state-1", opaqueBase64: "opaque-recipient" });
    const publishing = deferred<{ cursor: number; gid: string; at: number }>();
    coordinatorMocks.postGroupMessage.mockReturnValue(publishing.promise);
    const session = connectedSession();
    const recipient = "b".repeat(64);

    const sending = session.send("mention", { recipientPubkeys: [recipient.toUpperCase(), recipient] });
    await vi.waitFor(() => expect(protocolMocks.encryptMessage).toHaveBeenCalledTimes(1));

    expect(protocolMocks.signChatEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      recipientPubkeys: [recipient],
    }), expect.anything());
    expect(session.room.messages).toEqual([expect.objectContaining({
      pending: true,
      recipientPubkeys: [recipient],
    })]);
    expect(session.room.pending).toEqual([expect.objectContaining({ id: expect.any(String) })]);
    publishing.resolve({ cursor: 1, gid: "room-id", at: 1 });
    await sending;
  });

  it("fails closed when a targeted send has no valid recipients", async () => {
    const session = connectedSession();

    await expect(session.send("targeted invite", { recipientPubkeys: ["not-a-pubkey"] }))
      .rejects.toThrow("Targeted messages require at least one valid recipient");

    expect(protocolMocks.signChatEnvelope).not.toHaveBeenCalled();
    expect(protocolMocks.encryptMessage).not.toHaveBeenCalled();
    expect(coordinatorMocks.postGroupMessage).not.toHaveBeenCalled();
    expect(session.room.messages).toEqual([]);
    expect(session.room.pending).toEqual([]);
  });

  it("waits for an active message pull before encrypting a send", async () => {
    const activePull = deferred<Array<{ cursor: number; msg_64: string }>>();
    const order: string[] = [];

    coordinatorMocks.fetchMessages
      .mockImplementationOnce(async () => {
        order.push("pull:start");
        const messages = await activePull.promise;
        order.push("pull:end");
        return messages;
      })
      .mockResolvedValue([]);
    protocolMocks.decryptMessage.mockImplementation(async () => ({
      state: "state-after-pull",
      envelope: {
        type: "message",
        id: "remote-message",
        sender: "b".repeat(64),
        name: "Remote",
        content: "arrived first",
        createdAt: 1,
      },
    }));
    protocolMocks.encryptMessage.mockImplementation(async (state: unknown, event: { content: string }) => {
      order.push("encrypt");
      return {
        state: `${String(state)}>${event.content}`,
        opaqueBase64: `opaque-${event.content}`,
      };
    });

    const session = connectedSession();
    const syncing = session.sync();
    await vi.waitFor(() => expect(coordinatorMocks.fetchMessages).toHaveBeenCalledTimes(1));

    const sending = session.send("sent after pull");
    await Promise.resolve();

    expect(protocolMocks.encryptMessage).not.toHaveBeenCalled();
    expect(order).toEqual(["pull:start"]);

    activePull.resolve([{ cursor: 1, msg_64: "remote-ciphertext" }]);
    await Promise.all([syncing, sending]);

    expect(protocolMocks.encryptMessage).toHaveBeenCalledTimes(1);
    expect(protocolMocks.encryptMessage.mock.calls[0][0]).toBe("state-after-pull");
    expect(order).toEqual(["pull:start", "pull:end", "encrypt"]);
    expect(session.room.stateBase64).toBe("state-after-pull>sent after pull");
  });

  it("cannot resurrect a discarded room when an in-flight sync finishes", async () => {
    const activePull = deferred<Array<{ cursor: number; msg_64: string }>>();
    coordinatorMocks.fetchMessages.mockImplementationOnce(() => activePull.promise);
    const room = storedRoom();
    saveRoom(room);
    const session = connectedSession(room);

    const syncing = session.sync();
    await vi.waitFor(() => expect(coordinatorMocks.fetchMessages).toHaveBeenCalledOnce());

    session.discard();
    removeStoredRoom(room);
    activePull.resolve([]);
    await syncing;

    expect(loadRoom(room.id, room.coordinatorPubkey)).toBeNull();
  });

  it("keeps a recoverable startup failure in connecting state without publishing offline", async () => {
    coordinatorMocks.fetchMessages.mockRejectedValueOnce(new Error("relay timeout"));
    const offline = vi.fn();
    window.addEventListener("cordn:server-offline", offline);
    const session = connectedSession();

    await expect(session.recover(new AbortController().signal)).rejects.toThrow("Hosted room recovery failed");

    expect(session.status.connection).toBe("connecting");
    expect(offline).not.toHaveBeenCalled();
    window.removeEventListener("cordn:server-offline", offline);
  });

  it("keeps polling after a recovered hosted room enters steady state", async () => {
    vi.useFakeTimers();
    try {
      const room = storedRoom();
      room.isHost = true;
      const session = connectedSession(room);

      await session.recover(new AbortController().signal);
      expect(coordinatorMocks.fetchJoinRequests).toHaveBeenCalledTimes(1);

      session.activateSteadyState();
      await vi.advanceTimersByTimeAsync(4_000);

      expect(coordinatorMocks.fetchJoinRequests).toHaveBeenCalledTimes(2);
      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps steady-state polling single-flight while a coordinator publication is unresolved", async () => {
    vi.useFakeTimers();
    try {
      const activePull = deferred<Array<{ cursor: number; msg_64: string }>>();
      coordinatorMocks.fetchMessages.mockImplementationOnce(() => activePull.promise).mockResolvedValue([]);
      const session = connectedSession();

      session.activateSteadyState();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(coordinatorMocks.fetchMessages).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(16_000);
      expect(coordinatorMocks.fetchMessages).toHaveBeenCalledOnce();

      activePull.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(coordinatorMocks.fetchMessages).toHaveBeenCalledTimes(2);

      session.stop();
      expect(coordinatorMocks.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist or publish a late aborted recovery", async () => {
    const activePull = deferred<Array<{ cursor: number; msg_64: string }>>();
    coordinatorMocks.fetchMessages.mockImplementationOnce(() => activePull.promise);
    const room = storedRoom();
    saveRoom(room);
    const session = connectedSession(room);
    const controller = new AbortController();
    const updates = vi.fn();
    session.subscribe(updates);

    const recovering = session.recover(controller.signal);
    await vi.waitFor(() => expect(coordinatorMocks.fetchMessages).toHaveBeenCalledOnce());
    controller.abort();
    removeStoredRoom(room);
    activePull.resolve([]);
    await expect(recovering).rejects.toThrow();

    expect(loadRoom(room.id, room.coordinatorPubkey)).toBeNull();
    expect(updates).not.toHaveBeenCalled();
  });

  it("establishes a hydration baseline, then counts each unique remote message once", async () => {
    const remote = (id: string, sender = "b".repeat(64)) => ({
      type: "message" as const,
      id,
      sender,
      name: "Remote",
      content: id,
      createdAt: 1,
      auth: { id: `${id}-auth`, sig: "signature" },
    });
    const room = storedRoom();
    protocolMocks.decryptMessage
      .mockResolvedValueOnce({ state: "hydrated", envelope: remote("cached") })
      .mockResolvedValueOnce({ state: "next", envelope: remote("new") })
      .mockResolvedValueOnce({ state: "replay", envelope: remote("new") });
    coordinatorMocks.fetchMessages
      .mockResolvedValueOnce([{ cursor: 1, msg_64: "cached" }])
      .mockResolvedValueOnce([{ cursor: 2, msg_64: "new" }])
      .mockResolvedValueOnce([{ cursor: 3, msg_64: "replay" }]);
    const session = connectedSession(room);

    await session.sync();
    expect(roomUnreadCount(session.room)).toBe(0);
    await session.sync();
    expect(roomUnreadCount(session.room)).toBe(1);
    await session.sync();
    expect(roomUnreadCount(session.room)).toBe(1);
  });

  it.each([
    {
      scenario: "matching invite host",
      inviteHost: { name: "Ada", pubkey: "b".repeat(64), avatar: "https://images.example/ada.png" },
      expected: { name: "Ada", pubkey: "b".repeat(64), avatar: "https://images.example/ada.png" },
    },
    {
      scenario: "mismatched invite host",
      inviteHost: { name: "Mallory", pubkey: "d".repeat(64), avatar: "https://images.example/mallory.png" },
      expected: { name: "Unknown host", pubkey: "b".repeat(64) },
    },
    {
      scenario: "legacy invite without a host",
      inviteHost: undefined,
      expected: { name: "Unknown host", pubkey: "b".repeat(64) },
    },
  ])("reconciles $scenario with the MLS creator after admission", async ({ inviteHost, expected }) => {
    const room = storedRoom();
    room.joinRequestSent = true;
    room.keyPackage.lastResort = true;
    room.host = inviteHost;
    coordinatorMocks.fetchWelcomes.mockResolvedValue([{
      kp_ref: room.keyPackage.reference,
      welcome_64: "welcome",
      after: 0,
    }]);
    protocolMocks.joinWelcome.mockResolvedValue("joined-state");
    protocolMocks.groupId.mockReturnValue(room.id);
    protocolMocks.groupCreatorPubkey.mockReturnValue("b".repeat(64));

    await connectedSession(room).sync();

    expect(room.joinRequestSent).toBe(false);
    expect(room.host).toEqual(expected);
  });
});
