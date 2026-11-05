import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";

import { ChatCoordinatorClient } from "../src/client/coordinator-client.js";
import { addMember, createKeyPackage, createRoomState, encodeState, groupCreatorPubkey, decodeState, joinWelcome, signChatEnvelope } from "../src/client/protocol.js";
import {
  configureRoomEnvironment,
  createMemoryRoomStorage,
  type RoomStorage,
} from "../src/client/room-environment.js";
import {
  anonymousMembershipImpact,
  coordinatorUnreadTotal,
  createHostedRoom,
  createJoiningRoom,
  forgetRememberedHostRoom,
  hostIdentityForRoom,
  isCurrentInviteRequest,
  listRooms,
  loadLastOpenRoom,
  loadRememberedHostRoom,
  loadRoom,
  markRoomRead,
  reactionSummary,
  reconcileRoomHostIdentity,
  rememberActiveHostRoom,
  rememberLastOpenRoom,
  removeHostedRoomsForCoordinator,
  removeStoredRoom,
  requireRoomSigner,
  retireAnonymousMemberships,
  roomIdentityKey,
  ROOM_UNREAD_CHANGED_EVENT,
  ROOMS_CHANGED_EVENT,
  rotateRoomInvite,
  saveRoom,
  signerForStoredRoom,
  type StoredReaction,
  type StoredRoom,
} from "../src/client/room-store.js";
import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";

const COORDINATOR = "c".repeat(64);
const OTHER_COORDINATOR = "d".repeat(64);
const MEMBER = "a".repeat(64);
const REMOTE = "b".repeat(64);

function makeRoom(overrides: Partial<StoredRoom> = {}): StoredRoom {
  return {
    version: 1,
    id: "room-1",
    title: "Room",
    coordinatorPubkey: COORDINATOR,
    relayUrls: ["wss://relay.example"],
    name: "Member",
    stablePubkey: MEMBER,
    isHost: false,
    stateBase64: "",
    keyPackage: { reference: "ref", publicBase64: "pub", privateBase64: "priv" },
    lastCursor: 0,
    messages: [],
    pending: [],
    ...overrides,
  };
}

const legacyKey = (id: string) => `cordn-adhoc-chat-room:${id}`;
const currentKey = (room: Pick<StoredRoom, "id" | "coordinatorPubkey">) =>
  `cordn-adhoc-chat-room:v2:${encodeURIComponent(room.coordinatorPubkey)}:${encodeURIComponent(room.id)}`;
const lastOpenKey = (coordinator: string) => `cordn-adhoc-active-host-room:${coordinator}`;

/** A storage whose faults are switched per test. */
function faultyStorage(faults: {
  setItem?: (key: string, value: string) => "throw" | "drop" | "tamper" | "ok";
  getItem?: (key: string) => "throw" | "null" | "ok";
  removeItem?: (key: string) => "throw" | "ok";
  key?: () => "throw" | "null" | "ok";
}, inner: RoomStorage = createMemoryRoomStorage()): RoomStorage {
  return {
    get length() { return inner.length; },
    key(index) {
      const fault = faults.key?.();
      if (fault === "throw") throw new Error("storage denied");
      if (fault === "null") return null;
      return inner.key(index);
    },
    getItem(key) {
      const fault = faults.getItem?.(key);
      if (fault === "throw") throw new Error("storage denied");
      if (fault === "null") return null;
      return inner.getItem(key);
    },
    setItem(key, value) {
      const fault = faults.setItem?.(key, value);
      if (fault === "throw") throw new DOMException("Storage full", "QuotaExceededError");
      if (fault === "drop") return;
      inner.setItem(key, fault === "tamper" ? `${value} ` : value);
    },
    removeItem(key) {
      if (faults.removeItem?.(key) === "throw") throw new Error("storage denied");
      inner.removeItem(key);
    },
  };
}

let storage: RoomStorage;
let events: EventTarget;
let restoreEnvironment: () => void;

function useStorage(next: RoomStorage): void {
  storage = next;
  restoreEnvironment();
  restoreEnvironment = configureRoomEnvironment({ storage, events, origin: () => "https://origin.example" });
}

function collect(type: string): { detail: unknown }[] {
  const seen: { detail: unknown }[] = [];
  events.addEventListener(type, (event) => seen.push({ detail: (event as CustomEvent).detail }));
  return seen;
}

beforeEach(() => {
  storage = createMemoryRoomStorage();
  events = new EventTarget();
  restoreEnvironment = configureRoomEnvironment({ storage, events, origin: () => "https://origin.example" });
});

afterEach(() => {
  restoreEnvironment();
  vi.restoreAllMocks();
});

describe("createHostedRoom", () => {
  it("creates and persists a hosted room with a real MLS state and identity defaults", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());
    const changed = collect(ROOMS_CHANGED_EVENT);

    const room = await createHostedRoom({ title: "   ", coordinatorPubkey: COORDINATOR, relayUrls: ["wss://r"], signer, identityOwner: "anonymous" });

    const pubkey = await signer.getPublicKey();
    expect(room).toMatchObject({
      title: "Untitled chat",
      name: "Host",
      badgeLabel: "host",
      stablePubkey: pubkey,
      identityOwner: "anonymous",
      isHost: true,
      autoApprove: true,
      coordinatorOrigin: "https://origin.example",
      host: { name: "Host", pubkey },
    });
    expect(room.coordinatorName).toBeUndefined();
    expect(room.inviteToken).toMatch(/^[0-9a-f]{36}$/);
    expect(groupCreatorPubkey(decodeState(room.stateBase64))).toBe(pubkey);
    expect(loadRoom(room.id, COORDINATOR)?.inviteToken).toBe(room.inviteToken);
    expect(changed).toEqual([{ detail: { roomId: room.id, coordinatorPubkey: COORDINATOR } }]);
  });

  it("honors explicit presentation, approval and coordinator metadata", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());

    const room = await createHostedRoom({
      title: " Team ",
      coordinatorPubkey: COORDINATOR,
      relayUrls: [],
      signer,
      identityOwner: "external",
      coordinatorOrigin: "https://coord.example",
      coordinatorName: "  Coordinator  ",
      autoApprove: false,
      coordinatorKeyMode: "persistent",
      identity: { name: " Ada ", avatar: " https://images.example/a.png ", badgeLabel: " owner ", badgeEmoji: "⭐" },
    });

    expect(room).toMatchObject({
      title: "Team",
      name: "Ada",
      avatar: "https://images.example/a.png",
      badgeLabel: "owner",
      badgeEmoji: "⭐",
      coordinatorOrigin: "https://coord.example",
      coordinatorName: "Coordinator",
      autoApprove: false,
      coordinatorKeyMode: "persistent",
    });
    expect(room.host).toMatchObject({ name: "Ada", avatar: "https://images.example/a.png" });
  });

  it("blanks whitespace-only presentation back to the defaults", async () => {
    const room = await createHostedRoom({
      title: "T",
      coordinatorPubkey: COORDINATOR,
      relayUrls: [],
      signer: new BrowserNostrSigner(generateSecretKey()),
      identityOwner: "anonymous",
      coordinatorName: "   ",
      identity: { name: "   ", avatar: "   ", badgeLabel: "   " },
    });

    expect(room.name).toBe("Host");
    expect(room.avatar).toBeUndefined();
    expect(room.badgeLabel).toBe("host");
    expect(room.coordinatorName).toBeUndefined();
  });
});

