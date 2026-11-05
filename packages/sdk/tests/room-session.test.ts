import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";

import type {
  ChatCoordinatorOperations,
  RemoteGroupMessage,
  RemoteJoinRequest,
  RemoteWelcome,
} from "../src/client/coordinator-client.js";
import {
  addMember,
  createKeyPackage,
  createRoomState,
  decodeState,
  stateEpoch,
  encodeState,
  encryptMessage,
  groupId,
  joinWelcome,
  type ChatEnvelope,
  type LocalKeyPackage,
} from "../src/client/protocol.js";
import {
  configureRoomEnvironment,
  createMemoryRoomStorage,
  type RoomNotification,
  type RoomStorage,
} from "../src/client/room-environment.js";
import {
  ChatRoomSession,
  loadRoom,
  reactionSummary,
  rotateRoomInvite,
  ROOM_UNREAD_CHANGED_EVENT,
  roomUnreadCount,
  saveRoom,
  SERVER_OFFLINE_EVENT,
  SERVER_ONLINE_EVENT,
  type StoredRoom,
} from "../src/client/room-store.js";
import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";

const COORDINATOR = "c".repeat(64);
/**
 * Members of one room live in different browsers. Sharing one test storage, each side
 * needs its own composite key or they would overwrite each other's record.
 */
const GUEST_COORDINATOR = "e".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Small in-memory coordinator exposed through the same operations a remote client has.
 * Every method is a spy so a test can inject one fault while the MLS on top stays real.
 */
class FakeCoordinator {
  messages: RemoteGroupMessage[] = [];
  joinRequests: RemoteJoinRequest[] = [];
  welcomes: RemoteWelcome[] = [];
  packages: Array<{ pk: string; kp_ref: string; event: unknown }> = [];
  private cursor = 0;
  private clock = 1_000;
  joinRequestListener: (() => void | Promise<void>) | null = null;
  readonly unsubscribe = vi.fn();

  readonly ops = {
    close: vi.fn(async () => undefined),
    subscribeJoinRequests: vi.fn((_groupId: string, listener: () => void | Promise<void>) => {
      this.joinRequestListener = listener;
      return this.unsubscribe;
    }),
    publishKeyPackage: vi.fn(async (_reference: string, _keyPackageBase64: string) => undefined),
    storeJoinRequest: vi.fn(async (_groupId: string, _reference: string, _inviteToken?: string) => undefined),
    fetchWelcomes: vi.fn(async (consumed?: Array<{ kp_ref: string; at: number }>) => {
      if (consumed) this.welcomes = this.welcomes.filter((welcome) => !consumed.some((entry) => entry.kp_ref === welcome.kp_ref && entry.at === welcome.at));
      return [...this.welcomes];
    }),
    fetchJoinRequests: vi.fn(async (_groupId: string, consumed?: Array<{ pk: string; at: number }>) => {
      if (consumed) this.joinRequests = this.joinRequests.filter((request) => !consumed.some((entry) => entry.pk === request.pk && entry.at === request.at));
      return [...this.joinRequests];
    }),
    consumeKeyPackage: vi.fn(async (identifier: string): Promise<{ pk: string; kp_ref: string; event: unknown } | null> =>
      this.packages.find((entry) => entry.kp_ref === identifier || entry.pk === identifier) ?? null),
    postGroupMessage: vi.fn(async (gid: string, msg_64: string) => {
      this.cursor += 1;
      this.clock += 1;
      this.messages.push({ cursor: this.cursor, gid, msg_64, at: this.clock });
      return { cursor: this.cursor, gid, at: this.clock };
    }),
    storeWelcome: vi.fn(async (_target: string, kp_ref: string, welcome_64: string, after: number) => {
      this.clock += 1;
      this.welcomes.push({ kp_ref, welcome_64, at: this.clock, after });
    }),
    fetchMessages: vi.fn(async (_groupId: string, after?: number) => this.messages.filter((message) => message.cursor > (after ?? 0))),
  };

  readonly factory = vi.fn((): ChatCoordinatorOperations => this.ops);
}

function publication(keyPackageBase64: string) {
  return { content: JSON.stringify({ params: { arguments: { kp_64: keyPackageBase64 } } }) };
}

interface Member {
  signer: BrowserNostrSigner;
  pubkey: string;
  keys: Awaited<ReturnType<typeof createKeyPackage>>;
}

async function newMember(options?: { lastResort?: boolean }): Promise<Member> {
  const signer = new BrowserNostrSigner(generateSecretKey());
  const pubkey = await signer.getPublicKey();
  return { signer, pubkey, keys: await createKeyPackage(pubkey, options) };
}

function roomRecord(overrides: Partial<StoredRoom> & Pick<StoredRoom, "id" | "stablePubkey" | "keyPackage">): StoredRoom {
  return {
    version: 1,
    title: "Room",
    coordinatorPubkey: COORDINATOR,
    relayUrls: ["wss://relay.example"],
    name: "Member",
    isHost: false,
    stateBase64: "",
    lastCursor: 0,
    messages: [],
    pending: [],
    reactions: [],
    ...overrides,
  };
}

async function hostedRoom(hub: FakeCoordinator, overrides: Partial<StoredRoom> = {}) {
  const host = await newMember();
  const state = await createRoomState(host.keys.keyPackage, host.keys.privateKeyPackage);
  const room = roomRecord({
    id: groupId(state),
    name: "Host",
    stablePubkey: host.pubkey,
    keyPackage: host.keys.stored,
    stateBase64: encodeState(state),
    isHost: true,
    autoApprove: true,
    ...overrides,
  });
  return { host, room, session: new ChatRoomSession(room, host.signer, hub.factory) };
}

/** Both members already share an MLS epoch, with independent coordinator clients on one hub. */
async function twoMembers(hub: FakeCoordinator, hostOverrides: Partial<StoredRoom> = {}, guestOverrides: Partial<StoredRoom> = {}) {
  const host = await newMember();
  const guest = await newMember();
  const initial = await createRoomState(host.keys.keyPackage, host.keys.privateKeyPackage);
  const added = await addMember(initial, guest.keys.stored.publicBase64);
  const guestState = await joinWelcome(added.welcomeBase64, guest.keys.stored);
  const id = groupId(initial);
  const hostRoomRecord = roomRecord({ id, name: "Host", stablePubkey: host.pubkey, keyPackage: host.keys.stored, stateBase64: encodeState(added.state), isHost: true, autoApprove: true, ...hostOverrides });
  const guestRoomRecord = roomRecord({ id, coordinatorPubkey: GUEST_COORDINATOR, name: "Guest", stablePubkey: guest.pubkey, keyPackage: guest.keys.stored, stateBase64: encodeState(guestState), ...guestOverrides });
  return {
    host,
    guest,
    hostSession: new ChatRoomSession(hostRoomRecord, host.signer, hub.factory),
    guestSession: new ChatRoomSession(guestRoomRecord, guest.signer, hub.factory),
  };
}

/** A prospective member who has published a package and asked to join. */
async function requester(hub: FakeCoordinator, room: StoredRoom, token?: string, at = 50) {
  const member = await newMember({ lastResort: true });
  hub.packages.push({ pk: member.pubkey, kp_ref: member.keys.stored.reference, event: publication(member.keys.stored.publicBase64) });
  const request: RemoteJoinRequest = { gid: room.id, pk: member.pubkey, kp_ref: member.keys.stored.reference, at, invite_token: token };
  hub.joinRequests.push(request);
  return { member, request };
}

function waitingGuestRoom(id: string, member: Member, overrides: Partial<StoredRoom> = {}): StoredRoom {
  return roomRecord({ id, coordinatorPubkey: GUEST_COORDINATOR, name: "Waiting", stablePubkey: member.pubkey, keyPackage: member.keys.stored, joinRequestSent: true, ...overrides });
}

let storage: RoomStorage;
let events: EventTarget;
let notifications: RoomNotification[];
let restoreEnvironment: () => void;
let warn: ReturnType<typeof vi.spyOn>;
const sessions: ChatRoomSession[] = [];

function track<T extends ChatRoomSession>(session: T): T {
  sessions.push(session);
  return session;
}

function collect(type: string): unknown[] {
  const seen: unknown[] = [];
  events.addEventListener(type, (event) => seen.push((event as CustomEvent).detail));
  return seen;
}

function stored(room: StoredRoom): StoredRoom | null {
  return loadRoom(room.id, room.coordinatorPubkey);
}

