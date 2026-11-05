import { beforeAll, describe, expect, test, vi } from "vitest";
import type { KeyPackage, Welcome } from "ts-mls";

import {
  addMember,
  createKeyPackage,
  createRoomState,
} from "../src/client/protocol.js";
import {
  InMemoryCoordinatorStorage,
  type CoordinatorStorageSnapshot,
} from "../src/coordinator/storage/inMemoryStorage.js";
import {
  MAX_PENDING_JOIN_REQUESTS_PER_GROUP,
  ROOM_DELETED_BY_HOST_ERROR,
} from "../src/coordinator/storage/storage.js";
import type {
  JoinRequestRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../src/coordinator/types.js";
import {
  decodeWelcome,
  encodeKeyPackage,
  encodeWelcome,
} from "../src/mls/mlsCodec.js";
import { decodeBase64, encodeBase64 } from "../src/server/base64.js";

const ALICE = "aa".repeat(32);
const BOB = "bb".repeat(32);

let realKeyPackage: KeyPackage;
let realWelcome: Welcome;

beforeAll(async () => {
  const host = await createKeyPackage("12".repeat(32));
  const guest = await createKeyPackage("34".repeat(32));
  realKeyPackage = guest.keyPackage;
  const state = await createRoomState(host.keyPackage, host.privateKeyPackage);
  const { welcomeBase64 } = await addMember(state, guest.stored.publicBase64);
  realWelcome = decodeWelcome(decodeBase64(welcomeBase64));
});

function keyPackageRecord(
  keyPackageRef: string,
  options: { stablePubkey?: string; isLastResort?: boolean } = {},
): PublishedKeyPackageRecord {
  const stablePubkey = options.stablePubkey ?? ALICE;
  return {
    stablePubkey,
    keyPackage: realKeyPackage,
    keyPackageRef,
    isLastResort: options.isLastResort ?? false,
    publishedAt: 10,
    publicationEvent: {
      id: `event-${keyPackageRef}`,
      pubkey: stablePubkey,
      created_at: 1,
      kind: 1,
      tags: [["t", keyPackageRef]],
      content: "{}",
      sig: "sig",
    },
  };
}

function welcomeRecord(
  keyPackageReference: string,
  createdAt: number,
  overrides: Partial<WelcomeQueueRecord> = {},
): WelcomeQueueRecord {
  return {
    targetStablePubkey: ALICE,
    keyPackageReference,
    welcome: realWelcome,
    createdAt,
    readAt: null,
    ...overrides,
  };
}

function joinRequest(
  requesterStablePubkey: string,
  createdAt: number,
  overrides: Partial<JoinRequestRecord> = {},
): JoinRequestRecord {
  return {
    groupId: "group-a",
    requesterStablePubkey,
    keyPackageRef: `kp-${requesterStablePubkey}`,
    createdAt,
    readAt: null,
    ...overrides,
  };
}

function appendMessage(
  storage: InMemoryCoordinatorStorage,
  groupId: string,
  opaqueMessage: Uint8Array,
  epoch = 0n,
) {
  return storage.appendGroupMessage({
    groupId,
    latestHandshakeEpoch: epoch,
    epoch,
    ephemeralSenderPubkey: "sender",
    opaqueMessage,
    createdAt: 100,
  });
}

/** Snapshots are persisted as JSON, so a round trip has to survive JSON too. */
function throughJson(snapshot: CoordinatorStorageSnapshot): CoordinatorStorageSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as CoordinatorStorageSnapshot;
}

function emptySnapshot(
  overrides: Partial<CoordinatorStorageSnapshot> = {},
): CoordinatorStorageSnapshot {
  return {
    version: 1,
    keyPackages: [],
    welcomes: [],
    joinRequests: [],
    groups: [],
    ...overrides,
  };
}