describe("createJoiningRoom", () => {
  const invite = { groupId: "group-1", coordinatorPubkey: COORDINATOR, relayUrls: ["wss://r"], title: "Invited", inviteToken: "tok" };

  function stubClient(overrides: { publish?: () => Promise<void>; request?: () => Promise<void> } = {}) {
    return {
      publish: vi.spyOn(ChatCoordinatorClient.prototype, "publishKeyPackage").mockImplementation(overrides.publish ?? (async () => undefined)),
      request: vi.spyOn(ChatCoordinatorClient.prototype, "storeJoinRequest").mockImplementation(overrides.request ?? (async () => undefined)),
      close: vi.spyOn(ChatCoordinatorClient.prototype, "close").mockResolvedValue(undefined),
    };
  }

  it("publishes a reusable key package, requests admission and persists the waiting room", async () => {
    const client = stubClient();
    const signer = new BrowserNostrSigner(generateSecretKey());

    const room = await createJoiningRoom({ invite, name: "  Bob ", signer, identityOwner: "anonymous", avatar: "https://images.example/b.png" });

    expect(room).toMatchObject({
      id: "group-1",
      title: "Invited",
      name: "Bob",
      avatar: "https://images.example/b.png",
      isHost: false,
      joinRequestSent: true,
      inviteToken: "tok",
      stateBase64: "",
      coordinatorOrigin: "https://origin.example",
    });
    expect(room.keyPackage.lastResort).toBe(true);
    expect(client.publish).toHaveBeenCalledWith(room.keyPackage.reference, room.keyPackage.publicBase64);
    expect(client.request).toHaveBeenCalledWith("group-1", room.keyPackage.reference, "tok");
    expect(client.close).toHaveBeenCalledOnce();
    expect(loadRoom("group-1", COORDINATOR)?.joinRequestSent).toBe(true);
  });

  it("falls back to generic title and name and keeps invite-supplied origin", async () => {
    stubClient();
    const room = await createJoiningRoom({
      invite: { ...invite, title: "", coordinatorOrigin: "https://coord.example", coordinatorName: "Coord" },
      name: "  ",
      signer: new BrowserNostrSigner(generateSecretKey()),
      identityOwner: "anonymous",
    });

    expect(room).toMatchObject({ title: "Chat", name: "Anonymous", coordinatorOrigin: "https://coord.example", coordinatorName: "Coord" });
  });

  it("reuses only a last-resort package owned by the same identity on the same coordinator", async () => {
    const client = stubClient();
    const signer = new BrowserNostrSigner(generateSecretKey());
    const pubkey = await signer.getPublicKey();
    const reusable = { reference: "shared-ref", publicBase64: "pub", privateBase64: "priv", lastResort: true };
    saveRoom(makeRoom({ id: "sibling", stablePubkey: pubkey, keyPackage: reusable }));
    saveRoom(makeRoom({ id: "other-coordinator", coordinatorPubkey: OTHER_COORDINATOR, stablePubkey: pubkey, keyPackage: { ...reusable, reference: "wrong-coordinator" } }));
    saveRoom(makeRoom({ id: "other-identity", stablePubkey: REMOTE, keyPackage: { ...reusable, reference: "wrong-identity" } }));
    saveRoom(makeRoom({ id: "one-time", stablePubkey: pubkey, keyPackage: { reference: "one-time", publicBase64: "p", privateBase64: "s" } }));

    const room = await createJoiningRoom({ invite, name: "Bob", signer, identityOwner: "external" });

    expect(room.keyPackage).toEqual(reusable);
    expect(client.publish).toHaveBeenCalledWith("shared-ref", "pub");
  });

  it("creates a fresh package when the only candidates belong to someone else", async () => {
    stubClient();
    const signer = new BrowserNostrSigner(generateSecretKey());
    saveRoom(makeRoom({ id: "other-identity", stablePubkey: REMOTE, keyPackage: { reference: "wrong", publicBase64: "p", privateBase64: "s", lastResort: true } }));

    const room = await createJoiningRoom({ invite, name: "Bob", signer, identityOwner: "external" });

    expect(room.keyPackage.reference).not.toBe("wrong");
  });

  it("stores nothing and still closes the client when the join request fails", async () => {
    const client = stubClient({ request: async () => { throw new Error("relay refused"); } });

    await expect(createJoiningRoom({ invite, name: "Bob", signer: new BrowserNostrSigner(generateSecretKey()), identityOwner: "anonymous" }))
      .rejects.toThrow("relay refused");

    expect(client.close).toHaveBeenCalledOnce();
    expect(loadRoom("group-1", COORDINATOR)).toBeNull();
  });
});

describe("room signers", () => {
  const secret = new Uint8Array(32).fill(7);
  const hex = bytesToHex(secret);

  it("requires the signer that owns the room and refuses retired rooms outright", async () => {
    const signer = new BrowserNostrSigner(secret);
    const pubkey = await signer.getPublicKey();

    await expect(requireRoomSigner({ stablePubkey: pubkey }, signer)).resolves.toBe(signer);
    await expect(requireRoomSigner({ stablePubkey: REMOTE }, signer)).rejects.toThrow("does not match");
    await expect(requireRoomSigner({ stablePubkey: pubkey, membershipStatus: "retired" }, signer)).rejects.toThrow("fresh invite");
  });

  it("builds a signer from a legacy room-local secret only when it proves room ownership", async () => {
    const pubkey = await new BrowserNostrSigner(secret).getPublicKey();

    const signer = await signerForStoredRoom(makeRoom({ stablePubkey: pubkey, anonymousSecretKey: hex }));
    expect(await signer?.getPublicKey()).toBe(pubkey);

    await expect(signerForStoredRoom(makeRoom({ stablePubkey: pubkey, anonymousSecretKey: hex.toUpperCase() }))).resolves.not.toBeNull();
    await expect(signerForStoredRoom(makeRoom({ stablePubkey: REMOTE, anonymousSecretKey: hex }))).resolves.toBeNull();
    await expect(signerForStoredRoom(makeRoom({ stablePubkey: pubkey, anonymousSecretKey: hex, membershipStatus: "retired" }))).resolves.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["too short", "ab"],
    ["not hex", "z".repeat(64)],
    ["outside the curve order", "0".repeat(64)],
  ])("returns no signer for a %s secret", async (_scenario, anonymousSecretKey) => {
    await expect(signerForStoredRoom(makeRoom({ anonymousSecretKey }))).resolves.toBeNull();
  });
});