beforeEach(() => {
  storage = createMemoryRoomStorage();
  events = new EventTarget();
  notifications = [];
  restoreEnvironment = configureRoomEnvironment({
    storage,
    events,
    notifications: { record: (notification) => notifications.push(notification) },
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.stop();
  restoreEnvironment();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session lifecycle", () => {
  it("publishes connecting then connected, persists and announces the server once", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const online = collect(SERVER_ONLINE_EVENT);
    const statuses: string[] = [];
    const unsubscribe = session.subscribe(() => statuses.push(session.status.connection));

    await session.start();
    await session.sync();

    expect(statuses[0]).toBe("connecting");
    expect(statuses.at(-1)).toBe("connected");
    expect(online).toEqual([{ coordinatorPubkey: COORDINATOR, roomId: room.id }]);
    expect(stored(room)?.updatedAt).toEqual(expect.any(Number));

    const seen = statuses.length;
    unsubscribe();
    await session.sync();
    expect(statuses).toHaveLength(seen);
  });

  it("polls every four seconds in steady state and stops polling when stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    track(session);
    await session.start();
    const before = hub.ops.fetchMessages.mock.calls.length;

    await vi.advanceTimersByTimeAsync(3_999);
    expect(hub.ops.fetchMessages.mock.calls.length).toBe(before);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(hub.ops.fetchMessages.mock.calls.length).toBe(before + 1));
    await session.sync();

    session.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(hub.ops.close).toHaveBeenCalled();
  });

  it("ignores a timer tick that fires after the session was stopped", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    await session.start();
    const tick = interval.mock.calls.at(-1)?.[0] as () => void;
    expect(interval.mock.calls.at(-1)?.[1]).toBe(4_000);

    session.stop();
    const before = hub.ops.fetchMessages.mock.calls.length;
    tick();
    await Promise.resolve();

    expect(hub.ops.fetchMessages.mock.calls.length).toBe(before);
  });

  it("activating steady state twice keeps a single timer, and is inert once stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    track(session);

    session.activateSteadyState();
    session.activateSteadyState();
    expect(vi.getTimerCount()).toBe(1);

    session.stop();
    session.activateSteadyState();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enter steady state when stopped during its initial sync", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const hub = new FakeCoordinator();
    const gate = deferred<RemoteGroupMessage[]>();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const { session } = await hostedRoom(hub);

    const starting = session.start();
    await vi.waitFor(() => expect(hub.ops.fetchMessages).toHaveBeenCalled());
    session.stop();
    gate.resolve([]);
    await starting;

    expect(vi.getTimerCount()).toBe(0);
    expect(hub.ops.subscribeJoinRequests).not.toHaveBeenCalled();
  });

  it("does nothing on sync after stop, including one queued just before stopping", async () => {
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);

    const queued = session.sync();
    session.stop();
    await queued;
    await session.sync();

    expect(hub.ops.fetchMessages).not.toHaveBeenCalled();
    expect(hub.factory).not.toHaveBeenCalled();
  });

  it("coalesces overlapping sync calls into one coordinator pass", async () => {
    const hub = new FakeCoordinator();
    const gate = deferred<RemoteGroupMessage[]>();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const { session } = await hostedRoom(hub);
    track(session);

    const first = session.sync();
    const second = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchMessages).toHaveBeenCalledOnce());
    gate.resolve([]);
    await Promise.all([first, second]);

    expect(hub.ops.fetchMessages).toHaveBeenCalledOnce();

    await session.sync();
    expect(hub.ops.fetchMessages).toHaveBeenCalledTimes(2);
  });

  it("can restart after stop with a fresh client", async () => {
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    track(session);
    await session.start();
    session.stop();

    await session.start();

    expect(session.status.connection).toBe("connected");
    expect(hub.factory).toHaveBeenCalledTimes(2);
  });

  it("does not resubscribe to a client that offers no join-request push", async () => {
    const hub = new FakeCoordinator();
    const { subscribeJoinRequests: _omit, ...withoutPush } = hub.ops;
    const { host, room } = await hostedRoom(hub);
    const session = track(new ChatRoomSession(room, host.signer, () => withoutPush));

    await session.start();

    expect(session.status.connection).toBe("connected");
    expect(hub.ops.subscribeJoinRequests).not.toHaveBeenCalled();
  });

  it("does not subscribe to join requests for a guest session", async () => {
    const hub = new FakeCoordinator();
    const { guestSession } = await twoMembers(hub);
    track(guestSession);

    await guestSession.start();

    expect(hub.ops.subscribeJoinRequests).not.toHaveBeenCalled();
  });
});

describe("join-request push", () => {
  async function pushSession() {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    await session.start();
    expect(hub.ops.subscribeJoinRequests).toHaveBeenCalledWith(room.id, expect.any(Function));
    return { hub, session, listener: () => hub.joinRequestListener?.() };
  }

  it("syncs immediately when a request arrives and unsubscribes on stop", async () => {
    const { hub, session, listener } = await pushSession();
    const before = hub.ops.fetchJoinRequests.mock.calls.length;

    await listener();
    expect(hub.ops.fetchJoinRequests.mock.calls.length).toBe(before + 1);

    session.stop();
    expect(hub.unsubscribe).toHaveBeenCalledOnce();
  });

  it("runs one more pass when the signal arrived during an in-flight sync", async () => {
    const { hub, session, listener } = await pushSession();
    const gate = deferred<RemoteGroupMessage[]>();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const inflight = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchMessages.mock.calls.length).toBeGreaterThan(1));
    const before = hub.ops.fetchJoinRequests.mock.calls.length;

    const signal = listener();
    gate.resolve([]);
    await Promise.all([inflight, signal]);

    expect(hub.ops.fetchJoinRequests.mock.calls.length).toBe(before + 1);
  });

  it("skips the extra pass when stopped while waiting for the in-flight sync", async () => {
    const { hub, session, listener } = await pushSession();
    const gate = deferred<RemoteGroupMessage[]>();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const inflight = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchMessages.mock.calls.length).toBeGreaterThan(1));
    const before = hub.ops.fetchJoinRequests.mock.calls.length;

    const signal = listener();
    session.stop();
    gate.resolve([]);
    await Promise.all([inflight, signal]);

    expect(hub.ops.fetchJoinRequests.mock.calls.length).toBe(before);
  });

  it("skips the extra pass when a newer lifecycle replaced this one mid-flight", async () => {
    const { hub, session, listener } = await pushSession();
    const gate = deferred<RemoteGroupMessage[]>();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const inflight = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchMessages.mock.calls.length).toBeGreaterThan(1));

    const signal = listener();
    // A successful recovery bumps the generation without leaving the session stopped.
    const recovering = session.recover(new AbortController().signal);
    const before = hub.ops.fetchJoinRequests.mock.calls.length;
    gate.resolve([]);
    await Promise.all([inflight, signal, recovering]);

    // Exactly one pass: the recovery itself, not a stale listener follow-up.
    expect(hub.ops.fetchJoinRequests.mock.calls.length).toBe(before + 1);
  });

  it("ignores a stale signal delivered after the session stopped", async () => {
    const { hub, session, listener } = await pushSession();
    session.stop();
    const before = hub.ops.fetchJoinRequests.mock.calls.length;

    await listener();

    expect(hub.ops.fetchJoinRequests.mock.calls.length).toBe(before);
  });
});