describe("key packages", () => {
  test("lists by identity and across identities, and is empty for strangers", () => {
    const storage = new InMemoryCoordinatorStorage();
    const first = storage.publishKeyPackage(keyPackageRecord("kp-1"));
    const second = storage.publishKeyPackage(keyPackageRecord("kp-2"));
    const other = storage.publishKeyPackage(keyPackageRecord("kp-3", { stablePubkey: BOB }));

    expect(storage.listKeyPackagesForIdentity(ALICE)).toEqual([first, second]);
    expect(storage.listKeyPackagesForIdentity(BOB)).toEqual([other]);
    expect(storage.listKeyPackagesForIdentity("stranger")).toEqual([]);
    expect(storage.listAllKeyPackages()).toEqual([first, second, other]);
    expect(storage.getKeyPackage("kp-3")).toBe(other);
    expect(storage.getKeyPackage("missing")).toBeNull();
  });

  test("removes one package, keeps its siblings, and forgets an emptied identity", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    const first = storage.publishKeyPackage(keyPackageRecord("kp-1"));
    const second = storage.publishKeyPackage(keyPackageRecord("kp-2"));
    onChange.mockClear();

    expect(storage.removeKeyPackage("missing")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    expect(storage.removeKeyPackage("kp-1")).toBe(first);
    expect(storage.listKeyPackagesForIdentity(ALICE)).toEqual([second]);
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(storage.removeKeyPackage("kp-2")).toBe(second);
    expect(storage.listKeyPackagesForIdentity(ALICE)).toEqual([]);
    expect(storage.toSnapshot().keyPackages).toEqual([]);
  });

  test("consumes ordinary packages oldest first, then reuses the newest last-resort package", () => {
    const storage = new InMemoryCoordinatorStorage();
    storage.publishKeyPackage(keyPackageRecord("lr-old", { isLastResort: true }));
    storage.publishKeyPackage(keyPackageRecord("ordinary-1"));
    storage.publishKeyPackage(keyPackageRecord("lr-new", { isLastResort: true }));
    storage.publishKeyPackage(keyPackageRecord("ordinary-2"));

    expect(storage.consumeKeyPackage(ALICE)?.keyPackageRef).toBe("ordinary-1");
    expect(storage.consumeKeyPackage(ALICE)?.keyPackageRef).toBe("ordinary-2");
    expect(storage.consumeKeyPackage(ALICE)?.keyPackageRef).toBe("lr-new");
    expect(storage.consumeKeyPackage(ALICE)?.keyPackageRef).toBe("lr-new");
    expect(storage.listKeyPackagesForIdentity(ALICE).map((record) => record.keyPackageRef))
      .toEqual(["lr-old", "lr-new"]);
  });

  test("consuming by reference removes ordinary packages but never last-resort packages", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    storage.publishKeyPackage(keyPackageRecord("ordinary"));
    storage.publishKeyPackage(keyPackageRecord("lr", { isLastResort: true }));
    onChange.mockClear();

    expect(storage.consumeKeyPackage("lr")?.keyPackageRef).toBe("lr");
    expect(storage.getKeyPackage("lr")).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    expect(storage.consumeKeyPackage("ordinary")?.keyPackageRef).toBe("ordinary");
    expect(storage.getKeyPackage("ordinary")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("consuming an unknown identifier returns null", () => {
    expect(new InMemoryCoordinatorStorage().consumeKeyPackage("unknown")).toBeNull();
  });
});

describe("welcomes", () => {
  test("marks unread welcomes read once and keeps the original read time on re-take", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    const input = welcomeRecord("kp-1", 5);
    const stored = storage.storeWelcome(input);
    storage.storeWelcome(welcomeRecord("kp-b", 6, { targetStablePubkey: BOB }));

    expect(stored).not.toBe(input);
    expect(input.readAt).toBeNull();
    onChange.mockClear();

    expect(storage.fetchPendingWelcomes(ALICE, 50)).toMatchObject([
      { keyPackageReference: "kp-1", readAt: 50 },
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(storage.fetchPendingWelcomes(ALICE, 90)).toMatchObject([
      { keyPackageReference: "kp-1", readAt: 50 },
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(storage.fetchPendingWelcomes("stranger", 90)).toEqual([]);
  });

  test("retires only the acknowledged welcome and leaves a same-reference retry pending", () => {
    const storage = new InMemoryCoordinatorStorage();
    storage.storeWelcome(welcomeRecord("reused-last-resort", 5));
    storage.storeWelcome(welcomeRecord("reused-last-resort", 6));
    storage.storeWelcome(welcomeRecord("other", 5));
    storage.fetchPendingWelcomes(ALICE, 50);

    const remaining = storage.fetchPendingWelcomes(ALICE, 70, [
      { keyPackageReference: "reused-last-resort", createdAt: 5 },
    ]);

    expect(remaining.map((record) => [record.keyPackageReference, record.createdAt])).toEqual([
      ["reused-last-resort", 6],
      ["other", 5],
    ]);
    expect(remaining.map((record) => record.readAt)).toEqual([50, 50]);
    expect(storage.toSnapshot().welcomes).toHaveLength(2);
  });

  test("persists an acknowledgement that empties the queue", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    storage.storeWelcome(welcomeRecord("kp-1", 5));
    storage.fetchPendingWelcomes(ALICE, 50);
    onChange.mockClear();

    expect(
      storage.fetchPendingWelcomes(ALICE, 60, [{ keyPackageReference: "kp-1", createdAt: 5 }]),
    ).toEqual([]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(storage.toSnapshot().welcomes).toEqual([]);
  });

  test("ignores acknowledgements that match nothing without persisting", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    storage.storeWelcome(welcomeRecord("kp-1", 5));
    storage.fetchPendingWelcomes(ALICE, 50);
    onChange.mockClear();

    const records = storage.fetchPendingWelcomes(ALICE, 60, [
      { keyPackageReference: "kp-1", createdAt: 999 },
      { keyPackageReference: "other", createdAt: 5 },
    ]);

    expect(records).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("expires read welcomes by read time and unread welcomes by age, keeping boundaries", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    storage.storeWelcome(welcomeRecord("read-old", 1, { readAt: 99 }));
    storage.storeWelcome(welcomeRecord("read-boundary", 1, { readAt: 100 }));
    storage.storeWelcome(welcomeRecord("unread-old", 49));
    storage.storeWelcome(welcomeRecord("unread-boundary", 50));
    storage.storeWelcome(welcomeRecord("bob-only", 1, { targetStablePubkey: BOB, readAt: 1 }));
    onChange.mockClear();

    expect(storage.deleteExpiredWelcomes(100, 50)).toBe(3);

    expect(storage.toSnapshot().welcomes.map((record) => record.keyPackageReference)).toEqual([
      "read-boundary",
      "unread-boundary",
    ]);
    expect(storage.fetchPendingWelcomes(BOB, 200)).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("does not persist when nothing expired, and threshold 0 keeps unread welcomes", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    storage.storeWelcome(welcomeRecord("unread", 1));
    onChange.mockClear();

    expect(storage.deleteExpiredWelcomes(1_000, 0)).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("join requests", () => {
  test("keeps the read time on re-take and returns nothing for an unknown group", () => {
    const storage = new InMemoryCoordinatorStorage();
    const input = joinRequest(ALICE, 5, { inviteToken: "token" });
    const stored = storage.storeJoinRequest(input);

    expect(stored).not.toBe(input);
    expect(storage.fetchPendingJoinRequests("group-a", 50)).toMatchObject([
      { requesterStablePubkey: ALICE, inviteToken: "token", readAt: 50 },
    ]);
    expect(storage.fetchPendingJoinRequests("group-a", 90)).toMatchObject([{ readAt: 50 }]);
    expect(storage.fetchPendingJoinRequests("unknown", 90)).toEqual([]);
  });

  test("refreshes a retry in place so a stale acknowledgement cannot discard it", () => {
    const storage = new InMemoryCoordinatorStorage();
    storage.storeJoinRequest(joinRequest(ALICE, 5, { inviteToken: "old", keyPackageRef: "kp-old" }));
    storage.fetchPendingJoinRequests("group-a", 6);

    const retried = storage.storeJoinRequest(
      joinRequest(ALICE, 9, { inviteToken: "new", keyPackageRef: "kp-new" }),
    );

    expect(retried).toEqual(
      joinRequest(ALICE, 9, { inviteToken: "new", keyPackageRef: "kp-new" }),
    );

    // A host that already recorded the first request acknowledges it.
    const pending = storage.fetchPendingJoinRequests("group-a", 10, [
      { requesterStablePubkey: ALICE, createdAt: 5 },
    ]);
    expect(pending).toEqual([
      joinRequest(ALICE, 9, { inviteToken: "new", keyPackageRef: "kp-new", readAt: 10 }),
    ]);

    // Acknowledging the refreshed request retires it, and is persisted empty.
    expect(
      storage.fetchPendingJoinRequests("group-a", 11, [
        { requesterStablePubkey: ALICE, createdAt: 9 },
      ]),
    ).toEqual([]);
    expect(storage.toSnapshot().joinRequests).toEqual([]);
  });

  test("caps new requesters per group, still allows retries, and reopens after an ack", () => {
    const storage = new InMemoryCoordinatorStorage();
    for (let index = 0; index < MAX_PENDING_JOIN_REQUESTS_PER_GROUP; index += 1) {
      storage.storeJoinRequest(joinRequest(`requester-${index}`, index));
    }

    expect(() => storage.storeJoinRequest(joinRequest("one-too-many", 500))).toThrow(
      "Too many pending join requests for this group",
    );
    expect(() =>
      storage.storeJoinRequest(joinRequest("elsewhere", 500, { groupId: "group-b" })),
    ).not.toThrow();
    expect(storage.storeJoinRequest(joinRequest("requester-0", 501)).createdAt).toBe(501);

    // As upstream, read but unacknowledged requests still occupy a slot.
    storage.fetchPendingJoinRequests("group-a", 600);
    expect(() => storage.storeJoinRequest(joinRequest("one-too-many", 601))).toThrow(
      "Too many pending join requests for this group",
    );

    storage.fetchPendingJoinRequests("group-a", 602, [
      { requesterStablePubkey: "requester-1", createdAt: 1 },
    ]);
    expect(storage.storeJoinRequest(joinRequest("one-too-many", 603)).createdAt).toBe(603);
  });

  test("fetches many in input group order and applies acknowledgements per group", () => {
    const storage = new InMemoryCoordinatorStorage();
    storage.storeJoinRequest(joinRequest(ALICE, 1, { groupId: "group-a" }));
    storage.storeJoinRequest(joinRequest(BOB, 2, { groupId: "group-a" }));
    storage.storeJoinRequest(joinRequest(ALICE, 1, { groupId: "group-b" }));

    expect(
      storage
        .fetchManyPendingJoinRequests({ groups: [{ groupId: "group-b" }, { groupId: "group-a" }] }, 10)
        .map((record) => [record.groupId, record.requesterStablePubkey]),
    ).toEqual([
      ["group-b", ALICE],
      ["group-a", ALICE],
      ["group-a", BOB],
    ]);

    const remaining = storage.fetchManyPendingJoinRequests(
      {
        groups: [{ groupId: "group-a" }, { groupId: "group-b" }],
        consumed: [{ groupId: "group-a", requesterStablePubkey: ALICE, createdAt: 1 }],
      },
      20,
    );

    expect(remaining.map((record) => [record.groupId, record.requesterStablePubkey])).toEqual([
      ["group-a", BOB],
      ["group-b", ALICE],
    ]);
    expect(remaining.map((record) => record.readAt)).toEqual([10, 10]);
  });

  test("expires read requests by read time and unread requests by age, keeping boundaries", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);
    storage.storeJoinRequest(joinRequest("read-old", 1, { readAt: 99 }));
    storage.storeJoinRequest(joinRequest("read-boundary", 1, { readAt: 100 }));
    storage.storeJoinRequest(joinRequest("unread-old", 49));
    storage.storeJoinRequest(joinRequest("unread-boundary", 50));
    storage.storeJoinRequest(joinRequest(ALICE, 1, { groupId: "group-b", readAt: 1 }));
    onChange.mockClear();

    expect(storage.deleteExpiredJoinRequests(100, 50)).toBe(3);

    expect(storage.toSnapshot().joinRequests.map((record) => record.requesterStablePubkey))
      .toEqual(["read-boundary", "unread-boundary"]);
    expect(onChange).toHaveBeenCalledTimes(1);

    onChange.mockClear();
    expect(storage.deleteExpiredJoinRequests(100, 50)).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("group messages", () => {
  test("scopes cursors to a group and tracks routing", () => {
    const storage = new InMemoryCoordinatorStorage();
    expect(storage.getGroupRouting("group-a")).toBeNull();

    expect(appendMessage(storage, "group-a", Uint8Array.of(1), 3n).cursor).toBe(1);
    expect(appendMessage(storage, "group-a", Uint8Array.of(2), 4n).cursor).toBe(2);
    expect(appendMessage(storage, "group-b", Uint8Array.of(3)).cursor).toBe(1);

    expect(storage.getGroupRouting("group-a")).toEqual({
      groupId: "group-a",
      latestHandshakeEpoch: 4n,
      lastMessageCursor: 2,
    });
    expect(storage.getGroupRouting("group-b")?.lastMessageCursor).toBe(1);
  });

  test("filters by cursor and by epoch, with epoch zero meaning everything", () => {
    const storage = new InMemoryCoordinatorStorage();
    appendMessage(storage, "group-a", Uint8Array.of(1), 1n);
    appendMessage(storage, "group-a", Uint8Array.of(2), 2n);
    appendMessage(storage, "group-a", Uint8Array.of(3), 3n);
    const cursors = (input: { afterCursor?: number; sinceEpoch?: bigint }) =>
      storage.fetchGroupMessages({ groupId: "group-a", ...input }).map((record) => record.cursor);

    expect(cursors({})).toEqual([1, 2, 3]);
    expect(cursors({ afterCursor: 0 })).toEqual([1, 2, 3]);
    expect(cursors({ afterCursor: 2 })).toEqual([3]);
    expect(cursors({ sinceEpoch: 0n })).toEqual([1, 2, 3]);
    expect(cursors({ sinceEpoch: 2n })).toEqual([2, 3]);
    expect(cursors({ sinceEpoch: 2n, afterCursor: 2 })).toEqual([3]);
    expect(storage.fetchGroupMessages({ groupId: "unknown" })).toEqual([]);
  });

  test("fetches many in input group order with independent cursors", () => {
    const storage = new InMemoryCoordinatorStorage();
    appendMessage(storage, "group-a", Uint8Array.of(1));
    appendMessage(storage, "group-a", Uint8Array.of(2));
    appendMessage(storage, "group-b", Uint8Array.of(3));

    expect(
      storage
        .fetchManyGroupMessages({
          groups: [{ groupId: "group-b" }, { groupId: "group-a", afterCursor: 1 }],
        })
        .map((record) => [record.groupId, record.cursor]),
    ).toEqual([
      ["group-b", 1],
      ["group-a", 2],
    ]);
  });
});

describe("deleted-group tombstones", () => {
  test("rejects every further use of a deleted group and removes what it held", () => {
    const storage = new InMemoryCoordinatorStorage();
    appendMessage(storage, "doomed", Uint8Array.of(1));
    storage.storeJoinRequest(joinRequest(ALICE, 1, { groupId: "doomed" }));
    expect(storage.isGroupDeleted("doomed")).toBe(false);

    storage.deleteGroup("doomed");

    expect(storage.isGroupDeleted("doomed")).toBe(true);
    expect(storage.getGroupRouting("doomed")).toBeNull();
    expect(storage.fetchPendingJoinRequests("doomed", 1)).toEqual([]);
    expect(() => appendMessage(storage, "doomed", Uint8Array.of(2))).toThrow(
      ROOM_DELETED_BY_HOST_ERROR,
    );
    expect(() => storage.storeJoinRequest(joinRequest(ALICE, 2, { groupId: "doomed" }))).toThrow(
      ROOM_DELETED_BY_HOST_ERROR,
    );
    expect(() => storage.fetchGroupMessages({ groupId: "doomed" })).toThrow(
      ROOM_DELETED_BY_HOST_ERROR,
    );
    expect(() =>
      storage.fetchManyGroupMessages({ groups: [{ groupId: "fine" }, { groupId: "doomed" }] }),
    ).toThrow(ROOM_DELETED_BY_HOST_ERROR);
  });

  test("persists only the first deletion of a group", () => {
    const onChange = vi.fn();
    const storage = new InMemoryCoordinatorStorage(null, onChange);

    storage.deleteGroup("doomed");
    storage.deleteGroup("doomed");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ deletedGroups: ["doomed"] });
  });
});

describe("snapshots", () => {
  test("round trips every record type through JSON, including bigints and bytes", () => {
    const hugeEpoch = 2n ** 60n + 1n;
    const bytes = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    const original = new InMemoryCoordinatorStorage();
    original.publishKeyPackage(keyPackageRecord("kp-ordinary"));
    original.publishKeyPackage(keyPackageRecord("kp-lr", { isLastResort: true }));
    original.storeWelcome(welcomeRecord("kp-welcome", 7, { joinAfterCursor: 4, readAt: 8 }));
    original.storeJoinRequest(joinRequest(BOB, 9, { inviteToken: "token" }));
    appendMessage(original, "group-a", bytes, hugeEpoch);
    original.deleteGroup("group-z");
    original.deleteGroup("group-y");

    const snapshot = throughJson(original.toSnapshot());
    const restored = new InMemoryCoordinatorStorage(snapshot);

    expect(snapshot.deletedGroups).toEqual(["group-y", "group-z"]);
    expect(restored.toSnapshot()).toEqual(original.toSnapshot());

    const [message] = restored.fetchGroupMessages({ groupId: "group-a" });
    expect(message?.opaqueMessage).toBeInstanceOf(Uint8Array);
    expect(message?.opaqueMessage).toEqual(bytes);
    expect(message?.epoch).toBe(hugeEpoch);
    expect(restored.getGroupRouting("group-a")).toEqual({
      groupId: "group-a",
      latestHandshakeEpoch: hugeEpoch,
      lastMessageCursor: 1,
    });

    const keyPackage = restored.getKeyPackage("kp-lr");
    expect(keyPackage?.isLastResort).toBe(true);
    expect(keyPackage?.publicationEvent.tags).toEqual([["t", "kp-lr"]]);
    expect(encodeKeyPackage(keyPackage!.keyPackage)).toEqual(encodeKeyPackage(realKeyPackage));

    const [welcome] = restored.fetchPendingWelcomes(ALICE, 100);
    expect(welcome).toMatchObject({ createdAt: 7, readAt: 8, joinAfterCursor: 4 });
    expect(encodeWelcome(welcome!.welcome)).toEqual(encodeWelcome(realWelcome));

    expect(restored.fetchPendingJoinRequests("group-a", 100)).toMatchObject([
      { requesterStablePubkey: BOB, inviteToken: "token", createdAt: 9 },
    ]);
    expect(restored.isGroupDeleted("group-z")).toBe(true);
  });

  test("continues allocating cursors after a restore", () => {
    const original = new InMemoryCoordinatorStorage();
    appendMessage(original, "group-a", Uint8Array.of(1));
    appendMessage(original, "group-a", Uint8Array.of(2));

    const restored = new InMemoryCoordinatorStorage(throughJson(original.toSnapshot()));

    expect(appendMessage(restored, "group-a", Uint8Array.of(3)).cursor).toBe(3);
  });

  test("restores an empty opaque message instead of bricking the whole snapshot", () => {
    const original = new InMemoryCoordinatorStorage();
    appendMessage(original, "group-a", new Uint8Array());
    appendMessage(original, "group-a", Uint8Array.of(9));

    const restored = new InMemoryCoordinatorStorage(throughJson(original.toSnapshot()));

    expect(
      restored.fetchGroupMessages({ groupId: "group-a" }).map((record) => record.opaqueMessage),
    ).toEqual([new Uint8Array(), Uint8Array.of(9)]);
  });

  test("uses the legacy afterCursor only when joinAfterCursor is absent", () => {
    const welcome64 = encodeBase64(encodeWelcome(realWelcome));
    const shared = {
      targetStablePubkey: ALICE,
      welcome64,
      createdAt: 1,
      readAt: null,
    };
    const restored = new InMemoryCoordinatorStorage(
      emptySnapshot({
        welcomes: [
          { ...shared, keyPackageReference: "legacy", afterCursor: 11 },
          { ...shared, keyPackageReference: "both", joinAfterCursor: 22, afterCursor: 11 },
          { ...shared, keyPackageReference: "neither" },
        ],
      }),
    );

    expect(restored.toSnapshot().welcomes.map((record) => record.joinAfterCursor)).toEqual([
      11, 22, undefined,
    ]);
  });

  test("drops logs and requests of tombstoned groups on restore", () => {
    const source = new InMemoryCoordinatorStorage();
    appendMessage(source, "doomed", Uint8Array.of(1));
    appendMessage(source, "kept", Uint8Array.of(2));
    source.storeJoinRequest(joinRequest(ALICE, 1, { groupId: "doomed" }));
    source.storeJoinRequest(joinRequest(ALICE, 1, { groupId: "kept" }));
    const snapshot = source.toSnapshot();
    snapshot.deletedGroups = ["doomed"];

    const restored = new InMemoryCoordinatorStorage(snapshot);

    expect(restored.getGroupRouting("doomed")).toBeNull();
    expect(restored.fetchPendingJoinRequests("doomed", 5)).toEqual([]);
    expect(restored.getGroupRouting("kept")).not.toBeNull();
    expect(restored.fetchPendingJoinRequests("kept", 5)).toHaveLength(1);
  });

  test("restoring does not report a change, and later mutations do", () => {
    const onChange = vi.fn();
    const restored = new InMemoryCoordinatorStorage(emptySnapshot(), onChange);
    expect(onChange).not.toHaveBeenCalled();

    appendMessage(restored, "group-a", Uint8Array.of(1));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(restored.toSnapshot());
  });

  test("surfaces a failing persistence callback to the caller", () => {
    const storage = new InMemoryCoordinatorStorage(null, () => {
      throw new Error("quota exceeded");
    });

    expect(() => appendMessage(storage, "group-a", Uint8Array.of(1))).toThrow("quota exceeded");
  });

  describe("rejects malformed snapshots", () => {
    const groupWith = (overrides: {
      latestHandshakeEpoch?: string;
      epoch?: string;
      opaqueMessage64?: string;
    }) => ({
      groupId: "group-a",
      nextCursor: 2,
      routing: {
        groupId: "group-a",
        latestHandshakeEpoch: overrides.latestHandshakeEpoch ?? "0",
        lastMessageCursor: 1,
      },
      messages: [
        {
          cursor: 1,
          groupId: "group-a",
          epoch: overrides.epoch ?? "0",
          ephemeralSenderPubkey: "sender",
          opaqueMessage64: overrides.opaqueMessage64 ?? "AQ==",
          createdAt: 1,
        },
      ],
    });
    const keyPackageWith = (keyPackage64: string) => ({
      stablePubkey: ALICE,
      keyPackageRef: "kp",
      isLastResort: false,
      publishedAt: 1,
      publicationEvent: keyPackageRecord("kp").publicationEvent,
      keyPackage64,
    });
    const welcomeWith = (welcome64: string) => ({
      targetStablePubkey: ALICE,
      keyPackageReference: "kp",
      welcome64,
      createdAt: 1,
      readAt: null,
    });

    test("an unsupported version", () => {
      expect(
        () =>
          new InMemoryCoordinatorStorage({
            ...emptySnapshot(),
            version: 2,
          } as unknown as CoordinatorStorageSnapshot),
      ).toThrow("Unsupported coordinator storage snapshot");
    });

    test("missing record arrays", () => {
      expect(
        () => new InMemoryCoordinatorStorage({ version: 1 } as unknown as CoordinatorStorageSnapshot),
      ).toThrow(TypeError);
    });

    test("invalid base64 and non-numeric epochs in a group log", () => {
      expect(
        () =>
          new InMemoryCoordinatorStorage(
            emptySnapshot({ groups: [groupWith({ opaqueMessage64: "not base64!" })] }),
          ),
      ).toThrow("Invalid base64 payload");
      expect(
        () => new InMemoryCoordinatorStorage(emptySnapshot({ groups: [groupWith({ epoch: "abc" })] })),
      ).toThrow(SyntaxError);
      expect(
        () =>
          new InMemoryCoordinatorStorage(
            emptySnapshot({ groups: [groupWith({ latestHandshakeEpoch: "abc" })] }),
          ),
      ).toThrow(SyntaxError);
    });

    test("bytes that do not decode as a key package", () => {
      expect(
        () =>
          new InMemoryCoordinatorStorage(
            emptySnapshot({ keyPackages: [keyPackageWith(encodeBase64(Uint8Array.of(1, 2, 3)))] }),
          ),
      ).toThrow("Invalid key package");
    });

    test("a key package where a welcome belongs", () => {
      expect(
        () =>
          new InMemoryCoordinatorStorage(
            emptySnapshot({
              welcomes: [welcomeWith(encodeBase64(encodeKeyPackage(realKeyPackage)))],
            }),
          ),
      ).toThrow("Invalid welcome");
    });
  });

  test("close is a safe no-op", () => {
    const storage = new InMemoryCoordinatorStorage();
    appendMessage(storage, "group-a", Uint8Array.of(1));

    expect(() => storage.close()).not.toThrow();
    expect(storage.fetchGroupMessages({ groupId: "group-a" })).toHaveLength(1);
  });
});