describe("anonymous membership impact and retirement", () => {
  const secret = new Uint8Array(32).fill(9);

  async function anonymousIdentity() {
    return { pubkey: await new BrowserNostrSigner(secret).getPublicKey(), hex: bytesToHex(secret) };
  }

  it("counts composite identities once, matching provenance or a provable legacy secret", async () => {
    const { pubkey, hex } = await anonymousIdentity();
    saveRoom(makeRoom({ id: "owned", stablePubkey: pubkey, identityOwner: "anonymous" }));
    saveRoom(makeRoom({ id: "other-key", stablePubkey: REMOTE, identityOwner: "anonymous" }));
    saveRoom(makeRoom({ id: "external", stablePubkey: pubkey, identityOwner: "external" }));
    saveRoom(makeRoom({ id: "legacy-proved", stablePubkey: pubkey, anonymousSecretKey: hex }));
    saveRoom(makeRoom({ id: "legacy-other", stablePubkey: REMOTE, anonymousSecretKey: bytesToHex(new Uint8Array(32).fill(3)) }));
    saveRoom(makeRoom({ id: "legacy-no-secret", stablePubkey: pubkey }));
    saveRoom(makeRoom({ id: "legacy-invalid-curve", stablePubkey: pubkey, anonymousSecretKey: "0".repeat(64) }));
    // Same composite identity under a legacy alias must not be counted twice.
    storage.setItem(legacyKey("owned"), JSON.stringify(makeRoom({ id: "owned", stablePubkey: pubkey, identityOwner: "anonymous" })));

    expect(await anonymousMembershipImpact(pubkey)).toEqual({ count: 2 });
  });

  it("treats every non-external room as affected when no public key can be proved", async () => {
    saveRoom(makeRoom({ id: "pre-provenance" }));
    saveRoom(makeRoom({ id: "anonymous", identityOwner: "anonymous" }));
    saveRoom(makeRoom({ id: "external", identityOwner: "external" }));

    expect(await anonymousMembershipImpact(undefined as unknown as string)).toEqual({ count: 2 });
    const journal = await retireAnonymousMemberships();
    journal.commit();

    expect(journal.count).toBe(2);
    expect(loadRoom("pre-provenance", COORDINATOR)?.membershipStatus).toBe("retired");
    expect(loadRoom("anonymous", COORDINATOR)?.membershipStatus).toBe("retired");
    expect(loadRoom("external", COORDINATOR)?.membershipStatus).toBeUndefined();
  });

  it("does not count or rewrite memberships that are already retired", async () => {
    saveRoom(makeRoom({ id: "already", identityOwner: "anonymous", membershipStatus: "retired", updatedAt: 5 }));
    const before = storage.getItem(currentKey(makeRoom({ id: "already" })));
    const changed = collect(ROOMS_CHANGED_EVENT);

    expect(await anonymousMembershipImpact(undefined as unknown as string)).toEqual({ count: 0 });
    const journal = await retireAnonymousMemberships();

    expect(journal.count).toBe(0);
    expect(storage.getItem(currentKey(makeRoom({ id: "already" })))).toBe(before);
    expect(changed).toEqual([]);
  });

  it("strips every piece of authority, including undelivered Welcomes, while keeping display cache", async () => {
    const { pubkey, hex } = await anonymousIdentity();
    const room = makeRoom({
      stablePubkey: pubkey,
      identityOwner: "anonymous",
      anonymousSecretKey: hex,
      stateBase64: "sentinel-state",
      keyPackage: { reference: "sentinel-ref", publicBase64: "sentinel-public", privateBase64: "sentinel-private" },
      inviteToken: "sentinel-invite",
      autoApprove: true,
      joinRequestSent: true,
      pending: [{ id: "p", opaqueBase64: "x" }],
      pendingWelcomes: [{ requestPk: REMOTE, requestKpRef: "r", requestAt: 1, targetPubkey: REMOTE, keyPackageRef: "r", welcomeBase64: "w", after: 1 }],
      messages: [{ type: "message", id: "kept", sender: REMOTE, name: "R", content: "history", createdAt: 1 }],
    });
    saveRoom(room);

    (await retireAnonymousMemberships(pubkey)).commit();

    const raw = storage.getItem(currentKey(room)) ?? "";
    const retired = JSON.parse(raw) as StoredRoom;
    expect(retired.membershipStatus).toBe("retired");
    expect(retired.messages.map((message) => message.id)).toEqual(["kept"]);
    expect(retired.keyPackage).toEqual({ reference: "", publicBase64: "", privateBase64: "" });
    for (const field of ["anonymousSecretKey", "inviteToken", "autoApprove", "joinRequestSent", "pendingWelcomes"]) {
      expect(retired).not.toHaveProperty(field);
    }
    expect(retired.pending).toEqual([]);
    expect(retired.stateBase64).toBe("");
    for (const secretValue of [hex, "sentinel"]) expect(raw).not.toContain(secretValue);
  });

  it("collapses a legacy alias into the composite record and rollback restores both exactly", async () => {
    const { pubkey } = await anonymousIdentity();
    const room = makeRoom({ stablePubkey: pubkey, identityOwner: "anonymous", stateBase64: "alias-state" });
    const raw = JSON.stringify(room);
    storage.setItem(legacyKey(room.id), raw);
    const changed = collect(ROOMS_CHANGED_EVENT);

    const journal = await retireAnonymousMemberships(pubkey);

    expect(storage.getItem(legacyKey(room.id))).toBeNull();
    expect(JSON.parse(storage.getItem(currentKey(room)) ?? "{}").membershipStatus).toBe("retired");

    journal.rollback();

    // The composite key did not exist before retirement, so it must not exist now.
    expect(storage.getItem(currentKey(room))).toBeNull();
    expect(storage.getItem(legacyKey(room.id))).toBe(raw);
    const identity = roomIdentityKey(room.coordinatorPubkey, room.id);
    expect(changed).toEqual([
      { detail: { action: "membership-retired", affectedCompositeIdentities: [identity] } },
      { detail: { action: "membership-rollback", affectedCompositeIdentities: [identity] } },
    ]);
  });

  it("uses the composite record as authority when both aliases exist", async () => {
    const { pubkey } = await anonymousIdentity();
    const legacy = makeRoom({ title: "Stale legacy", stablePubkey: pubkey, identityOwner: "anonymous" });
    const current = makeRoom({ title: "Current", stablePubkey: pubkey, identityOwner: "anonymous" });
    storage.setItem(legacyKey(legacy.id), JSON.stringify(legacy));
    storage.setItem(currentKey(current), JSON.stringify(current));

    (await retireAnonymousMemberships(pubkey)).commit();

    expect(storage.getItem(legacyKey(legacy.id))).toBeNull();
    expect(loadRoom(current.id, COORDINATOR)?.title).toBe("Current");
  });

  it("leaves an alias alone when it no longer holds the same room at clean-up time", async () => {
    const { pubkey } = await anonymousIdentity();
    const room = makeRoom({ stablePubkey: pubkey, identityOwner: "anonymous" });
    const inner = createMemoryRoomStorage();
    inner.setItem(legacyKey(room.id), JSON.stringify(room));
    let hideAlias = false;
    useStorage(faultyStorage({
      getItem: (key) => (hideAlias && key === legacyKey(room.id) ? "null" : "ok"),
      setItem: (key) => {
        if (key === currentKey(room)) hideAlias = true;
        return "ok";
      },
    }, inner));

    (await retireAnonymousMemberships(pubkey)).commit();

    expect(inner.getItem(legacyKey(room.id))).not.toBeNull();
  });

  it("commit closes the journal so a later rollback restores nothing", async () => {
    saveRoom(makeRoom({ identityOwner: "anonymous", stateBase64: "before" }));
    const journal = await retireAnonymousMemberships();
    const changed = collect(ROOMS_CHANGED_EVENT);

    journal.commit();
    journal.rollback();

    expect(loadRoom("room-1", COORDINATOR)?.membershipStatus).toBe("retired");
    expect(changed).toEqual([]);
  });

  it("rollback is idempotent", async () => {
    saveRoom(makeRoom({ identityOwner: "anonymous", stateBase64: "before" }));
    const journal = await retireAnonymousMemberships();
    journal.rollback();
    saveRoom(makeRoom({ identityOwner: "anonymous", stateBase64: "written after rollback" }));
    const changed = collect(ROOMS_CHANGED_EVENT);

    journal.rollback();

    expect(loadRoom("room-1", COORDINATOR)?.stateBase64).toBe("written after rollback");
    expect(changed).toEqual([]);
  });

  it("undoes earlier rooms and publishes nothing when a later room cannot be written", async () => {
    const first = makeRoom({ id: "first", identityOwner: "anonymous", stateBase64: "first-state" });
    const second = makeRoom({ id: "second", identityOwner: "anonymous", stateBase64: "second-state" });
    saveRoom(first);
    saveRoom(second);
    let failing = false;
    const inner = storage;
    useStorage(faultyStorage({
      setItem: (key, value) => (failing && key === currentKey(second) && value.includes("retired") ? "throw" : "ok"),
    }, inner));
    failing = true;
    const changed = collect(ROOMS_CHANGED_EVENT);

    await expect(retireAnonymousMemberships()).rejects.toThrow("Storage full");

    expect(loadRoom("first", COORDINATOR)?.stateBase64).toBe("first-state");
    expect(loadRoom("first", COORDINATOR)?.membershipStatus).toBeUndefined();
    expect(loadRoom("second", COORDINATOR)?.stateBase64).toBe("second-state");
    expect(changed).toEqual([]);
  });

  it("refuses to claim retirement when storage silently discards the write", async () => {
    saveRoom(makeRoom({ identityOwner: "anonymous", stateBase64: "survives" }));
    useStorage(faultyStorage({ setItem: (_key, value) => (value.includes('"retired"') ? "drop" : "ok") }, storage));

    await expect(retireAnonymousMemberships()).rejects.toThrow("Unable to verify anonymous membership retirement");

    expect(loadRoom("room-1", COORDINATOR)?.stateBase64).toBe("survives");
  });

  it("refuses to claim retirement when the written record cannot be read back", async () => {
    const room = makeRoom({ identityOwner: "anonymous" });
    saveRoom(room);
    let hide = false;
    useStorage(faultyStorage({
      getItem: () => (hide ? "null" : "ok"),
      setItem: (_key, value) => {
        if (value.includes('"retired"')) hide = true;
        return "ok";
      },
    }, storage));

    await expect(retireAnonymousMemberships()).rejects.toThrow("Unable to verify");
  });
});