describe("connectivity", () => {
  it("reports each outage once, replaces the client, and announces the return", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const offline = collect(SERVER_OFFLINE_EVENT);
    const online = collect(SERVER_ONLINE_EVENT);
    await session.start();
    const clientsBefore = hub.factory.mock.calls.length;

    hub.ops.fetchMessages.mockRejectedValueOnce(new Error("relay down"));
    await session.sync();
    expect(session.status).toEqual({ connection: "offline", detail: "relay down" });
    expect(hub.ops.close).toHaveBeenCalledOnce();

    hub.ops.fetchMessages.mockRejectedValueOnce("not an error");
    await session.sync();
    expect(session.status).toEqual({ connection: "offline", detail: "Coordinator unavailable" });
    expect(offline).toEqual([{ coordinatorPubkey: COORDINATOR, roomId: room.id }]);

    await session.sync();
    expect(session.status).toEqual({ connection: "connected", detail: undefined });
    expect(online).toHaveLength(2);
    expect(hub.factory.mock.calls.length).toBe(clientsBefore + 2);
  });

  it("follows browser connectivity signals until the session stops", async () => {
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    await session.start();
    const offline = collect(SERVER_OFFLINE_EVENT);
    const online = collect(SERVER_ONLINE_EVENT);

    events.dispatchEvent(new Event("offline"));
    expect(session.status).toEqual({ connection: "offline", detail: "Browser offline" });
    expect(offline).toHaveLength(1);

    events.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(session.status.connection).toBe("connected"));
    expect(online).toHaveLength(1);

    session.stop();
    events.dispatchEvent(new Event("offline"));
    expect(session.status.connection).toBe("connected");
    expect(offline).toHaveLength(1);
  });

  it("does not report an outage when stop() closed the client under an in-flight sync", async () => {
    const hub = new FakeCoordinator();
    const gate = deferred<RemoteGroupMessage[]>();
    const { session } = await hostedRoom(hub);
    await session.start();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const offline = collect(SERVER_OFFLINE_EVENT);

    const syncing = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchMessages.mock.calls.length).toBeGreaterThan(1));
    session.stop();
    gate.reject(new Error("client closed"));
    await syncing;

    expect(offline).toEqual([]);
    expect(session.status.connection).toBe("connected");
  });

  it("does not announce a server as online from a stopped waiting guest", async () => {
    const hub = new FakeCoordinator();
    const member = await newMember({ lastResort: true });
    const session = new ChatRoomSession(waitingGuestRoom("group", member), member.signer, hub.factory);
    const gate = deferred<RemoteWelcome[]>();
    hub.ops.fetchWelcomes.mockImplementationOnce(() => gate.promise);
    const online = collect(SERVER_ONLINE_EVENT);

    const syncing = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchWelcomes).toHaveBeenCalled());
    session.stop();
    gate.resolve([]);
    await syncing;

    expect(online).toEqual([]);
  });

  it("does not announce a server as online when stopped during the final pull", async () => {
    const hub = new FakeCoordinator();
    const gate = deferred<RemoteGroupMessage[]>();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const { session } = await hostedRoom(hub);
    const online = collect(SERVER_ONLINE_EVENT);

    const syncing = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchMessages).toHaveBeenCalled());
    session.stop();
    gate.resolve([]);
    await syncing;

    expect(online).toEqual([]);
  });

  it("keeps polling and notifying listeners when storage is full, then persists once it recovers", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    await session.start();
    const realSetItem = storage.setItem.bind(storage);
    storage.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
    const updates = vi.fn();
    session.subscribe(updates);
    room.title = "Changed while storage was full";

    await expect(session.sync()).resolves.toBeUndefined();

    expect(updates).toHaveBeenCalled();
    expect(session.status.connection).toBe("connected");
    expect(stored(room)?.title).not.toBe("Changed while storage was full");

    storage.setItem = realSetItem;
    await session.sync();
    expect(stored(room)?.title).toBe("Changed while storage was full");
  });

  it("does not write back a discarded room when an operation finishes", async () => {
    const hub = new FakeCoordinator();
    const gate = deferred<RemoteGroupMessage[]>();
    hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
    const { session, room } = await hostedRoom(hub);

    const syncing = session.sync();
    await vi.waitFor(() => expect(hub.ops.fetchMessages).toHaveBeenCalled());
    session.discard();
    gate.resolve([]);
    await syncing;

    expect(stored(room)).toBeNull();
  });
});

describe("sending", () => {
  it("ignores blank input without touching MLS or the coordinator", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const state = room.stateBase64;

    await session.send("   ");

    expect(room.stateBase64).toBe(state);
    expect(hub.factory).not.toHaveBeenCalled();
  });

  it("refuses to send until connected, when stopped, and while awaiting admission", async () => {
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    await expect(session.send("too early")).rejects.toThrow("must be connected");

    await session.start();
    session.stop();
    await expect(session.send("too late")).rejects.toThrow("must be connected");

    const member = await newMember({ lastResort: true });
    const waiting = track(new ChatRoomSession(waitingGuestRoom("group", member), member.signer, hub.factory));
    await waiting.sync();
    expect(waiting.status).toEqual({ connection: "connected", detail: "Waiting for the host to admit you" });
    await expect(waiting.send("let me in")).rejects.toThrow("Wait for the host");
  });

  it("delivers a signed, attributed message to the other member over real MLS", async () => {
    const hub = new FakeCoordinator();
    const { host, guest, hostSession, guestSession } = await twoMembers(hub);
    track(hostSession);
    track(guestSession);
    await hostSession.start();
    await guestSession.start();
    hostSession.setIdentity({ name: "Ada", avatar: "https://images.example/a.png", badgeLabel: "host", badgeEmoji: "👑" });

    await hostSession.send("  hello guest  ");
    await guestSession.sync();

    expect(hostSession.room.messages).toEqual([
      expect.objectContaining({ content: "hello guest", pending: false, cursor: 1, sender: host.pubkey }),
    ]);
    expect(stored(hostSession.room)?.messages[0]?.pending).toBe(false);
    expect(guestSession.room.messages).toEqual([
      expect.objectContaining({
        content: "hello guest",
        sender: host.pubkey,
        name: "Ada",
        avatar: "https://images.example/a.png",
        badgeLabel: "host",
        badgeEmoji: "👑",
      }),
    ]);
    expect(guestSession.room.messages[0]?.sender).not.toBe(guest.pubkey);
  });

  it("delivers two identical messages sent within the same second as two messages", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    const hub = new FakeCoordinator();
    const { hostSession, guestSession } = await twoMembers(hub);
    track(hostSession);
    track(guestSession);
    await hostSession.start();
    await guestSession.start();

    await hostSession.send("ok");
    await hostSession.send("ok");
    await guestSession.sync();

    const ids = hostSession.room.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(2);
    expect(guestSession.room.messages.map((message) => message.content)).toEqual(["ok", "ok"]);
    expect(stored(hostSession.room)?.messages).toHaveLength(2);
    expect(stored(guestSession.room)?.messages).toHaveLength(2);
  });

  it("does not delay a different message or the same message a second later", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    const hub = new FakeCoordinator();
    const { hostSession } = await twoMembers(hub);
    track(hostSession);
    await hostSession.start();

    await hostSession.send("one");
    await hostSession.send("two");
    vi.setSystemTime(1_700_000_001_000);
    await hostSession.send("one");

    expect(hostSession.room.messages.map((message) => message.createdAt)).toEqual([
      1_700_000_000_000,
      1_700_000_000_000,
      1_700_000_001_000,
    ]);
  });

  it("keeps a message queued through an outage and delivers it exactly once later", async () => {
    const hub = new FakeCoordinator();
    const { hostSession, guestSession } = await twoMembers(hub);
    track(hostSession);
    track(guestSession);
    await hostSession.start();
    await guestSession.start();
    hub.ops.postGroupMessage.mockRejectedValueOnce(new Error("post failed"));

    await hostSession.send("eventually");

    expect(hostSession.status.connection).toBe("offline");
    expect(hostSession.room.pending).toHaveLength(1);
    expect(stored(hostSession.room)?.pending).toHaveLength(1);
    expect(hostSession.room.messages[0]?.pending).toBe(true);

    await hostSession.sync();
    await guestSession.sync();

    expect(hostSession.room.pending).toEqual([]);
    expect(hostSession.room.messages[0]?.pending).toBe(false);
    expect(guestSession.room.messages.map((message) => message.content)).toEqual(["eventually"]);
    expect(hub.messages).toHaveLength(1);
  });

  it("does not try to decrypt its own post when the pull after posting failed", async () => {
    const hub = new FakeCoordinator();
    const { hostSession } = await twoMembers(hub);
    track(hostSession);
    await hostSession.start();
    hub.ops.fetchMessages.mockRejectedValueOnce(new Error("pull failed"));

    await hostSession.send("mine");
    expect(hostSession.status.connection).toBe("offline");
    expect(hostSession.room.lastCursor).toBe(0);

    await hostSession.sync();

    expect(hostSession.status.connection).toBe("connected");
    expect(hostSession.room.messages).toHaveLength(1);
    expect(hostSession.room.lastCursor).toBe(1);
  });

  it("advances past coordinator payloads that cannot be decrypted", async () => {
    const hub = new FakeCoordinator();
    const { hostSession } = await twoMembers(hub);
    track(hostSession);
    hub.messages.push({ cursor: 1, gid: hostSession.room.id, msg_64: "bm90IG1scw==", at: 1 });
    await hub.ops.postGroupMessage(hostSession.room.id, "bm90IG1scw==");

    await hostSession.sync();

    expect(hostSession.status.connection).toBe("connected");
    expect(hostSession.room.messages).toEqual([]);
    expect(hostSession.room.lastCursor).toBe(1);
  });
});