describe("host identity resolution", () => {
  const hostPubkey = "e".repeat(64);

  it("prefers the explicit host and otherwise derives one for a hosted room", () => {
    const explicit = { name: "Declared", pubkey: hostPubkey };

    expect(hostIdentityForRoom(makeRoom({ isHost: true, host: explicit }))).toEqual(explicit);
    expect(hostIdentityForRoom(makeRoom({ isHost: true, name: "  Ada " }))).toEqual({ name: "Ada", pubkey: MEMBER });
    expect(hostIdentityForRoom(makeRoom({ isHost: true, name: "   " }))).toEqual({ name: "Host", pubkey: MEMBER });
  });

  it("still returns a usable identity when a legacy host record cannot be normalized", () => {
    expect(hostIdentityForRoom(makeRoom({ isHost: true, name: " Ada ", stablePubkey: "not-a-key" })))
      .toEqual({ name: "Ada", pubkey: "not-a-key" });
    expect(hostIdentityForRoom(makeRoom({ isHost: true, name: "  ", stablePubkey: "not-a-key" })))
      .toEqual({ name: "Host", pubkey: "not-a-key" });
  });

  it("trusts claimed presentation while waiting and only the MLS creator after admission", async () => {
    const creator = "1".repeat(64);
    const creatorKeys = await createKeyPackage(creator);
    const state = encodeState(await createRoomState(creatorKeys.keyPackage, creatorKeys.privateKeyPackage));
    const claim = { name: "Claimed", pubkey: creator };

    expect(hostIdentityForRoom(makeRoom({ joinRequestSent: true, host: claim }))).toEqual(claim);
    expect(hostIdentityForRoom(makeRoom({ joinRequestSent: true }))).toEqual({ name: "Unknown host", pubkey: "" });
    expect(hostIdentityForRoom(makeRoom({ stateBase64: state, host: claim }))).toEqual(claim);
    expect(hostIdentityForRoom(makeRoom({ stateBase64: state, host: { name: "Mallory", pubkey: "f".repeat(64) } })))
      .toEqual({ name: "Unknown host", pubkey: creator });
  });

  it("treats a corrupt or absent cached state as an unknown host", () => {
    expect(hostIdentityForRoom(makeRoom({ stateBase64: "@@not-state@@", host: { name: "C", pubkey: hostPubkey } })))
      .toEqual({ name: "Unknown host", pubkey: "" });
    expect(hostIdentityForRoom(makeRoom())).toEqual({ name: "Unknown host", pubkey: "" });
  });

  it("reconciles case-insensitively and reports a missing creator as unknown", () => {
    const claim = { name: "Ada", pubkey: "a".repeat(64) };

    expect(reconcileRoomHostIdentity(claim, "A".repeat(64))).toEqual(claim);
    expect(reconcileRoomHostIdentity(claim, null)).toEqual({ name: "Unknown host", pubkey: "" });
    expect(reconcileRoomHostIdentity(undefined, "b".repeat(64))).toEqual({ name: "Unknown host", pubkey: "b".repeat(64) });
  });
});

describe("isCurrentInviteRequest", () => {
  it("rejects only an explicitly different token", () => {
    expect(isCurrentInviteRequest(undefined, { invite_token: "x" })).toBe(true);
    expect(isCurrentInviteRequest("t", {})).toBe(true);
    expect(isCurrentInviteRequest("t", { invite_token: "t" })).toBe(true);
    expect(isCurrentInviteRequest("t", { invite_token: "x" })).toBe(false);
  });
});

describe("loadRoom", () => {
  it("returns null for rooms under another coordinator and for mismatched records", () => {
    saveRoom(makeRoom());
    storage.setItem(legacyKey("foreign"), JSON.stringify(makeRoom({ id: "foreign", coordinatorPubkey: OTHER_COORDINATOR })));
    // A composite key holding somebody else's room must never answer for this one.
    storage.setItem(currentKey({ id: "tampered", coordinatorPubkey: COORDINATOR }), JSON.stringify(makeRoom({ id: "elsewhere" })));

    expect(loadRoom("room-1", OTHER_COORDINATOR)).toBeNull();
    expect(loadRoom("foreign", COORDINATOR)).toBeNull();
    expect(loadRoom("tampered", COORDINATOR)).toBeNull();
    expect(loadRoom("absent", COORDINATOR)).toBeNull();
  });

  it("migrates a matching legacy record to the composite key", () => {
    const room = makeRoom({ title: "Legacy" });
    storage.setItem(legacyKey(room.id), JSON.stringify(room));

    expect(loadRoom(room.id, COORDINATOR)?.title).toBe("Legacy");

    expect(storage.getItem(legacyKey(room.id))).toBeNull();
    expect(storage.getItem(currentKey(room))).not.toBeNull();
  });

  it("does not remove a legacy source that changed while it was being migrated", () => {
    const room = makeRoom({ title: "Legacy" });
    const inner = createMemoryRoomStorage([[legacyKey(room.id), JSON.stringify(room)]]);
    let migrated = false;
    useStorage(faultyStorage({
      setItem: (key) => {
        if (key === currentKey(room)) migrated = true;
        return "ok";
      },
      getItem: (key) => (migrated && key === legacyKey(room.id) ? "null" : "ok"),
    }, inner));

    expect(loadRoom(room.id, COORDINATOR)?.title).toBe("Legacy");

    expect(inner.getItem(legacyKey(room.id))).not.toBeNull();
    expect(inner.getItem(currentKey(room))).not.toBeNull();
  });

  it("resolves an unqualified id only when exactly one coordinator holds it", () => {
    saveRoom(makeRoom({ id: "unique" }));
    saveRoom(makeRoom({ id: "shared" }));
    saveRoom(makeRoom({ id: "shared", coordinatorPubkey: OTHER_COORDINATOR }));

    expect(loadRoom("unique")?.id).toBe("unique");
    expect(loadRoom("shared")).toBeNull();
    expect(loadRoom("absent")).toBeNull();
  });

  it("returns null when storage itself is unavailable", () => {
    useStorage(faultyStorage({ getItem: () => "throw" }));

    expect(loadRoom("room-1", COORDINATOR)).toBeNull();
  });

  it("still serves a legacy room when it cannot be migrated because storage is full", () => {
    const room = makeRoom({ title: "Legacy" });
    const inner = createMemoryRoomStorage([[legacyKey(room.id), JSON.stringify(room)]]);
    useStorage(faultyStorage({ setItem: () => "throw" }, inner));

    expect(loadRoom(room.id, COORDINATOR)?.title).toBe("Legacy");
    expect(inner.getItem(legacyKey(room.id))).not.toBeNull();
  });
});

describe("listRooms", () => {
  it("orders by update, then newest message, then creation, then title", () => {
    const message = { type: "message" as const, id: "m", sender: REMOTE, name: "R", content: "x", createdAt: 300 };
    const raw = (room: StoredRoom) => storage.setItem(currentKey(room), JSON.stringify(room));
    raw(makeRoom({ id: "updated", title: "Updated", updatedAt: 400 }));
    raw(makeRoom({ id: "message", title: "Message", messages: [message] }));
    raw(makeRoom({ id: "created", title: "Created", createdAt: 200 }));
    raw(makeRoom({ id: "zulu", title: "Zulu" }));
    raw(makeRoom({ id: "alpha", title: "Alpha" }));

    expect(listRooms().map((room) => room.id)).toEqual(["updated", "message", "created", "alpha", "zulu"]);
  });

  it("skips empty and unrelated values and tolerates a key that vanished mid-scan", () => {
    saveRoom(makeRoom());
    storage.setItem(legacyKey("empty"), "");
    storage.setItem("unrelated", "{}");
    expect(listRooms().map((room) => room.id)).toEqual(["room-1"]);

    useStorage(faultyStorage({ key: () => "null" }, storage));
    expect(listRooms()).toEqual([]);
  });

  it("returns nothing when storage cannot be read at all", () => {
    saveRoom(makeRoom());
    useStorage(faultyStorage({ key: () => "throw" }, storage));

    expect(listRooms()).toEqual([]);
  });

  it("merges several legacy aliases of one room and removes them after migrating", () => {
    const room = makeRoom({ title: "Canonical" });
    storage.setItem(legacyKey(room.id), JSON.stringify(room));
    storage.setItem(`${legacyKey("second-alias")}`, JSON.stringify(makeRoom({ title: "Alias" })));

    expect(listRooms().map((entry) => entry.title)).toEqual(["Canonical"]);

    expect(storage.getItem(legacyKey(room.id))).toBeNull();
    expect(storage.getItem(legacyKey("second-alias"))).toBeNull();
    expect(storage.getItem(currentKey(room))).not.toBeNull();
  });

  it("keeps listing every room when a legacy room cannot be migrated", () => {
    const current = makeRoom({ id: "current", title: "Current" });
    const legacy = makeRoom({ id: "legacy", title: "Legacy" });
    const inner = createMemoryRoomStorage([
      [currentKey(current), JSON.stringify(current)],
      [legacyKey(legacy.id), JSON.stringify(legacy)],
    ]);
    useStorage(faultyStorage({ setItem: () => "throw" }, inner));

    expect(listRooms().map((room) => room.title).sort()).toEqual(["Current", "Legacy"]);
    expect(inner.getItem(legacyKey(legacy.id))).not.toBeNull();
  });

  it("keeps the legacy source when storage silently discards its migration", () => {
    const room = makeRoom({ title: "Legacy" });
    const inner = createMemoryRoomStorage([[legacyKey(room.id), JSON.stringify(room)]]);
    useStorage(faultyStorage({ setItem: () => "drop" }, inner));

    expect(listRooms().map((entry) => entry.title)).toEqual(["Legacy"]);
    expect(inner.getItem(legacyKey(room.id))).not.toBeNull();
  });

  it("keeps listing rooms when a stale alias cannot be removed", () => {
    const room = makeRoom({ title: "Current" });
    const inner = createMemoryRoomStorage([
      [legacyKey(room.id), JSON.stringify(room)],
      [currentKey(room), JSON.stringify(room)],
    ]);
    useStorage(faultyStorage({ removeItem: () => "throw" }, inner));

    expect(listRooms().map((entry) => entry.title)).toEqual(["Current"]);
  });
});