describe("reactions", () => {
  async function reactingRoom() {
    const hub = new FakeCoordinator();
    const parts = await twoMembers(hub);
    track(parts.hostSession);
    track(parts.guestSession);
    await parts.hostSession.start();
    await parts.guestSession.start();
    await parts.hostSession.send("react to me");
    await parts.guestSession.sync();
    const target = parts.hostSession.room.messages[0]!.id;
    return { hub, target, ...parts };
  }

  it("refuses when offline, unadmitted, for unknown targets, and for foreign emoji", async () => {
    const { target, guestSession } = await reactingRoom();

    await expect(guestSession.setReaction("missing", "👍", true)).rejects.toThrow("no longer available");
    await expect(guestSession.setReaction(target, "🦄" as "👍", true)).rejects.toThrow("not available as a reaction");

    guestSession.room.joinRequestSent = true;
    await expect(guestSession.setReaction(target, "👍", true)).rejects.toThrow("Wait for the host");
    guestSession.room.joinRequestSent = false;

    guestSession.stop();
    await expect(guestSession.setReaction(target, "👍", true)).rejects.toThrow("must be connected");
  });

  it("applies locally, records the posted cursor, and reaches the other member", async () => {
    const { target, guest, hostSession, guestSession } = await reactingRoom();

    await guestSession.setReaction(target, "👍", true);

    expect(guestSession.room.reactions).toEqual([
      expect.objectContaining({ targetMessageId: target, emoji: "👍", active: true, sender: guest.pubkey, cursor: 2 }),
    ]);
    expect(guestSession.room.messages).toHaveLength(1);

    await hostSession.sync();

    expect(hostSession.room.messages).toHaveLength(1);
    expect(reactionSummary(hostSession.room, target, hostSession.room.stablePubkey))
      .toEqual([{ emoji: "👍", count: 1, viewerActive: false }]);
    expect(reactionSummary(guestSession.room, target, guest.pubkey))
      .toEqual([{ emoji: "👍", count: 1, viewerActive: true }]);
  });

  it("gives each posted reaction its own cursor and keeps earlier ones unchanged", async () => {
    const { target, guestSession } = await reactingRoom();

    await guestSession.setReaction(target, "👍", true);
    await guestSession.setReaction(target, "🎉", true);

    expect(guestSession.room.reactions?.map((reaction) => [reaction.emoji, reaction.cursor])).toEqual([["👍", 2], ["🎉", 3]]);
    expect(stored(guestSession.room)?.reactions).toHaveLength(2);
  });

  it("records a reaction on a room written before reactions existed", async () => {
    const { target, hostSession, guestSession } = await reactingRoom();
    delete hostSession.room.reactions;
    delete guestSession.room.reactions;

    await guestSession.setReaction(target, "👍", true);
    await hostSession.sync();

    expect(guestSession.room.reactions).toHaveLength(1);
    expect(hostSession.room.reactions).toHaveLength(1);
  });

  it("toggles on and off, and the removal reaches the other member", async () => {
    const { target, guest, hostSession, guestSession } = await reactingRoom();

    await guestSession.toggleReaction(target, "🎉");
    expect(reactionSummary(guestSession.room, target, guest.pubkey)[0]?.viewerActive).toBe(true);

    await guestSession.toggleReaction(target, "🎉");
    expect(reactionSummary(guestSession.room, target, guest.pubkey)).toEqual([]);

    await hostSession.sync();
    expect(reactionSummary(hostSession.room, target, hostSession.room.stablePubkey)).toEqual([]);
    expect(hostSession.room.reactions).toHaveLength(1);
    expect(hostSession.room.reactions?.[0]?.active).toBe(false);
  });

  it("evaluates a queued toggle against the state left by the toggle before it", async () => {
    const { target, guest, hostSession, guestSession } = await reactingRoom();

    await Promise.all([
      guestSession.toggleReaction(target, "👍"),
      guestSession.toggleReaction(target, "👍"),
    ]);

    expect(reactionSummary(guestSession.room, target, guest.pubkey)).toEqual([]);
    await hostSession.sync();
    expect(reactionSummary(hostSession.room, target, hostSession.room.stablePubkey)).toEqual([]);
  });

  it("ignores a reaction older than the mutation already recorded for that participant", async () => {
    const { target, guest, hostSession, guestSession } = await reactingRoom();
    hostSession.room.reactions = [{
      id: "newer",
      sender: guest.pubkey,
      createdAt: Date.now() + 60_000,
      cursor: 999,
      targetMessageId: target,
      emoji: "👍",
      active: false,
    }];

    await guestSession.setReaction(target, "👍", true);
    await hostSession.sync();

    expect(hostSession.room.reactions).toEqual([expect.objectContaining({ id: "newer", active: false })]);
  });

  it("replaces an older mutation and leaves other participants' reactions in place", async () => {
    const { target, guest, hostSession, guestSession } = await reactingRoom();
    const other = { id: "other", sender: "9".repeat(64), createdAt: 1, cursor: 1, targetMessageId: target, emoji: "👍" as const, active: true };
    hostSession.room.reactions = [
      other,
      { ...other, id: "older", sender: guest.pubkey, active: false },
    ];

    await guestSession.setReaction(target, "👍", true);
    await hostSession.sync();

    expect(hostSession.room.reactions?.map((reaction) => reaction.id).sort()).toEqual(
      ["other", guestSession.room.reactions![0]!.id].sort(),
    );
    expect(reactionSummary(hostSession.room, target, hostSession.room.stablePubkey)[0]?.count).toBe(2);
  });

  it("ignores a reaction to a message this member never received", async () => {
    const { target, hostSession, guestSession } = await reactingRoom();
    hostSession.room.messages = hostSession.room.messages.filter((message) => message.id !== target);

    await guestSession.setReaction(target, "👍", true);
    await hostSession.sync();

    expect(hostSession.room.reactions).toEqual([]);
  });

  it("ignores a structurally invalid reaction mutation", async () => {
    const hub = new FakeCoordinator();
    const { hostSession, guestSession } = await twoMembers(hub);
    track(hostSession);
    await hostSession.start();
    await hostSession.send("target");
    const target = hostSession.room.messages[0]!.id;
    const forged: ChatEnvelope = {
      type: "message",
      id: "forged",
      sender: guestSession.room.stablePubkey,
      name: "Mallory",
      content: "Reacted 👍",
      createdAt: Date.now(),
      // A target key without its kind is neither the legacy nor the canonical shape.
      reaction: { targetMessageId: target, targetPubkey: hostSession.room.stablePubkey, emoji: "👍", active: true },
    };
    const encrypted = await encryptMessage(decodeState(guestSession.room.stateBase64), forged);
    await hub.ops.postGroupMessage(hostSession.room.id, encrypted.opaqueBase64);

    await hostSession.sync();

    expect(hostSession.room.reactions).toEqual([]);
  });
});

describe("identity", () => {
  it("normalizes a host's presentation and keeps the host record current", async () => {
    const hub = new FakeCoordinator();
    const { session, host, room } = await hostedRoom(hub);
    const updates = vi.fn();
    session.subscribe(updates);

    session.setIdentity({ name: "  Ada ", avatar: " https://images.example/a.png ", badgeLabel: " owner ", badgeEmoji: " ⭐ " });

    expect(room).toMatchObject({ name: "Ada", avatar: "https://images.example/a.png", badgeLabel: "owner", badgeEmoji: "⭐", host: { name: "Ada", pubkey: host.pubkey, avatar: "https://images.example/a.png" } });
    expect(stored(room)?.name).toBe("Ada");
    expect(updates).toHaveBeenCalledOnce();

    session.setIdentity({ name: "   ", avatar: "  ", badgeLabel: "  ", badgeEmoji: "  " });
    expect(room).toMatchObject({ name: "Host", host: { name: "Host", pubkey: host.pubkey } });
    expect(room.avatar).toBeUndefined();
    expect(room.badgeLabel).toBeUndefined();
    expect(room.badgeEmoji).toBeUndefined();

    session.setIdentity({ name: "Bare" });
    expect(room.avatar).toBeUndefined();
  });

  it("falls back to Anonymous for a guest and never rewrites the room's host", async () => {
    const hub = new FakeCoordinator();
    const { guestSession } = await twoMembers(hub, {}, { host: { name: "Host", pubkey: "1".repeat(64) } });

    guestSession.setIdentity({ name: "  " });

    expect(guestSession.room.name).toBe("Anonymous");
    expect(guestSession.room.host).toEqual({ name: "Host", pubkey: "1".repeat(64) });
  });
});

describe("unread accounting", () => {
  async function established() {
    const hub = new FakeCoordinator();
    const parts = await twoMembers(hub);
    track(parts.hostSession);
    track(parts.guestSession);
    await parts.hostSession.start();
    await parts.guestSession.start();
    return { hub, ...parts };
  }

  it("counts remote messages after the baseline but never the member's own", async () => {
    const { hostSession, guestSession } = await established();
    const changes = collect(ROOM_UNREAD_CHANGED_EVENT);

    await hostSession.send("one");
    await hostSession.send("two");
    await guestSession.sync();
    await hostSession.sync();

    expect(roomUnreadCount(guestSession.room)).toBe(2);
    expect(roomUnreadCount(hostSession.room)).toBe(0);
    expect(stored(guestSession.room)?.readState?.unreadCount).toBe(2);
    expect(changes).toEqual([
      { coordinatorPubkey: GUEST_COORDINATOR, roomId: guestSession.room.id, previousCount: 0, unreadCount: 1 },
      { coordinatorPubkey: GUEST_COORDINATOR, roomId: guestSession.room.id, previousCount: 1, unreadCount: 2 },
    ]);
  });

  it("does not move the read pointer past messages that are still unread", async () => {
    const { hostSession, guestSession } = await established();
    const baseline = guestSession.room.readState?.lastReadCursor;

    await hostSession.send("unread");
    await guestSession.sync();

    expect(roomUnreadCount(guestSession.room)).toBe(1);
    expect(guestSession.room.readState?.lastReadCursor).toBe(baseline);
    expect(guestSession.room.lastCursor).toBeGreaterThan(baseline ?? 0);
  });

  it("markRead clears the count on the live room, persists it and survives the next sync", async () => {
    const { hostSession, guestSession } = await established();
    await hostSession.send("unread");
    await guestSession.sync();
    const changes = collect(ROOM_UNREAD_CHANGED_EVENT);
    const updates = vi.fn();
    guestSession.subscribe(updates);

    guestSession.markRead();

    expect(guestSession.room.readState).toEqual({ version: 1, baselineEstablished: true, lastReadCursor: guestSession.room.lastCursor, unreadCount: 0 });
    expect(stored(guestSession.room)?.readState?.unreadCount).toBe(0);
    expect(updates).toHaveBeenCalledOnce();
    expect(changes).toEqual([{ coordinatorPubkey: GUEST_COORDINATOR, roomId: guestSession.room.id, previousCount: 1, unreadCount: 0 }]);

    await guestSession.sync();
    expect(roomUnreadCount(guestSession.room)).toBe(0);
  });

  it("markRead stays silent when nothing was unread", async () => {
    const { guestSession } = await established();
    const changes = collect(ROOM_UNREAD_CHANGED_EVENT);

    guestSession.markRead();

    expect(changes).toEqual([]);
    expect(guestSession.room.readState?.baselineEstablished).toBe(true);
  });

  it("saturates at the largest safe count without announcing a change", async () => {
    const { hostSession, guestSession } = await established();
    guestSession.room.readState = { version: 1, baselineEstablished: true, lastReadCursor: 0, unreadCount: Number.MAX_SAFE_INTEGER };
    const changes = collect(ROOM_UNREAD_CHANGED_EVENT);

    await hostSession.send("overflow");
    await guestSession.sync();

    expect(guestSession.room.readState?.unreadCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(changes).toEqual([]);
  });

  it("establishes a baseline from history instead of counting it as unread", async () => {
    const hub = new FakeCoordinator();
    const { hostSession, guestSession } = await twoMembers(hub);
    track(hostSession);
    track(guestSession);
    await hostSession.start();
    await hostSession.send("history");

    await guestSession.start();

    expect(guestSession.room.messages).toHaveLength(1);
    expect(roomUnreadCount(guestSession.room)).toBe(0);
    expect(guestSession.room.readState?.lastReadCursor).toBe(guestSession.room.lastCursor);
  });

  it("notifies only after the first pull, with metadata and never message content", async () => {
    const { hostSession, guestSession, host } = await established();
    notifications.length = 0;

    await hostSession.send("top secret text");
    await guestSession.sync();
    await hostSession.sync();

    expect(notifications).toEqual([{
      category: "new_message",
      key: guestSession.room.messages[0]!.id,
      actor: "Host",
      room: "Room",
      roomKey: `${GUEST_COORDINATOR}\u0000${guestSession.room.id}`,
      actorPubkey: host.pubkey,
    }]);
    expect(JSON.stringify(notifications)).not.toContain("top secret text");
  });

  it("counts offline arrivals on a reloaded room without notifying about them", async () => {
    const hub = new FakeCoordinator();
    const { host, guest, hostSession, guestSession } = await twoMembers(hub);
    track(hostSession);
    await hostSession.start();
    await guestSession.sync();
    await hostSession.send("while away");

    const reloaded = track(new ChatRoomSession(guestSession.room, guest.signer, hub.factory));
    await reloaded.sync();

    expect(host.pubkey).not.toBe(guest.pubkey);
    expect(roomUnreadCount(reloaded.room)).toBe(1);
    expect(notifications).toEqual([]);
  });

  it("does not count a message whose proof was stripped for a forged role badge", async () => {
    const { hub, hostSession, guestSession } = await established();
    const forged: ChatEnvelope = { type: "message", id: "x", sender: guestSession.room.stablePubkey, name: "Guest", badgeLabel: "host", content: "badge claim", createdAt: Date.now() };
    const encrypted = await encryptMessage(decodeState(guestSession.room.stateBase64), forged);
    guestSession.room.stateBase64 = encodeState(encrypted.state);
    await hub.ops.postGroupMessage(guestSession.room.id, encrypted.opaqueBase64);
    const unreadBefore = roomUnreadCount(hostSession.room);

    await hostSession.sync();

    expect(hostSession.room.messages.map((message) => message.content)).toContain("badge claim");
    expect(hostSession.room.messages.find((message) => message.content === "badge claim")).not.toHaveProperty("badgeLabel");
    expect(roomUnreadCount(hostSession.room)).toBe(unreadBefore);
  });

  it("ignores a message whose claimed sender is another member's key", async () => {
    const { hub, hostSession, guestSession } = await established();
    const forged: ChatEnvelope = { type: "message", id: "x", sender: hostSession.room.stablePubkey, name: "Host", badgeLabel: "host", content: "forged", createdAt: Date.now() };
    const encrypted = await encryptMessage(decodeState(guestSession.room.stateBase64), forged);
    guestSession.room.stateBase64 = encodeState(encrypted.state);
    await hub.ops.postGroupMessage(guestSession.room.id, encrypted.opaqueBase64);

    await hostSession.sync();

    expect(hostSession.room.messages.map((message) => message.content)).not.toContain("forged");
    expect(hostSession.status.connection).toBe("connected");
  });

  it("works without a notification sink", async () => {
    restoreEnvironment();
    restoreEnvironment = configureRoomEnvironment({ storage, events });
    const { hostSession, guestSession } = await established();

    await hostSession.send("quiet");
    await guestSession.sync();

    expect(guestSession.room.messages).toHaveLength(1);
  });
});

describe("hosted admission", () => {
  it("auto-approves a request: commit, Welcome, acknowledgement and joined notification", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { inviteToken: "tok" });
    track(session);
    const { member, request } = await requester(hub, room, "tok");

    await session.sync();

    expect(hub.messages).toHaveLength(1);
    expect(hub.ops.storeWelcome).toHaveBeenCalledWith(member.pubkey, request.kp_ref, expect.any(String), 1);
    expect(hub.ops.fetchJoinRequests).toHaveBeenCalledWith(room.id, [{ pk: member.pubkey, at: request.at }]);
    expect(hub.joinRequests).toEqual([]);
    expect(room.pendingWelcomes).toEqual([]);
    expect(session.pendingJoinRequests).toEqual([]);
    expect(room.lastCursor).toBe(1);
    expect(notifications).toEqual([{ category: "join_request", key: `${room.id}:${request.kp_ref}`, room: "Room", action: "joined" }]);
  });

  it("completes the whole join: waiting guest receives the Welcome and can talk", async () => {
    const hub = new FakeCoordinator();
    const { session, room, host } = await hostedRoom(hub, { host: undefined });
    track(session);
    await session.sync();
    const { member } = await requester(hub, room);
    const guestRoom = waitingGuestRoom(room.id, member, { host: { name: "Host", pubkey: host.pubkey } });
    const guest = track(new ChatRoomSession(guestRoom, member.signer, hub.factory));

    await guest.sync();
    expect(guest.status.detail).toBe("Waiting for the host to admit you");
    expect(guestRoom.joinRequestSent).toBe(true);

    await session.sync();
    await guest.sync();

    expect(guestRoom.joinRequestSent).toBe(false);
    expect(guest.status).toEqual({ connection: "connected", detail: undefined });
    expect(guestRoom.host).toEqual({ name: "Host", pubkey: host.pubkey });
    expect(hub.welcomes).toEqual([]);
    expect(stored(guestRoom)?.joinRequestSent).toBe(false);

    await guest.send("thanks for the invite");
    await session.sync();
    expect(room.messages.map((message) => message.content)).toEqual(["thanks for the invite"]);
    expect(roomUnreadCount(room)).toBe(1);
  });

  it("holds requests for approval, notifies once per request, then admits on approval", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false });
    track(session);
    const { request } = await requester(hub, room);

    await session.sync();
    await session.sync();

    expect(session.pendingJoinRequests).toEqual([request]);
    expect(hub.ops.storeWelcome).not.toHaveBeenCalled();
    expect(notifications).toEqual([{ category: "join_request", key: `${room.id}:${request.kp_ref}`, room: "Room", action: "waiting" }]);

    await session.approveJoinRequests();

    expect(hub.ops.storeWelcome).toHaveBeenCalledOnce();
    expect(session.pendingJoinRequests).toEqual([]);
    expect(notifications.at(-1)).toMatchObject({ action: "joined" });
  });

  it("approval fetches current requests when none are known locally", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false, inviteToken: "current" });
    track(session);
    await requester(hub, room, "stale-token");
    const { request } = await requester(hub, room, "current", 60);

    await session.approveJoinRequests();

    expect(hub.ops.storeWelcome).toHaveBeenCalledOnce();
    expect(hub.ops.storeWelcome.mock.calls[0]?.[1]).toBe(request.kp_ref);
  });

  it("does not admit a held request whose invite was revoked before approval", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false, inviteToken: "original" });
    track(session);
    await requester(hub, room, "original");
    await session.sync();
    expect(session.pendingJoinRequests).toHaveLength(1);

    rotateRoomInvite(session.room);
    await session.approveJoinRequests();

    expect(hub.ops.storeWelcome).not.toHaveBeenCalled();
    expect(session.pendingJoinRequests).toEqual([]);
  });

  it("still admits a tokenless canonical request after an invite rotation", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false, inviteToken: "original" });
    track(session);
    await requester(hub, room);
    await session.sync();

    rotateRoomInvite(session.room);
    await session.approveJoinRequests();

    expect(hub.ops.storeWelcome).toHaveBeenCalledOnce();
  });

  it("turning auto-approve on persists it and admits whoever is waiting", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false });
    track(session);
    await requester(hub, room);
    await session.sync();

    await session.setAutoApprove(true);

    expect(stored(room)?.autoApprove).toBe(true);
    expect(hub.ops.storeWelcome).toHaveBeenCalledOnce();
  });

  it("ignores a request carrying a stale invite token", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { inviteToken: "current" });
    track(session);
    await requester(hub, room, "old");

    await session.sync();

    expect(hub.ops.consumeKeyPackage).not.toHaveBeenCalled();
    expect(session.pendingJoinRequests).toEqual([]);
  });

  it("collapses a replayed request to its latest copy", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false });
    track(session);
    const { request } = await requester(hub, room, undefined, 10);
    const newer = { ...request, at: 20 };
    const older = { ...request, at: 5 };
    hub.joinRequests.push(newer, older);

    await session.sync();

    expect(session.pendingJoinRequests).toEqual([newer]);
  });

  it("falls back to the requester identity when the exact key package is gone", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { member, request } = await requester(hub, room);
    const rotated = await createKeyPackage(member.pubkey, { lastResort: true });
    hub.packages = [{ pk: member.pubkey, kp_ref: rotated.stored.reference, event: publication(rotated.stored.publicBase64) }];

    await session.sync();

    expect(hub.ops.consumeKeyPackage).toHaveBeenNthCalledWith(1, request.kp_ref);
    expect(hub.ops.consumeKeyPackage).toHaveBeenNthCalledWith(2, member.pubkey);
    expect(hub.ops.storeWelcome).toHaveBeenCalledWith(member.pubkey, rotated.stored.reference, expect.any(String), 1);
  });

  it("keeps a request retryable while no key package is available", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { request } = await requester(hub, room);
    hub.packages = [];
    const state = room.stateBase64;

    await session.sync();

    expect(session.pendingJoinRequests).toEqual([request]);
    expect(room.stateBase64).toBe(state);
    expect(session.status.connection).toBe("connected");
  });

  it("accepts the legacy key-package argument name", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { member } = await requester(hub, room);
    hub.packages[0]!.event = { content: JSON.stringify({ params: { arguments: { keyPackageBase64: member.keys.stored.publicBase64 } } }) };

    await session.sync();

    const welcome = hub.welcomes[0]?.welcome_64 ?? "";
    expect(groupId(await joinWelcome(welcome, member.keys.stored))).toBe(room.id);
  });

  it.each<[string, unknown]>([
    ["an event with no content", {}],
    ["content with no key package", { content: JSON.stringify({ params: { arguments: {} } }) }],
  ])("skips %s without taking the room offline or retrying", async (_scenario, event) => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { member } = await requester(hub, room);
    hub.packages[0]!.event = event;
    const state = room.stateBase64;

    await session.sync();

    expect(room.stateBase64).toBe(state);
    expect(session.pendingJoinRequests).toEqual([]);
    expect(session.status.connection).toBe("connected");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no published key package"), member.pubkey);
  });

  it.each<[string, unknown]>([
    ["malformed publication JSON", { content: "{nope" }],
    ["a corrupt key package", publication("bm90LWEta2V5LXBhY2thZ2U=")],
    ["a null publication", null],
  ])("keeps a request retryable and the room online on %s", async (_scenario, event) => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { request } = await requester(hub, room);
    hub.packages[0]!.event = event;
    const state = room.stateBase64;

    await session.sync();

    expect(room.stateBase64).toBe(state);
    expect(session.pendingJoinRequests).toEqual([request]);
    expect(session.status.connection).toBe("connected");
  });

  it("does not advance the epoch when the commit cannot be posted", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { request } = await requester(hub, room);
    hub.ops.postGroupMessage.mockRejectedValueOnce(new Error("post failed"));
    const state = room.stateBase64;

    await session.sync();

    expect(room.stateBase64).toBe(state);
    expect(room.pendingWelcomes ?? []).toEqual([]);
    expect(session.pendingJoinRequests).toEqual([request]);

    await session.sync();
    expect(room.stateBase64).not.toBe(state);
    expect(hub.ops.storeWelcome).toHaveBeenCalledOnce();
  });

  it("defers admission when delivered messages cannot be read first", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { request } = await requester(hub, room);
    hub.ops.fetchMessages.mockRejectedValueOnce(new Error("pull failed"));

    await session.approveJoinRequests();

    expect(hub.ops.consumeKeyPackage).toHaveBeenCalledOnce();
    expect(session.status.connection).toBe("connected");
    expect(hub.joinRequests).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("before admission"), expect.any(Error));
    expect(request.kp_ref).toBeTruthy();
  });

  it("does not commit while pre-admission reading fails, and reports the request as retryable", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { request } = await requester(hub, room);
    hub.ops.fetchMessages.mockRejectedValue(new Error("pull failed"));
    const state = room.stateBase64;

    await session.sync();

    expect(room.stateBase64).toBe(state);
    expect(hub.ops.consumeKeyPackage).not.toHaveBeenCalled();
    expect(session.pendingJoinRequests).toEqual([request]);
    expect(session.status.connection).toBe("offline");
  });

  it("keeps an undelivered Welcome durable, does not re-admit, and delivers it next sync", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { member, request } = await requester(hub, room);
    hub.ops.storeWelcome.mockRejectedValueOnce(new Error("welcome_store failed"));

    await session.sync();

    expect(session.status.connection).toBe("connected");
    expect(hub.messages).toHaveLength(1);
    expect(stored(room)?.pendingWelcomes).toEqual([expect.objectContaining({ requestPk: member.pubkey, requestAt: request.at, after: 1 })]);
    expect(notifications.filter((notification) => notification.category === "join_request")).toEqual([]);

    // A fresh session (page reload) resumes the outbox instead of committing twice.
    const reloaded = track(new ChatRoomSession(stored(room)!, session["signer"], hub.factory));
    await reloaded.sync();

    expect(hub.messages).toHaveLength(1);
    expect(reloaded.room.pendingWelcomes).toEqual([]);
    expect(hub.joinRequests).toEqual([]);
    expect(notifications).toEqual([expect.objectContaining({ category: "join_request", action: "joined" })]);
    expect(groupId(await joinWelcome(hub.welcomes[0]!.welcome_64, member.keys.stored))).toBe(room.id);
  });

  it("does not commit the same request twice while its Welcome keeps failing", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    await requester(hub, room);
    hub.ops.storeWelcome.mockRejectedValue(new Error("welcome_store failed"));
    await session.sync();
    const state = room.stateBase64;

    await session.sync();

    expect(hub.messages).toHaveLength(1);
    expect(room.stateBase64).toBe(state);
    expect(room.pendingWelcomes).toHaveLength(1);
    expect(hub.ops.consumeKeyPackage).toHaveBeenCalledOnce();
    expect(session.pendingJoinRequests).toEqual([]);
  });

  it("does not report an outage when only the acknowledgement fails after delivery", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const { member } = await requester(hub, room);
    const original = hub.ops.fetchJoinRequests.getMockImplementation()!;
    hub.ops.fetchJoinRequests.mockImplementation(async (id, consumed) => {
      if (consumed) throw new Error("ack failed");
      return original(id, consumed);
    });

    await session.sync();

    expect(session.status.connection).toBe("connected");
    expect(hub.ops.storeWelcome).toHaveBeenCalledWith(member.pubkey, expect.any(String), expect.any(String), 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("acknowledge"), expect.any(Error));
  });

  it("works without an unset Welcome outbox on rooms written before it existed", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    delete room.pendingWelcomes;
    await requester(hub, room);
    await session.sync();

    expect(room.pendingWelcomes).toEqual([]);
  });

  it("works without a notification sink when guests wait or join", async () => {
    restoreEnvironment();
    restoreEnvironment = configureRoomEnvironment({ storage, events });
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false });
    track(session);
    await requester(hub, room);

    await session.sync();
    await session.approveJoinRequests();

    expect(hub.ops.storeWelcome).toHaveBeenCalledOnce();
  });
});