describe("persisted record validation", () => {
  const validMessage = { type: "message", id: "m", sender: REMOTE, name: "R", content: "x", createdAt: 1 };
  const write = (fields: Record<string, unknown>) => {
    storage.setItem(currentKey(makeRoom()), JSON.stringify({ ...makeRoom(), ...fields }));
  };

  it.each<[string, Record<string, unknown>]>([
    ["version", { version: 2 }],
    ["id", { id: 1 }],
    ["title", { title: 1 }],
    ["coordinator", { coordinatorPubkey: 1 }],
    ["relay list", { relayUrls: "wss://r" }],
    ["relay entry", { relayUrls: [1] }],
    ["name", { name: null }],
    ["stable key", { stablePubkey: null }],
    ["host flag", { isHost: "yes" }],
    ["state", { stateBase64: 1 }],
    ["key package", { keyPackage: "kp" }],
    ["key package reference", { keyPackage: { reference: 1, publicBase64: "", privateBase64: "" } }],
    ["key package public", { keyPackage: { reference: "", publicBase64: 1, privateBase64: "" } }],
    ["key package private", { keyPackage: { reference: "", publicBase64: "", privateBase64: 1 } }],
    ["cursor", { lastCursor: "0" }],
    ["messages", { messages: {} }],
    ["message record", { messages: ["x"] }],
    ["message type", { messages: [{ ...validMessage, type: "note" }] }],
    ["message id", { messages: [{ ...validMessage, id: 1 }] }],
    ["message sender", { messages: [{ ...validMessage, sender: 1 }] }],
    ["message name", { messages: [{ ...validMessage, name: 1 }] }],
    ["message content", { messages: [{ ...validMessage, content: 1 }] }],
    ["message time", { messages: [{ ...validMessage, createdAt: "1" }] }],
    ["message auth", { messages: [{ ...validMessage, auth: "signed" }] }],
    ["message auth id", { messages: [{ ...validMessage, auth: { id: 1, sig: "s" } }] }],
    ["message auth sig", { messages: [{ ...validMessage, auth: { id: "i", sig: 1 } }] }],
    ["message cursor", { messages: [{ ...validMessage, cursor: "1" }] }],
    ["message pending flag", { messages: [{ ...validMessage, pending: "yes" }] }],
    ["pending list", { pending: {} }],
    ["pending record", { pending: [1] }],
    ["pending id", { pending: [{ id: 1, opaqueBase64: "x" }] }],
    ["pending payload", { pending: [{ id: "p", opaqueBase64: 1 }] }],
  ])("hides a record with an invalid %s", (_scenario, fields) => {
    write(fields);

    expect(loadRoom("room-1", COORDINATOR)).toBeNull();
  });

  it.each<[string, string]>([
    ["non-JSON", "{not json"],
    ["a JSON scalar", "1"],
    ["a JSON null", "null"],
    ["an infinite cursor", JSON.stringify(makeRoom()).replace('"lastCursor":0', '"lastCursor":1e999')],
    ["an infinite message time", JSON.stringify({ ...makeRoom(), messages: [validMessage] }).replace('"createdAt":1', '"createdAt":1e999')],
    ["an infinite message cursor", JSON.stringify({ ...makeRoom(), messages: [{ ...validMessage, cursor: 1 }] }).replace('"cursor":1', '"cursor":1e999')],
  ])("hides %s", (_scenario, raw) => {
    storage.setItem(currentKey(makeRoom()), raw);

    expect(loadRoom("room-1", COORDINATOR)).toBeNull();
  });

  const welcome = { requestPk: "p", requestKpRef: "r", requestAt: 1, targetPubkey: "t", keyPackageRef: "k", welcomeBase64: "w", after: 2 };

  it("keeps a well-formed Welcome outbox and drops one with any malformed entry", () => {
    write({ pendingWelcomes: [welcome] });
    expect(loadRoom("room-1", COORDINATOR)?.pendingWelcomes).toEqual([welcome]);
  });

  it.each<[string, unknown]>([
    ["not a list", "x"],
    ["not a record", [1]],
    ["requestPk", [{ ...welcome, requestPk: 1 }]],
    ["requestKpRef", [{ ...welcome, requestKpRef: 1 }]],
    ["requestAt", [{ ...welcome, requestAt: "1" }]],
    ["targetPubkey", [{ ...welcome, targetPubkey: 1 }]],
    ["keyPackageRef", [{ ...welcome, keyPackageRef: 1 }]],
    ["welcomeBase64", [{ ...welcome, welcomeBase64: 1 }]],
    ["after", [{ ...welcome, after: "2" }]],
  ])("drops a Welcome outbox with a bad %s without hiding the room", (_scenario, pendingWelcomes) => {
    write({ pendingWelcomes });

    const room = loadRoom("room-1", COORDINATOR);
    expect(room?.title).toBe("Room");
    expect(room).not.toHaveProperty("pendingWelcomes");
  });

  it("drops Welcome outbox entries with non-finite numbers", () => {
    const encoded = JSON.stringify({ ...makeRoom(), pendingWelcomes: [welcome] });
    storage.setItem(currentKey(makeRoom()), encoded.replace('"requestAt":1', '"requestAt":1e999'));
    expect(loadRoom("room-1", COORDINATOR)).not.toHaveProperty("pendingWelcomes");

    storage.setItem(currentKey(makeRoom()), encoded.replace('"after":2', '"after":1e999'));
    expect(loadRoom("room-1", COORDINATOR)).not.toHaveProperty("pendingWelcomes");
  });

  it("scrubs malformed optional metadata but keeps valid values", () => {
    write({ membershipStatus: "paused", identityOwner: "someone", anonymousSecretKey: "short", coordinatorKeyMode: "weird", host: { name: "" } });
    const scrubbed = loadRoom("room-1", COORDINATOR);
    for (const field of ["membershipStatus", "identityOwner", "anonymousSecretKey", "coordinatorKeyMode", "host", "readState"]) {
      expect(scrubbed).not.toHaveProperty(field);
    }

    const secret = "ab".repeat(32);
    write({ membershipStatus: "active", identityOwner: "external", anonymousSecretKey: secret, coordinatorKeyMode: "ephemeral" });
    expect(loadRoom("room-1", COORDINATOR)).toMatchObject({ membershipStatus: "active", identityOwner: "external", anonymousSecretKey: secret, coordinatorKeyMode: "ephemeral" });

    write({ membershipStatus: "retired", identityOwner: "anonymous", coordinatorKeyMode: "persistent", anonymousSecretKey: 7 });
    const retired = loadRoom("room-1", COORDINATOR);
    expect(retired).toMatchObject({ membershipStatus: "retired", identityOwner: "anonymous", coordinatorKeyMode: "persistent" });
    expect(retired).not.toHaveProperty("anonymousSecretKey");
  });

  it("repairs duplicate messages by preferring the higher cursor or the delivered copy", () => {
    write({
      messages: [
        { ...validMessage, id: "a", content: "first" },
        { ...validMessage, id: "a", content: "uncursored again" },
        { ...validMessage, id: "b", cursor: 2, content: "b-older" },
        { ...validMessage, id: "b", cursor: 5, content: "b-newer" },
        { ...validMessage, id: "b", cursor: 3, content: "b-stale" },
        { ...validMessage, id: "c", pending: true, content: "c-pending" },
        { ...validMessage, id: "c", pending: false, content: "c-delivered" },
        { ...validMessage, id: "d", content: "d-kept" },
        { ...validMessage, id: "d", pending: true, content: "d-pending" },
        { ...validMessage, id: "e", cursor: 9, pending: true, content: "e-pending" },
        { ...validMessage, id: "e", pending: true, content: "e-uncursored" },
      ],
      pending: [{ id: "p", opaqueBase64: "one" }, { id: "p", opaqueBase64: "two" }],
    });

    const room = loadRoom("room-1", COORDINATOR);

    expect(room?.messages.map((message) => message.content)).toEqual(["first", "b-newer", "c-delivered", "d-kept", "e-pending"]);
    expect(room?.pending).toEqual([{ id: "p", opaqueBase64: "one" }]);
  });

  it("strips an unprovable host badge from a cached message", () => {
    write({
      isHost: true,
      messages: [{ ...validMessage, badgeLabel: "host", badgeEmoji: "👑" }],
    });

    const [message] = loadRoom("room-1", COORDINATOR)?.messages ?? [];

    expect(message).not.toHaveProperty("badgeLabel");
    expect(message).not.toHaveProperty("badgeEmoji");
  });

  it("does not trust a verified-creator badge from a waiting or corrupt room", () => {
    write({ joinRequestSent: true, stateBase64: "whatever", messages: [{ ...validMessage, badgeLabel: "host" }] });
    expect(loadRoom("room-1", COORDINATOR)?.messages[0]).not.toHaveProperty("badgeLabel");

    write({ stateBase64: "@@corrupt@@", messages: [{ ...validMessage, badgeLabel: "host" }] });
    expect(loadRoom("room-1", COORDINATOR)?.messages[0]).not.toHaveProperty("badgeLabel");
  });

  it("verifies the badge against a real room creator from stored MLS state", async () => {
    const creatorSigner = new BrowserNostrSigner(generateSecretKey());
    const creator = await creatorSigner.getPublicKey();
    const memberPubkey = "2".repeat(64);
    const creatorKeys = await createKeyPackage(creator);
    const memberKeys = await createKeyPackage(memberPubkey);
    const initial = await createRoomState(creatorKeys.keyPackage, creatorKeys.privateKeyPackage);
    const added = await addMember(initial, memberKeys.stored.publicBase64);
    const memberState = encodeState(await joinWelcome(added.welcomeBase64, memberKeys.stored));
    const signed = await signChatEnvelope({ type: "message", id: "ignored", sender: creator, name: "Host", badgeLabel: "host", content: "hello", createdAt: 1_000 }, creatorSigner);

    write({ stablePubkey: memberPubkey, stateBase64: memberState, messages: [signed] });

    expect(loadRoom("room-1", COORDINATOR)?.messages[0]?.badgeLabel).toBe("host");
  });
});

describe("reaction projection", () => {
  const reaction = (overrides: Partial<StoredReaction> = {}): StoredReaction => ({
    id: "r1",
    sender: REMOTE,
    createdAt: 100,
    targetMessageId: "m",
    emoji: "👍",
    active: true,
    ...overrides,
  });
  const loadWith = (reactions: unknown, messages: unknown[] = []) => {
    storage.setItem(currentKey(makeRoom()), JSON.stringify({ ...makeRoom(), reactions, messages }));
    return loadRoom("room-1", COORDINATOR);
  };

  it("treats a missing reaction cache as empty", () => {
    expect(loadWith(undefined)?.reactions).toEqual([]);
    expect(loadWith("nonsense")?.reactions).toEqual([]);
  });

  it("drops malformed reactions and keeps valid ones", () => {
    const stored = loadWith([
      reaction({ id: "valid" }),
      reaction({ id: "cursor", sender: "s2", cursor: 3 }),
      "text",
      { ...reaction(), emoji: "🦄" },
      { ...reaction(), id: 1 },
      { ...reaction(), sender: 1 },
      { ...reaction(), createdAt: "1" },
      { ...reaction(), cursor: "1" },
    ]);

    expect(stored?.reactions?.map((entry) => entry.id)).toEqual(["valid", "cursor"]);
  });

  it.each<[string, Partial<StoredReaction>, Partial<StoredReaction>, string]>([
    ["higher cursor beats time", { id: "a", cursor: 2, createdAt: 900 }, { id: "b", cursor: 3, createdAt: 100 }, "b"],
    ["lower cursor loses to time", { id: "a", cursor: 3, createdAt: 100 }, { id: "b", cursor: 2, createdAt: 900 }, "a"],
    ["same cursor falls to time", { id: "a", cursor: 3, createdAt: 100 }, { id: "b", cursor: 3, createdAt: 200 }, "b"],
    ["unposted falls to time", { id: "a", cursor: 3, createdAt: 100 }, { id: "b", createdAt: 200 }, "b"],
    ["older unposted loses", { id: "a", createdAt: 300 }, { id: "b", cursor: 3, createdAt: 200 }, "a"],
    ["same time falls to id", { id: "a", createdAt: 100 }, { id: "b", createdAt: 100 }, "b"],
    ["same time smaller id loses", { id: "b", createdAt: 100 }, { id: "a", createdAt: 100 }, "b"],
  ])("keeps the latest mutation per participant: %s", (_scenario, first, second, winner) => {
    const stored = loadWith([reaction(first), reaction(second)]);

    expect(stored?.reactions?.map((entry) => entry.id)).toEqual([winner]);
  });

  it("keeps distinct participants, emoji and targets apart", () => {
    const stored = loadWith([
      reaction({ id: "a" }),
      reaction({ id: "b", sender: "other" }),
      reaction({ id: "c", emoji: "🎉" }),
      reaction({ id: "d", targetMessageId: "other" }),
    ]);

    expect(stored?.reactions).toHaveLength(4);
  });

  it("migrates signed legacy reaction messages out of history and leaves unsigned ones", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());
    const sender = await signer.getPublicKey();
    const signed = await signChatEnvelope({
      type: "message",
      id: "x",
      sender,
      name: "R",
      content: "Reacted 👍",
      createdAt: 5_000,
      reaction: { targetMessageId: "m", emoji: "👍", active: true },
    }, signer);
    const unsigned = { type: "message", id: "unsigned", sender: REMOTE, name: "R", content: "Reacted", createdAt: 1, reaction: { targetMessageId: "m", emoji: "👍", active: true } };
    const plain = { type: "message", id: "plain", sender: REMOTE, name: "R", content: "hi", createdAt: 1 };
    const badReaction = { ...plain, id: "bad", reaction: { nope: true } };

    const stored = loadWith([], [{ ...signed, cursor: 4 }, unsigned, plain, badReaction]);

    expect(stored?.messages.map((message) => message.id)).toEqual(["unsigned", "plain", "bad"]);
    expect(stored?.reactions).toEqual([expect.objectContaining({ id: signed.id, sender, cursor: 4, emoji: "👍", targetMessageId: "m" })]);
  });

  it("summarizes active reactions per emoji for one target and viewer", () => {
    const summary = reactionSummary({
      reactions: [
        reaction({ id: "1", sender: "viewer" }),
        reaction({ id: "2", sender: "other" }),
        reaction({ id: "3", sender: "third", emoji: "🎉" }),
        reaction({ id: "4", sender: "gone", active: false }),
        reaction({ id: "5", sender: "elsewhere", targetMessageId: "other" }),
      ],
    }, "m", "viewer");

    expect(summary).toEqual([
      { emoji: "👍", count: 2, viewerActive: true },
      { emoji: "🎉", count: 1, viewerActive: false },
    ]);
    expect(reactionSummary({}, "m", "viewer")).toEqual([]);
  });

  it("keeps viewer activity once any of the viewer's reactions counted, regardless of order", () => {
    const summary = reactionSummary({
      reactions: [reaction({ id: "1", sender: "viewer" }), reaction({ id: "2", sender: "other" })],
    }, "m", "viewer");

    expect(summary[0]?.viewerActive).toBe(true);
  });
});