describe("guest admission", () => {
  async function admittedWelcome(hub: FakeCoordinator) {
    const { session, room, host } = await hostedRoom(hub);
    track(session);
    const { member } = await requester(hub, room);
    await session.sync();
    return { room, host, member, hostSession: session };
  }

  it("skips Welcomes for other key packages and leaves them queued", async () => {
    const hub = new FakeCoordinator();
    const member = await newMember({ lastResort: true });
    hub.welcomes.push({ kp_ref: "someone-else", welcome_64: "x", at: 1 });
    const room = waitingGuestRoom("group", member);
    const session = track(new ChatRoomSession(room, member.signer, hub.factory));

    await session.sync();

    expect(room.joinRequestSent).toBe(true);
    expect(hub.welcomes).toHaveLength(1);
  });

  it("survives an undecodable Welcome and still accepts a later matching one", async () => {
    const hub = new FakeCoordinator();
    const { member, room } = await admittedWelcome(hub);
    hub.welcomes.unshift({ kp_ref: member.keys.stored.reference, welcome_64: "bm90LWEtd2VsY29tZQ==", at: 1 });
    const guestRoom = waitingGuestRoom(room.id, member);
    const guest = track(new ChatRoomSession(guestRoom, member.signer, hub.factory));

    await guest.sync();

    expect(guestRoom.joinRequestSent).toBe(false);
    expect(guestRoom.stateBase64).not.toBe("");
    expect(hub.welcomes.map((welcome) => welcome.at)).toEqual([1]);
  });

  it("defaults the join cursor to zero when the Welcome omits one", async () => {
    const hub = new FakeCoordinator();
    const { member, room } = await admittedWelcome(hub);
    delete hub.welcomes[0]!.after;
    const guestRoom = waitingGuestRoom(room.id, member);
    const guest = track(new ChatRoomSession(guestRoom, member.signer, hub.factory));

    await guest.sync();

    expect(guestRoom.joinRequestSent).toBe(false);
    // The commit at cursor 1 cannot be decrypted by a member who joined through it; it is skipped.
    expect(guestRoom.lastCursor).toBe(1);
  });

  it("repairs a one-time package from a sibling room's reusable package", async () => {
    const hub = new FakeCoordinator();
    const member = await newMember();
    const reusable: LocalKeyPackage = { reference: "reusable", publicBase64: "pub", privateBase64: "priv", lastResort: true };
    saveRoom(waitingGuestRoom("sibling", member, { keyPackage: reusable }));
    saveRoom(waitingGuestRoom("other-coordinator", member, { coordinatorPubkey: COORDINATOR, keyPackage: { ...reusable, reference: "wrong-coordinator" } }));
    saveRoom(waitingGuestRoom("other-identity", member, { stablePubkey: "9".repeat(64), keyPackage: { ...reusable, reference: "wrong-identity" } }));
    const room = waitingGuestRoom("legacy", member, { inviteToken: "tok" });
    const session = track(new ChatRoomSession(room, member.signer, hub.factory));

    await session.sync();

    expect(room.keyPackage).toEqual(reusable);
    expect(hub.ops.publishKeyPackage).toHaveBeenCalledWith("reusable", "pub");
    expect(hub.ops.storeJoinRequest).toHaveBeenCalledWith("legacy", "reusable", "tok");
    expect(stored(room)?.keyPackage).toEqual(reusable);
  });

  it("keeps the old package when repair fails so it can retry safely", async () => {
    const hub = new FakeCoordinator();
    const member = await newMember();
    const room = waitingGuestRoom("legacy", member);
    const original = room.keyPackage;
    hub.ops.storeJoinRequest.mockRejectedValueOnce(new Error("relay refused"));
    const session = track(new ChatRoomSession(room, member.signer, hub.factory));

    await session.sync();

    expect(room.keyPackage).toEqual(original);
    expect(session.status).toEqual({ connection: "offline", detail: "relay refused" });

    await session.sync();
    expect(room.keyPackage.lastResort).toBe(true);
    expect(room.keyPackage.reference).not.toBe(original.reference);
  });

  it("does not attempt repair for a package that is already reusable", async () => {
    const hub = new FakeCoordinator();
    const member = await newMember({ lastResort: true });
    const session = track(new ChatRoomSession(waitingGuestRoom("group", member), member.signer, hub.factory));

    await session.sync();

    expect(hub.ops.publishKeyPackage).not.toHaveBeenCalled();
  });
});