describe("last open room", () => {
  it("remembers exact rooms and forgets them on removal", () => {
    const room = makeRoom();
    saveRoom(room);

    rememberLastOpenRoom(room);
    expect(loadLastOpenRoom(COORDINATOR)?.id).toBe(room.id);

    removeStoredRoom(room);
    expect(storage.getItem(lastOpenKey(COORDINATOR))).toBeNull();
    expect(loadLastOpenRoom(COORDINATOR)).toBeNull();
  });

  it("removes the record when storage does not return exactly what was written", () => {
    useStorage(faultyStorage({ setItem: () => "tamper" }));

    rememberLastOpenRoom(makeRoom());

    expect(storage.getItem(lastOpenKey(COORDINATOR))).toBeNull();
  });

  it("tolerates unavailable storage for every selection helper", () => {
    useStorage(faultyStorage({ setItem: () => "throw", getItem: () => "throw", removeItem: () => "throw" }));

    expect(() => rememberLastOpenRoom(makeRoom())).not.toThrow();
    expect(() => forgetRememberedHostRoom(COORDINATOR)).not.toThrow();
    expect(loadLastOpenRoom(COORDINATOR)).toBeNull();
  });

  it("upgrades a legacy raw room id in place", () => {
    const room = makeRoom();
    saveRoom(room);
    storage.setItem(lastOpenKey(COORDINATOR), room.id);

    expect(loadLastOpenRoom(COORDINATOR)?.id).toBe(room.id);
    expect(JSON.parse(storage.getItem(lastOpenKey(COORDINATOR)) ?? "null")).toEqual({ version: 1, coordinatorPubkey: COORDINATOR, roomId: room.id });
  });

  it.each<[string, string]>([
    ["unknown raw id", "absent-room"],
    ["JSON that is not a record", "42"],
    ["record for another coordinator", JSON.stringify({ version: 1, coordinatorPubkey: OTHER_COORDINATOR, roomId: "room-1" })],
    ["unsupported record version", JSON.stringify({ version: 2, coordinatorPubkey: COORDINATOR, roomId: "room-1" })],
    ["record with a bad coordinator", JSON.stringify({ version: 1, coordinatorPubkey: 1, roomId: "room-1" })],
    ["record with a bad room", JSON.stringify({ version: 1, coordinatorPubkey: COORDINATOR, roomId: 1 })],
    ["record for a missing room", JSON.stringify({ version: 1, coordinatorPubkey: COORDINATOR, roomId: "absent" })],
  ])("discards a stale preference: %s", (_scenario, stored) => {
    saveRoom(makeRoom());
    storage.setItem(lastOpenKey(COORDINATOR), stored);

    expect(loadLastOpenRoom(COORDINATOR)).toBeNull();
    expect(storage.getItem(lastOpenKey(COORDINATOR))).toBeNull();
  });

  it("will not reopen a retired room", () => {
    const room = makeRoom({ membershipStatus: "retired" });
    saveRoom(room);
    rememberLastOpenRoom(room);

    expect(loadLastOpenRoom(COORDINATOR)).toBeNull();
    expect(storage.getItem(lastOpenKey(COORDINATOR))).toBeNull();
  });

  it("deprecated host helpers remember only hosted rooms", () => {
    const guest = makeRoom({ id: "guest" });
    const host = makeRoom({ id: "host", isHost: true });
    saveRoom(guest);
    saveRoom(host);

    rememberActiveHostRoom(guest);
    expect(loadRememberedHostRoom(COORDINATOR)).toBeNull();

    rememberActiveHostRoom(host);
    expect(loadRememberedHostRoom(COORDINATOR)?.id).toBe("host");

    forgetRememberedHostRoom(COORDINATOR);
    expect(loadRememberedHostRoom(COORDINATOR)).toBeNull();
  });
});

describe("saveRoom", () => {
  it("stamps the update time, replaces a matching legacy copy and notifies", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const room = makeRoom();
    storage.setItem(legacyKey(room.id), JSON.stringify(room));
    const changed = collect(ROOMS_CHANGED_EVENT);

    saveRoom(room);

    expect(room.updatedAt).toBe(1234);
    expect(storage.getItem(legacyKey(room.id))).toBeNull();
    expect(changed).toEqual([{ detail: { roomId: room.id, coordinatorPubkey: COORDINATOR } }]);
  });

  it("leaves a legacy record belonging to another coordinator in place", () => {
    const foreign = makeRoom({ coordinatorPubkey: OTHER_COORDINATOR });
    storage.setItem(legacyKey(foreign.id), JSON.stringify(foreign));

    saveRoom(makeRoom());

    expect(storage.getItem(legacyKey(foreign.id))).not.toBeNull();
  });

  it("announces nothing when the record could not be verified after writing", () => {
    useStorage(faultyStorage({ setItem: () => "drop" }));
    const changed = collect(ROOMS_CHANGED_EVENT);

    saveRoom(makeRoom());

    expect(changed).toEqual([]);
  });
});