describe("recovery", () => {
  it("rejects immediately for an already aborted signal, without a client", async () => {
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    const controller = new AbortController();
    controller.abort();

    await expect(session.recover(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(hub.factory).not.toHaveBeenCalled();
  });

  it("connects, persists and announces once across repeat recoveries", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    const online = collect(SERVER_ONLINE_EVENT);

    await session.recover(new AbortController().signal);
    await session.recover(new AbortController().signal);

    expect(session.status).toEqual({ connection: "connected" });
    expect(online).toEqual([{ coordinatorPubkey: COORDINATOR, roomId: room.id }]);
    expect(stored(room)).not.toBeNull();
  });

  it("wraps a failure for the owning coordinator, keeps connecting, and frees the client", async () => {
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    track(session);
    const cause = new Error("relay timeout");
    hub.ops.fetchJoinRequests.mockRejectedValueOnce(cause);
    const offline = collect(SERVER_OFFLINE_EVENT);

    await expect(session.recover(new AbortController().signal)).rejects.toMatchObject({ message: "Hosted room recovery failed", cause });

    expect(session.status).toEqual({ connection: "connecting" });
    expect(offline).toEqual([]);
    expect(hub.ops.close).toHaveBeenCalledOnce();

    await session.recover(new AbortController().signal);
    expect(hub.factory).toHaveBeenCalledTimes(2);
    expect(session.status.connection).toBe("connected");
  });

  it("holds requests when auto-approve is off and notifies once", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub, { autoApprove: false });
    track(session);
    const { request } = await requester(hub, room);

    await session.recover(new AbortController().signal);
    await session.recover(new AbortController().signal);

    expect(session.pendingJoinRequests).toEqual([request]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ action: "waiting" });
    expect(hub.ops.storeWelcome).not.toHaveBeenCalled();
  });

  it("flushes outstanding Welcomes and admits new requests during recovery", async () => {
    const hub = new FakeCoordinator();
    const { session, room } = await hostedRoom(hub);
    track(session);
    await requester(hub, room);
    hub.ops.storeWelcome.mockRejectedValueOnce(new Error("welcome_store failed"));
    await session.sync();
    expect(room.pendingWelcomes).toHaveLength(1);

    await session.recover(new AbortController().signal);

    expect(room.pendingWelcomes).toEqual([]);
    expect(notifications).toEqual([expect.objectContaining({ action: "joined" })]);
  });

  it("reports the waiting state for a guest that has not been admitted", async () => {
    const hub = new FakeCoordinator();
    const member = await newMember({ lastResort: true });
    const room = waitingGuestRoom("group", member);
    const session = track(new ChatRoomSession(room, member.signer, hub.factory));
    const updates = vi.fn();
    session.subscribe(updates);

    await session.recover(new AbortController().signal);

    expect(session.status).toEqual({ connection: "connected", detail: "Waiting for the host to admit you" });
    expect(stored(room)?.joinRequestSent).toBe(true);
    expect(updates).toHaveBeenCalledOnce();
    expect(hub.ops.fetchMessages).not.toHaveBeenCalled();
  });

  it("does not strand a guest whose Welcome was consumed before the pull failed", async () => {
    const hub = new FakeCoordinator();
    const { session: hostSession, room } = await hostedRoom(hub);
    track(hostSession);
    const { member } = await requester(hub, room);
    await hostSession.sync();
    const guestRoom = waitingGuestRoom(room.id, member);
    const guest = track(new ChatRoomSession(guestRoom, member.signer, hub.factory));
    hub.ops.fetchMessages.mockRejectedValueOnce(new Error("pull failed"));

    await expect(guest.recover(new AbortController().signal)).rejects.toThrow("Hosted room recovery failed");

    expect(hub.welcomes).toEqual([]);
    expect(stored(guestRoom)?.joinRequestSent).toBe(false);
    expect(stored(guestRoom)?.stateBase64).not.toBe("");
  });

  it("does not repost a message that was delivered before the pull failed", async () => {
    const hub = new FakeCoordinator();
    const { hostSession } = await twoMembers(hub);
    track(hostSession);
    await hostSession.start();
    hub.ops.postGroupMessage.mockRejectedValueOnce(new Error("post failed"));
    await hostSession.send("queued");
    expect(stored(hostSession.room)?.pending).toHaveLength(1);
    // The read before posting succeeds; the read after posting fails.
    hub.ops.fetchMessages.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("pull failed"));

    await expect(hostSession.recover(new AbortController().signal)).rejects.toThrow("Hosted room recovery failed");

    expect(hub.messages).toHaveLength(1);
    expect(stored(hostSession.room)?.pending).toEqual([]);
  });

  it("keeps a queued message unposted when the read before posting fails", async () => {
    const hub = new FakeCoordinator();
    const { hostSession } = await twoMembers(hub);
    track(hostSession);
    await hostSession.start();
    hub.ops.postGroupMessage.mockRejectedValueOnce(new Error("post failed"));
    await hostSession.send("queued");
    hub.ops.fetchMessages.mockRejectedValueOnce(new Error("pull failed"));

    await hostSession.sync();

    expect(hub.messages).toHaveLength(0);
    expect(stored(hostSession.room)?.pending).toHaveLength(1);
    expect(hostSession.status.connection).toBe("offline");
  });

  it("posts a record from an older version unchanged, with no epoch to compare", async () => {
    const hub = new FakeCoordinator();
    const { hostSession } = await twoMembers(hub, { pending: [{ id: "legacy", opaqueBase64: "b3BhcXVl" }] });
    track(hostSession);

    await hostSession.start();

    expect(hub.messages.map((message) => message.msg_64)).toContain("b3BhcXVl");
    expect(stored(hostSession.room)?.pending).toEqual([]);
  });

  it("reseals only entries that carry an envelope", async () => {
    const hub = new FakeCoordinator();
    const { hostSession } = await twoMembers(hub, {
      pending: [
        { id: "old-format", opaqueBase64: "b2xk", epoch: "999" },
        { id: "current", opaqueBase64: "Y3VycmVudA", epoch: "1" },
      ],
    });
    track(hostSession);
    hostSession.room.pending[1]!.epoch = stateEpoch(decodeState(hostSession.room.stateBase64));

    await hostSession.start();

    expect(hub.messages.map((message) => message.msg_64)).toEqual(expect.arrayContaining(["b2xk", "Y3VycmVudA"]));
  });

  describe("cancellation", () => {
    async function expectAborted(session: ChatRoomSession, controller: AbortController) {
      await expect(session.recover(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(session.status).not.toEqual({ connection: "connected" });
    }

    it("while reading join requests", async () => {
      const hub = new FakeCoordinator();
      const { session } = await hostedRoom(hub);
      const controller = new AbortController();
      hub.ops.fetchJoinRequests.mockImplementationOnce(async () => { controller.abort(); return []; });

      await expectAborted(session, controller);
      expect(hub.ops.fetchMessages).not.toHaveBeenCalled();
      expect(hub.ops.close).toHaveBeenCalledOnce();
    });

    it("after an admission, keeping the admission itself durable", async () => {
      const hub = new FakeCoordinator();
      const { session, room } = await hostedRoom(hub);
      await requester(hub, room);
      const controller = new AbortController();
      hub.ops.storeWelcome.mockImplementationOnce(async () => { controller.abort(); });

      await expectAborted(session, controller);

      expect(stored(room)?.stateBase64).toBe(room.stateBase64);
      expect(session.pendingJoinRequests).toEqual([]);
      expect(hub.ops.fetchMessages.mock.calls.length).toBe(1);
    });

    it("while a guest reads Welcomes", async () => {
      const hub = new FakeCoordinator();
      const member = await newMember({ lastResort: true });
      const session = new ChatRoomSession(waitingGuestRoom("group", member), member.signer, hub.factory);
      const controller = new AbortController();
      hub.ops.fetchWelcomes.mockImplementationOnce(async () => { controller.abort(); return []; });

      await expectAborted(session, controller);
      expect(session.room.joinRequestSent).toBe(true);
    });

    it("while flushing queued messages", async () => {
      const hub = new FakeCoordinator();
      const { hostSession } = await twoMembers(hub, { pending: [{ id: "queued", opaqueBase64: "b3BhcXVl" }] });
      const controller = new AbortController();
      hub.ops.postGroupMessage.mockImplementationOnce(async (gid) => { controller.abort(); return { cursor: 1, gid, at: 1 }; });

      await expectAborted(hostSession, controller);
      // Only the read before posting ran; nothing continued after the abort.
      expect(hub.ops.fetchMessages).toHaveBeenCalledOnce();
    });

    it("while a guest posts queued messages", async () => {
      const hub = new FakeCoordinator();
      const { guestSession } = await twoMembers(hub, {}, { pending: [{ id: "queued", opaqueBase64: "b3BhcXVl" }] });
      const controller = new AbortController();
      hub.ops.postGroupMessage.mockImplementationOnce(async (gid) => { controller.abort(); return { cursor: 1, gid, at: 1 }; });

      await expectAborted(guestSession, controller);
      expect(hub.ops.fetchMessages).toHaveBeenCalledOnce();
    });

    it("while reading before posting queued messages", async () => {
      const hub = new FakeCoordinator();
      const { hostSession } = await twoMembers(hub, { pending: [{ id: "queued", opaqueBase64: "b3BhcXVl" }] });
      const controller = new AbortController();
      hub.ops.fetchMessages.mockImplementationOnce(async () => { controller.abort(); return []; });

      await expectAborted(hostSession, controller);
      expect(hub.ops.fetchJoinRequests).not.toHaveBeenCalled();
    });

    it("while still queued behind another operation", async () => {
      const hub = new FakeCoordinator();
      const { session } = await hostedRoom(hub);
      const gate = deferred<RemoteGroupMessage[]>();
      hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
      const syncing = session.sync();
      await vi.waitFor(() => expect(hub.ops.fetchMessages).toHaveBeenCalledOnce());
      const controller = new AbortController();

      const recovering = session.recover(controller.signal);
      controller.abort();
      gate.resolve([]);

      await expect(recovering).rejects.toMatchObject({ name: "AbortError" });
      await syncing;
      expect(hub.ops.fetchMessages).toHaveBeenCalledOnce();
    });

    it("treats an abort after stop() as already handled", async () => {
      const hub = new FakeCoordinator();
      const { session } = await hostedRoom(hub);
      const gate = deferred<RemoteGroupMessage[]>();
      hub.ops.fetchMessages.mockImplementationOnce(() => gate.promise);
      const controller = new AbortController();

      const recovering = session.recover(controller.signal);
      await vi.waitFor(() => expect(hub.ops.fetchMessages).toHaveBeenCalledOnce());
      session.stop();
      controller.abort();
      gate.resolve([]);

      await expect(recovering).rejects.toMatchObject({ name: "AbortError" });
      expect(hub.ops.close).toHaveBeenCalledOnce();
    });

    it("no longer reacts to the signal once recovery has finished", async () => {
      const hub = new FakeCoordinator();
      const { session } = await hostedRoom(hub);
      track(session);
      const controller = new AbortController();

      await session.recover(controller.signal);
      controller.abort();

      expect(hub.ops.close).not.toHaveBeenCalled();
      expect(session.status.connection).toBe("connected");
    });
  });
});

describe("environment fallbacks", () => {
  it("uses the room environment's event target for connectivity even after reconfiguration", async () => {
    const hub = new FakeCoordinator();
    const { session } = await hostedRoom(hub);
    await session.start();
    const original = events;

    const restore = configureRoomEnvironment({ events: new EventTarget() });
    session.stop();
    restore();

    original.dispatchEvent(new Event("offline"));
    expect(session.status.connection).toBe("connected");
  });

  it("persists rooms through a replaced storage", async () => {
    const replacement = createMemoryRoomStorage();
    const restore = configureRoomEnvironment({ storage: replacement });
    try {
      const hub = new FakeCoordinator();
      const { session, room } = await hostedRoom(hub);
      await session.sync();
      session.stop();
      expect(loadRoom(room.id, room.coordinatorPubkey)).not.toBeNull();
      expect(replacement.length).toBe(1);
    } finally {
      restore();
    }
    expect(storage.length).toBe(0);
  });
});