describe("removeStoredRoom", () => {
  function hook() {
    const onRoomRemoved = vi.fn();
    restoreEnvironment();
    restoreEnvironment = configureRoomEnvironment({ storage, events, onRoomRemoved });
    return onRoomRemoved;
  }

  it("archives the stored record through the hook before removing it", () => {
    const onRoomRemoved = hook();
    const room = makeRoom({ title: "Archive me" });
    saveRoom(room);
    let presentDuringHook = false;
    onRoomRemoved.mockImplementation(() => { presentDuringHook = storage.getItem(currentKey(room)) !== null; });

    removeStoredRoom(room, { reason: "left", coordinatorLabel: "Coord" });

    expect(onRoomRemoved).toHaveBeenCalledWith(expect.objectContaining({ title: "Archive me" }), "left", "Coord");
    expect(presentDuringHook).toBe(true);
    expect(loadRoom(room.id, COORDINATOR)).toBeNull();
  });

  it("archives a room that only exists under its legacy key", () => {
    const onRoomRemoved = hook();
    const room = makeRoom({ title: "Legacy archive" });
    storage.setItem(legacyKey(room.id), JSON.stringify(room));

    removeStoredRoom(room, { reason: "deleted", coordinatorLabel: "Coord" });

    expect(onRoomRemoved).toHaveBeenCalledWith(expect.objectContaining({ title: "Legacy archive" }), "deleted", "Coord");
    expect(storage.getItem(legacyKey(room.id))).toBeNull();
  });

  it("does not archive when no history was requested or nothing exists", () => {
    const onRoomRemoved = hook();
    const room = makeRoom();
    saveRoom(room);
    removeStoredRoom(room);
    expect(onRoomRemoved).not.toHaveBeenCalled();

    removeStoredRoom(room, { reason: "left", coordinatorLabel: "Coord" });
    expect(onRoomRemoved).not.toHaveBeenCalled();
  });

  it("never archives or removes a record that is not exactly this room", () => {
    const onRoomRemoved = hook();
    const target = makeRoom({ id: "target" });
    const tampered = JSON.stringify(makeRoom({ id: "other-room" }));
    storage.setItem(currentKey(target), tampered);

    removeStoredRoom(target, { reason: "left", coordinatorLabel: "Coord" });

    expect(onRoomRemoved).not.toHaveBeenCalled();
    expect(storage.getItem(currentKey(target))).toBe(tampered);
  });

  it("keeps another room's last-open preference and another coordinator's legacy copy", () => {
    const kept = makeRoom({ id: "kept" });
    const removed = makeRoom({ id: "removed" });
    const foreign = makeRoom({ id: "removed", coordinatorPubkey: OTHER_COORDINATOR });
    saveRoom(kept);
    saveRoom(removed);
    rememberLastOpenRoom(kept);
    storage.setItem(legacyKey("removed"), JSON.stringify(foreign));
    const changed = collect(ROOMS_CHANGED_EVENT);

    removeStoredRoom(removed);

    expect(loadLastOpenRoom(COORDINATOR)?.id).toBe("kept");
    expect(storage.getItem(legacyKey("removed"))).not.toBeNull();
    expect(changed).toEqual([{ detail: { roomId: "removed", coordinatorPubkey: COORDINATOR, action: "removed" } }]);
  });
});

describe("removeHostedRoomsForCoordinator", () => {
  it("removes only hosted rooms of that coordinator, matching case-insensitively", () => {
    const onRoomRemoved = vi.fn();
    restoreEnvironment();
    restoreEnvironment = configureRoomEnvironment({ storage, events, onRoomRemoved });
    const hosted = makeRoom({ id: "hosted", isHost: true });
    const joined = makeRoom({ id: "joined" });
    const foreign = makeRoom({ id: "foreign", isHost: true, coordinatorPubkey: OTHER_COORDINATOR });
    saveRoom(hosted);
    saveRoom(joined);
    saveRoom(foreign);
    rememberLastOpenRoom(joined);

    removeHostedRoomsForCoordinator(`  ${COORDINATOR.toUpperCase()} `);
    removeHostedRoomsForCoordinator(COORDINATOR);

    expect(loadRoom("hosted", COORDINATOR)).toBeNull();
    expect(loadRoom("joined", COORDINATOR)).not.toBeNull();
    expect(loadRoom("foreign", OTHER_COORDINATOR)).not.toBeNull();
    expect(onRoomRemoved).toHaveBeenCalledOnce();
    expect(onRoomRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: "hosted" }), "deleted", `Previous local ${COORDINATOR.slice(0, 6)}`);
    expect(storage.getItem(lastOpenKey(COORDINATOR))).toBeNull();
  });

  it("is not disturbed by an unreadable record elsewhere in storage", () => {
    saveRoom(makeRoom({ isHost: true }));
    storage.setItem(legacyKey("corrupt"), "{not json");

    removeHostedRoomsForCoordinator(COORDINATOR);

    expect(loadRoom("room-1", COORDINATOR)).toBeNull();
    expect(storage.getItem(legacyKey("corrupt"))).toBe("{not json");
  });

  it("does nothing for a blank coordinator", () => {
    const hosted = makeRoom({ isHost: true });
    saveRoom(hosted);

    removeHostedRoomsForCoordinator("   ");

    expect(loadRoom(hosted.id, COORDINATOR)).not.toBeNull();
  });

  it("does nothing when storage cannot be enumerated", () => {
    const inner = storage;
    saveRoom(makeRoom({ isHost: true }));
    useStorage(faultyStorage({ key: () => "throw" }, inner));

    expect(() => removeHostedRoomsForCoordinator(COORDINATOR)).not.toThrow();
    expect(inner.getItem(currentKey(makeRoom()))).not.toBeNull();
  });
});

describe("unread helpers", () => {
  const read = (unreadCount: number, baselineEstablished = true) => ({ version: 1 as const, baselineEstablished, lastReadCursor: 0, unreadCount });

  it("counts only established, valid ledgers", () => {
    expect(coordinatorUnreadTotal([
      { coordinatorPubkey: COORDINATOR, readState: read(2) },
      { coordinatorPubkey: COORDINATOR, readState: read(9, false) },
      { coordinatorPubkey: COORDINATOR },
      { coordinatorPubkey: OTHER_COORDINATOR, readState: read(100) },
    ], COORDINATOR)).toBe(2);
  });

  it("acknowledges exactly one room and emits only when something changed", () => {
    const unread = makeRoom({ id: "unread", lastCursor: 7, readState: read(3) });
    const clean = makeRoom({ id: "clean", lastCursor: 2, readState: read(0) });
    const sameId = makeRoom({ id: "unread", coordinatorPubkey: OTHER_COORDINATOR, readState: read(5) });
    saveRoom(unread);
    saveRoom(clean);
    saveRoom(sameId);
    const changes = collect(ROOM_UNREAD_CHANGED_EVENT);

    markRoomRead({ coordinatorPubkey: COORDINATOR, roomId: "unread" });
    markRoomRead({ coordinatorPubkey: COORDINATOR, roomId: "clean" });
    markRoomRead({ coordinatorPubkey: COORDINATOR, roomId: "absent" });

    expect(loadRoom("unread", COORDINATOR)?.readState).toEqual({ version: 1, baselineEstablished: true, lastReadCursor: 7, unreadCount: 0 });
    expect(loadRoom("unread", OTHER_COORDINATOR)?.readState?.unreadCount).toBe(5);
    expect(changes).toEqual([{ detail: { coordinatorPubkey: COORDINATOR, roomId: "unread", previousCount: 3, unreadCount: 0 } }]);
  });

  it("records a safe read cursor even when the stored cursor is unusable", () => {
    const room = makeRoom({ lastCursor: 1.5 });
    saveRoom(room);

    markRoomRead({ coordinatorPubkey: COORDINATOR, roomId: room.id });

    expect(loadRoom(room.id, COORDINATOR)?.readState?.lastReadCursor).toBe(0);
  });
});

describe("rotateRoomInvite", () => {
  it("replaces and persists the token so older links fail the freshness check", () => {
    const room = makeRoom({ isHost: true, inviteToken: "old-token" });
    saveRoom(room);

    const rotated = rotateRoomInvite(room);

    expect(rotated).toBe(room);
    expect(room.inviteToken).toMatch(/^[0-9a-f]{36}$/);
    expect(room.inviteToken).not.toBe("old-token");
    expect(loadRoom(room.id, COORDINATOR)?.inviteToken).toBe(room.inviteToken);
    expect(isCurrentInviteRequest(room.inviteToken, { invite_token: "old-token" })).toBe(false);
  });
});
