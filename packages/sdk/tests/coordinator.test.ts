import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { NostrEvent } from "nostr-tools";
import type { KeyPackage, Welcome } from "ts-mls";

import {
  addMember,
  createKeyPackage,
  createRoomState,
} from "../src/client/protocol.js";
import { Coordinator, createCoordinator } from "../src/coordinator/coordinator.js";
import { InMemoryCoordinatorStorage } from "../src/coordinator/storage/inMemoryStorage.js";
import {
  ROOM_DELETED_BY_HOST_ERROR,
  type CoordinatorStorage,
} from "../src/coordinator/storage/storage.js";
import type { GroupMessageRecord, JoinRequestRecord } from "../src/coordinator/types.js";
import { decodeWelcome } from "../src/mls/mlsCodec.js";
import { decodeBase64 } from "../src/server/base64.js";

const ALICE = "aa".repeat(32);
const BOB = "bb".repeat(32);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EVENT = { id: "event" } as NostrEvent;

let ordinaryKeyPackage: KeyPackage;
let lastResortKeyPackage: KeyPackage;
let welcome: Welcome;

beforeAll(async () => {
  const host = await createKeyPackage("12".repeat(32));
  const guest = await createKeyPackage(ALICE);
  ordinaryKeyPackage = guest.keyPackage;
  lastResortKeyPackage = (await createKeyPackage(ALICE, { lastResort: true })).keyPackage;
  const state = await createRoomState(host.keyPackage, host.privateKeyPackage);
  const { welcomeBase64 } = await addMember(state, guest.stored.publicBase64);
  welcome = decodeWelcome(decodeBase64(welcomeBase64));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A coordinator without the background cleanup timer. */
function createQuietCoordinator(
  storage: CoordinatorStorage = new InMemoryCoordinatorStorage(),
  now: () => number = () => 1_000,
): Coordinator {
  return new Coordinator({ storage, now, welcomeCleanupIntervalMs: 0 });
}

function post(coordinator: Coordinator, groupId: string, byte = 1): GroupMessageRecord {
  return coordinator.postGroupMessage({
    groupId,
    ephemeralSenderPubkey: "sender",
    opaqueMessage: Uint8Array.of(byte),
  });
}

function storeRequest(coordinator: Coordinator, groupId = "group-a", requester = ALICE) {
  return coordinator.storeJoinRequest({
    groupId,
    requesterStablePubkey: requester,
    keyPackageRef: `kp-${requester}`,
  });
}

/** Resolves whatever the iterator produces next, without waiting past a tick. */
async function takeCursors(messages: AsyncIterable<GroupMessageRecord>, count: number) {
  const iterator = messages[Symbol.asyncIterator]();
  const cursors: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await iterator.next();
    if (result.done) break;
    cursors.push(result.value.cursor);
  }
  return cursors;
}

describe("key packages", () => {
  test("derives the last-resort flag from the package and stamps publication time", () => {
    const coordinator = createQuietCoordinator();

    const ordinary = coordinator.publishKeyPackage({
      stablePubkey: ALICE,
      keyPackage: ordinaryKeyPackage,
      keyPackageRef: "ordinary",
      publicationEvent: EVENT,
    });
    const lastResort = coordinator.publishKeyPackage({
      stablePubkey: ALICE,
      keyPackage: lastResortKeyPackage,
      keyPackageRef: "last-resort",
      publicationEvent: EVENT,
    });

    expect(ordinary).toMatchObject({ isLastResort: false, publishedAt: 1_000 });
    expect(lastResort).toMatchObject({ isLastResort: true, publishedAt: 1_000 });
    expect(coordinator.listAllKeyPackages()).toEqual([ordinary, lastResort]);
    expect(coordinator.listKeyPackagesForIdentity(ALICE)).toEqual([ordinary, lastResort]);
    expect(coordinator.getKeyPackage("ordinary")).toBe(ordinary);
  });

  test("hands out the ordinary package before reusing the last-resort package", () => {
    const coordinator = createQuietCoordinator();
    coordinator.publishKeyPackage({
      stablePubkey: ALICE,
      keyPackage: lastResortKeyPackage,
      keyPackageRef: "last-resort",
      publicationEvent: EVENT,
    });
    coordinator.publishKeyPackage({
      stablePubkey: ALICE,
      keyPackage: ordinaryKeyPackage,
      keyPackageRef: "ordinary",
      publicationEvent: EVENT,
    });

    expect(coordinator.consumeKeyPackage(ALICE)?.keyPackageRef).toBe("ordinary");
    expect(coordinator.consumeKeyPackage(ALICE)?.keyPackageRef).toBe("last-resort");
    expect(coordinator.consumeKeyPackage(ALICE)?.keyPackageRef).toBe("last-resort");
  });

  test("removes a package by reference", () => {
    const coordinator = createQuietCoordinator();
    coordinator.publishKeyPackage({
      stablePubkey: ALICE,
      keyPackage: ordinaryKeyPackage,
      keyPackageRef: "ordinary",
      publicationEvent: EVENT,
    });

    expect(coordinator.removeKeyPackage("ordinary")?.keyPackageRef).toBe("ordinary");
    expect(coordinator.removeKeyPackage("ordinary")).toBeNull();
    expect(coordinator.getKeyPackage("ordinary")).toBeNull();
  });
});

describe("welcomes", () => {
  test("stamps creation and read time from the injected clock and honours acknowledgements", () => {
    let now = 10;
    const coordinator = createQuietCoordinator(new InMemoryCoordinatorStorage(), () => now);

    const stored = coordinator.storeWelcome({
      targetStablePubkey: ALICE,
      keyPackageReference: "kp",
      welcome,
      joinAfterCursor: 3,
    });
    expect(stored).toMatchObject({ createdAt: 10, readAt: null, joinAfterCursor: 3 });

    now = 20;
    expect(coordinator.fetchPendingWelcomes(ALICE)).toMatchObject([{ readAt: 20 }]);

    now = 30;
    expect(coordinator.fetchPendingWelcomes(ALICE)).toMatchObject([{ readAt: 20 }]);
    expect(
      coordinator.fetchPendingWelcomes(ALICE, [{ keyPackageReference: "kp", createdAt: 10 }]),
    ).toEqual([]);
  });

  test("expires through the coordinator with explicit thresholds", () => {
    const coordinator = createQuietCoordinator();
    coordinator.storeWelcome({ targetStablePubkey: ALICE, keyPackageReference: "kp", welcome });

    expect(coordinator.deleteExpiredWelcomes(0, 1_000)).toBe(0);
    expect(coordinator.deleteExpiredWelcomes(0, 1_001)).toBe(1);
  });
});

describe("join requests", () => {
  test("stores with the injected clock, keeps an invite token, and re-takes with acks", () => {
    let now = 10;
    const coordinator = createQuietCoordinator(new InMemoryCoordinatorStorage(), () => now);

    const stored = coordinator.storeJoinRequest({
      groupId: "group-a",
      requesterStablePubkey: ALICE,
      keyPackageRef: "kp",
      inviteToken: "token",
    });
    expect(stored).toMatchObject({ createdAt: 10, readAt: null, inviteToken: "token" });

    now = 20;
    expect(coordinator.fetchPendingJoinRequests("group-a")).toMatchObject([{ readAt: 20 }]);

    now = 30;
    expect(
      coordinator.fetchManyPendingJoinRequests({ groups: [{ groupId: "group-a" }] }),
    ).toMatchObject([{ readAt: 20 }]);
    expect(
      coordinator.fetchManyPendingJoinRequests({
        groups: [{ groupId: "group-a" }],
        consumed: [{ groupId: "group-a", requesterStablePubkey: ALICE, createdAt: 10 }],
      }),
    ).toEqual([]);
  });

  test("expires through the coordinator with explicit thresholds", () => {
    const coordinator = createQuietCoordinator();
    storeRequest(coordinator);

    expect(coordinator.deleteExpiredJoinRequests(0, 1_000)).toBe(0);
    expect(coordinator.deleteExpiredJoinRequests(0, 1_001)).toBe(1);
  });

  test("notifies only the subscribers of the request's group", () => {
    const coordinator = createQuietCoordinator();
    const inGroup = vi.fn();
    const inGroupToo = vi.fn();
    const elsewhere = vi.fn();
    coordinator.subscribeJoinRequests("group-a", inGroup);
    coordinator.subscribeJoinRequests("group-a", inGroupToo);
    coordinator.subscribeJoinRequests("group-b", elsewhere);

    const stored = storeRequest(coordinator);

    expect(inGroup).toHaveBeenCalledWith(stored);
    expect(inGroupToo).toHaveBeenCalledWith(stored);
    expect(elsewhere).not.toHaveBeenCalled();
  });

  test("waits for the listeners started by this exact request", async () => {
    const coordinator = createQuietCoordinator();
    let finishListener!: () => void;
    coordinator.subscribeJoinRequests(
      "group-a",
      () => new Promise<void>((resolve) => { finishListener = resolve; }),
    );
    const stored = storeRequest(coordinator);

    let settled = false;
    const waiting = coordinator.waitForJoinRequestNotifications(stored).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    finishListener();
    await waiting;
    expect(settled).toBe(true);
  });

  test("waits on nothing for a request this coordinator did not notify about", async () => {
    const coordinator = createQuietCoordinator();
    const foreign = { groupId: "group-a" } as JoinRequestRecord;

    await expect(coordinator.waitForJoinRequestNotifications(foreign)).resolves.toBeUndefined();
  });

  test("keeps the request and reports a listener that throws or rejects to the waiter", async () => {
    const coordinator = createQuietCoordinator();
    const after = vi.fn();
    coordinator.subscribeJoinRequests("sync", () => {
      throw new Error("sync listener failed");
    });
    coordinator.subscribeJoinRequests("sync", after);
    coordinator.subscribeJoinRequests("async", () => Promise.reject(new Error("async listener failed")));

    const syncRecord = storeRequest(coordinator, "sync");
    const asyncRecord = storeRequest(coordinator, "async");

    expect(after).toHaveBeenCalledOnce();
    expect(coordinator.fetchPendingJoinRequests("sync")).toHaveLength(1);
    await expect(coordinator.waitForJoinRequestNotifications(syncRecord)).rejects.toThrow(
      "sync listener failed",
    );
    await expect(coordinator.waitForJoinRequestNotifications(asyncRecord)).rejects.toThrow(
      "async listener failed",
    );
  });

  test("a failing listener is not an unhandled rejection when nobody waits", async () => {
    const coordinator = createQuietCoordinator();
    coordinator.subscribeJoinRequests("group-a", () => Promise.reject(new Error("nobody waits")));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      storeRequest(coordinator);
      // unhandledRejection fires after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  test("stops notifying after unsubscribe", () => {
    const coordinator = createQuietCoordinator();
    const listener = vi.fn();
    const stay = vi.fn();
    const unsubscribe = coordinator.subscribeJoinRequests("group-a", listener);
    coordinator.subscribeJoinRequests("group-a", stay);

    unsubscribe();
    storeRequest(coordinator);

    expect(listener).not.toHaveBeenCalled();
    expect(stay).toHaveBeenCalledOnce();
  });

  test("a repeated unsubscribe cannot drop a listener registered afterwards", () => {
    const coordinator = createQuietCoordinator();
    const first = vi.fn();
    const later = vi.fn();
    const unsubscribeFirst = coordinator.subscribeJoinRequests("group-a", first);
    unsubscribeFirst();
    coordinator.subscribeJoinRequests("group-a", later);

    unsubscribeFirst();
    storeRequest(coordinator);

    expect(first).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledOnce();
  });

  test("an unsubscribe outliving close cannot drop a listener registered afterwards", () => {
    const coordinator = createQuietCoordinator();
    const later = vi.fn();
    const unsubscribeEarlier = coordinator.subscribeJoinRequests("group-a", vi.fn());
    coordinator.close();
    coordinator.subscribeJoinRequests("group-a", later);

    unsubscribeEarlier();
    storeRequest(coordinator);

    expect(later).toHaveBeenCalledOnce();
  });

  test("close drops join-request listeners", () => {
    const coordinator = createQuietCoordinator();
    const listener = vi.fn();
    coordinator.subscribeJoinRequests("group-a", listener);

    coordinator.close();
    storeRequest(coordinator);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("background cleanup", () => {
  function seedUnread(coordinator: Coordinator) {
    coordinator.storeWelcome({ targetStablePubkey: ALICE, keyPackageReference: "kp", welcome });
    storeRequest(coordinator, "group-a", BOB);
  }

  function pendingCounts(storage: InMemoryCoordinatorStorage) {
    const snapshot = storage.toSnapshot();
    return { welcomes: snapshot.welcomes.length, joinRequests: snapshot.joinRequests.length };
  }

  test("uses hourly cleanup with a one hour read TTL by default", () => {
    vi.useFakeTimers({ now: 10 * DAY });
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = createCoordinator({ storage });
    seedUnread(coordinator);
    coordinator.fetchPendingWelcomes(ALICE);
    coordinator.fetchPendingJoinRequests("group-a");

    // readAt is exactly at the threshold after one interval, so it survives.
    vi.advanceTimersByTime(HOUR);
    expect(pendingCounts(storage)).toEqual({ welcomes: 1, joinRequests: 1 });

    vi.advanceTimersByTime(HOUR);
    expect(pendingCounts(storage)).toEqual({ welcomes: 0, joinRequests: 0 });

    coordinator.close();
  });

  test("keeps unread records for 30 days by default, then deletes them", () => {
    vi.useFakeTimers({ now: 100 * DAY });
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = createCoordinator({ storage });
    seedUnread(coordinator);

    vi.advanceTimersByTime(30 * DAY);
    expect(pendingCounts(storage)).toEqual({ welcomes: 1, joinRequests: 1 });

    vi.advanceTimersByTime(HOUR);
    expect(pendingCounts(storage)).toEqual({ welcomes: 0, joinRequests: 0 });

    coordinator.close();
  });

  test("uses the injected clock and the configured TTLs", () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = new Coordinator({
      storage,
      now: () => now,
      welcomeCleanupIntervalMs: 100,
      welcomeTtlMs: 50,
      welcomeMaxAgeMs: 5_000,
    });
    seedUnread(coordinator);
    coordinator.fetchPendingWelcomes(ALICE);

    now += 50;
    vi.advanceTimersByTime(100);
    expect(pendingCounts(storage)).toEqual({ welcomes: 1, joinRequests: 1 });

    now += 1;
    vi.advanceTimersByTime(100);
    expect(pendingCounts(storage)).toEqual({ welcomes: 0, joinRequests: 1 });

    now += 5_000;
    vi.advanceTimersByTime(100);
    expect(pendingCounts(storage)).toEqual({ welcomes: 0, joinRequests: 0 });

    coordinator.close();
  });

  test.each([0, -1])("keeps unread records forever when the max age is %i", (welcomeMaxAgeMs) => {
    vi.useFakeTimers({ now: 10 * DAY });
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = new Coordinator({
      storage,
      welcomeCleanupIntervalMs: DAY,
      welcomeMaxAgeMs,
    });
    seedUnread(coordinator);

    vi.advanceTimersByTime(365 * DAY);

    expect(pendingCounts(storage)).toEqual({ welcomes: 1, joinRequests: 1 });
    coordinator.close();
  });

  test("does not start a timer when the interval is disabled", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    new Coordinator({ welcomeCleanupIntervalMs: 0 }).close();
    new Coordinator({ welcomeCleanupIntervalMs: -1 }).close();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  test("stops cleaning after close", () => {
    vi.useFakeTimers({ now: 10 * DAY });
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = new Coordinator({ storage, welcomeCleanupIntervalMs: 100, welcomeTtlMs: 1 });
    seedUnread(coordinator);
    coordinator.fetchPendingWelcomes(ALICE);

    coordinator.close();
    vi.advanceTimersByTime(10_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(pendingCounts(storage)).toEqual({ welcomes: 1, joinRequests: 1 });
  });

  test("does not let the timer keep a Node process alive, and tolerates browser timers", () => {
    const unref = vi.fn();
    const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    setIntervalSpy.mockReturnValueOnce({ unref } as never);
    new Coordinator().close();
    expect(unref).toHaveBeenCalledOnce();

    setIntervalSpy.mockReturnValueOnce(42 as never);
    expect(() => new Coordinator().close()).not.toThrow();
    expect(clear).toHaveBeenCalledWith(42);
  });
});

describe("group messages", () => {
  test("defaults to Date.now and in-memory storage", () => {
    vi.useFakeTimers({ now: 123_456 });
    const coordinator = createCoordinator({ welcomeCleanupIntervalMs: 0 });

    expect(post(coordinator, "group-a").createdAt).toBe(123_456);
    expect(coordinator.fetchGroupMessages({ groupId: "group-a" })).toHaveLength(1);
  });

  test("keeps opaque bytes untouched and exposes routing", () => {
    const coordinator = createQuietCoordinator();
    const notMls = Uint8Array.from([255, 0, 255]);

    const record = coordinator.postGroupMessage({
      groupId: "group-a",
      ephemeralSenderPubkey: "sender",
      opaqueMessage: notMls,
    });

    expect(record).toEqual({
      cursor: 1,
      groupId: "group-a",
      epoch: 0n,
      ephemeralSenderPubkey: "sender",
      opaqueMessage: notMls,
      createdAt: 1_000,
    });
    expect(coordinator.getGroupRouting("group-a")).toEqual({
      groupId: "group-a",
      latestHandshakeEpoch: 0n,
      lastMessageCursor: 1,
    });
    expect(coordinator.getGroupRouting("other")).toBeNull();
  });

  test("carries a restored routing epoch onto new messages", () => {
    const hugeEpoch = 2n ** 60n;
    const seed = new InMemoryCoordinatorStorage();
    seed.appendGroupMessage({
      groupId: "group-a",
      latestHandshakeEpoch: hugeEpoch,
      epoch: hugeEpoch,
      ephemeralSenderPubkey: "sender",
      opaqueMessage: Uint8Array.of(1),
      createdAt: 1,
    });
    const coordinator = createQuietCoordinator(new InMemoryCoordinatorStorage(seed.toSnapshot()));

    const record = post(coordinator, "group-a");

    expect(record).toMatchObject({ cursor: 2, epoch: hugeEpoch });
    expect(coordinator.getGroupRouting("group-a")?.latestHandshakeEpoch).toBe(hugeEpoch);
  });

  test("fetches one and many groups", () => {
    const coordinator = createQuietCoordinator();
    post(coordinator, "group-a");
    post(coordinator, "group-a");
    post(coordinator, "group-b");

    expect(
      coordinator.fetchGroupMessages({ groupId: "group-a", afterCursor: 1 }).map((r) => r.cursor),
    ).toEqual([2]);
    expect(
      coordinator
        .fetchManyGroupMessages({ groups: [{ groupId: "group-b" }, { groupId: "group-a", afterCursor: 1 }] })
        .map((r) => [r.groupId, r.cursor]),
    ).toEqual([
      ["group-b", 1],
      ["group-a", 2],
    ]);
  });
});

describe("single-group subscriptions", () => {
  test("delivers live messages only, leaving backlog replay to the caller", async () => {
    const coordinator = createQuietCoordinator();
    post(coordinator, "group-a");
    const { messages, unsubscribe } = coordinator.subscribeGroupMessages({ groupId: "group-a" });

    post(coordinator, "group-a");
    post(coordinator, "group-b");

    expect(await takeCursors(messages, 1)).toEqual([2]);
    unsubscribe();
  });

  test("resolves concurrent waiters in order and then ends them on unsubscribe", async () => {
    const coordinator = createQuietCoordinator();
    const { messages, unsubscribe } = coordinator.subscribeGroupMessages({ groupId: "group-a" });
    const iterator = messages[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();
    const third = iterator.next();

    post(coordinator, "group-a");
    post(coordinator, "group-a");

    expect((await first).value?.cursor).toBe(1);
    expect((await second).value?.cursor).toBe(2);

    unsubscribe();
    await expect(third).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test("drains what was buffered before unsubscribe, and drops anything after", async () => {
    const coordinator = createQuietCoordinator();
    const { messages, unsubscribe } = coordinator.subscribeGroupMessages({ groupId: "group-a" });
    post(coordinator, "group-a");
    post(coordinator, "group-a");

    unsubscribe();
    post(coordinator, "group-a");

    expect(await takeCursors(messages, 10)).toEqual([1, 2]);
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
  });

  test("leaving a for-await loop ends delivery, and unsubscribe releases the leg", async () => {
    const coordinator = createQuietCoordinator();
    const { messages, unsubscribe } = coordinator.subscribeGroupMessages({ groupId: "group-a" });
    post(coordinator, "group-a");
    post(coordinator, "group-a");

    const seen: number[] = [];
    for await (const record of messages) {
      seen.push(record.cursor);
      break;
    }
    expect(seen).toEqual([1]);

    // The early exit closes the queue, but the leg is the caller's to release.
    post(coordinator, "group-a");
    expect(coordinator.getActiveSubscriptionCount()).toBe(1);
    unsubscribe();
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
    expect(await takeCursors(messages, 10)).toEqual([2]);
  });

  test("unsubscribe is idempotent and leaves other subscribers alone", async () => {
    const coordinator = createQuietCoordinator();
    const leaving = coordinator.subscribeGroupMessages({ groupId: "group-a" });
    const staying = coordinator.subscribeGroupMessages({ groupId: "group-a" });

    leaving.unsubscribe();
    leaving.unsubscribe();
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 1, groupLegs: 1 });

    post(coordinator, "group-a");
    expect(await takeCursors(staying.messages, 1)).toEqual([1]);

    staying.unsubscribe();
    leaving.unsubscribe();
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
  });

  test("refuses a deleted group", () => {
    const coordinator = createQuietCoordinator();
    coordinator.deleteGroup("doomed");

    expect(() => coordinator.subscribeGroupMessages({ groupId: "doomed" })).toThrow(
      ROOM_DELETED_BY_HOST_ERROR,
    );
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
  });
});

describe("multi-group subscriptions", () => {
  test("replays backlog per group from each cursor, then continues live", async () => {
    const coordinator = createQuietCoordinator();
    post(coordinator, "group-a");
    post(coordinator, "group-a");
    post(coordinator, "group-b");

    const { messages, unsubscribe } = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "group-a", afterCursor: 1 }, { groupId: "group-b" }],
    });
    post(coordinator, "group-b");
    post(coordinator, "group-c");

    const iterator = messages[Symbol.asyncIterator]();
    const seen: Array<[string, number]> = [];
    for (let index = 0; index < 3; index += 1) {
      const { value } = await iterator.next();
      seen.push([value.groupId, value.cursor]);
    }

    expect(seen).toEqual([
      ["group-a", 2],
      ["group-b", 1],
      ["group-b", 2],
    ]);
    unsubscribe();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  test("applies sinceEpoch to the replay", async () => {
    const storage = new InMemoryCoordinatorStorage();
    for (const epoch of [1n, 2n]) {
      storage.appendGroupMessage({
        groupId: "group-a",
        latestHandshakeEpoch: epoch,
        epoch,
        ephemeralSenderPubkey: "sender",
        opaqueMessage: Uint8Array.of(1),
        createdAt: 1,
      });
    }
    const coordinator = createQuietCoordinator(storage);

    const { messages, unsubscribe } = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "group-a", sinceEpoch: 2n }],
    });
    unsubscribe();

    expect(await takeCursors(messages, 10)).toEqual([2]);
  });

  test("does not repeat a message that is both backlog and live during replay", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = createQuietCoordinator(storage);
    const fetchMany = storage.fetchManyGroupMessages.bind(storage);
    vi.spyOn(storage, "fetchManyGroupMessages").mockImplementationOnce((input) => {
      post(coordinator, "group-a");
      return fetchMany(input);
    });

    const { messages, unsubscribe } = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "group-a" }],
    });
    unsubscribe();

    expect(await takeCursors(messages, 10)).toEqual([1]);
  });

  test("delivers, after the backlog, a live message published during replay", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = createQuietCoordinator(storage);
    post(coordinator, "group-a");
    const fetchMany = storage.fetchManyGroupMessages.bind(storage);
    vi.spyOn(storage, "fetchManyGroupMessages").mockImplementationOnce((input) => {
      const backlog = [...fetchMany(input)];
      post(coordinator, "group-a");
      return backlog;
    });

    const { messages, unsubscribe } = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "group-a" }],
    });
    unsubscribe();

    expect(await takeCursors(messages, 10)).toEqual([1, 2]);
  });

  test("refuses the whole subscription when any group is deleted", () => {
    const coordinator = createQuietCoordinator();
    coordinator.deleteGroup("doomed");

    expect(() =>
      coordinator.subscribeManyGroupMessages({
        groups: [{ groupId: "fine" }, { groupId: "doomed" }],
      }),
    ).toThrow(ROOM_DELETED_BY_HOST_ERROR);
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
  });

  test("releases its legs when the backlog read fails", () => {
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = createQuietCoordinator(storage);
    vi.spyOn(storage, "fetchManyGroupMessages").mockImplementationOnce(() => {
      throw new Error("storage offline");
    });

    expect(() =>
      coordinator.subscribeManyGroupMessages({
        groups: [{ groupId: "group-a" }, { groupId: "group-b" }],
      }),
    ).toThrow("storage offline");

    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
  });

  test("keeps order across queue compaction when a large backlog is drained", async () => {
    const coordinator = createQuietCoordinator();
    const total = 3_000;
    for (let index = 0; index < total; index += 1) {
      post(coordinator, "group-a", index % 256);
    }

    const { messages, unsubscribe } = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "group-a" }],
    });
    unsubscribe();

    const cursors = await takeCursors(messages, total + 1);
    expect(cursors).toEqual(Array.from({ length: total }, (_, index) => index + 1));
  });

  test("counts one stream with one leg per group, and releases them on unsubscribe", () => {
    const coordinator = createQuietCoordinator();
    const single = coordinator.subscribeGroupMessages({ groupId: "group-a" });
    const many = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "group-a" }, { groupId: "group-b" }],
    });

    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 2, groupLegs: 3 });
    expect(coordinator.getActiveSubscriptionCount()).toBe(3);

    many.unsubscribe();
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 1, groupLegs: 1 });

    single.unsubscribe();
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
  });
});

describe("deleteGroup", () => {
  test("ends affected streams but not subscribers of other groups only", async () => {
    const coordinator = createQuietCoordinator();
    const survivor = coordinator.subscribeGroupMessages({ groupId: "other" });
    const doomed = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "doomed" }, { groupId: "other" }],
    });
    const pending = doomed.messages[Symbol.asyncIterator]().next();

    coordinator.deleteGroup("doomed");

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 1, groupLegs: 1 });

    post(coordinator, "other");
    expect(await takeCursors(survivor.messages, 1)).toEqual([1]);

    doomed.unsubscribe();
    survivor.unsubscribe();
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
  });

  test("rejects further use, drops join-request listeners, and tolerates no subscribers", () => {
    const coordinator = createQuietCoordinator();
    const listener = vi.fn();
    coordinator.subscribeJoinRequests("doomed", listener);

    coordinator.deleteGroup("doomed");
    coordinator.deleteGroup("doomed");

    expect(() => storeRequest(coordinator, "doomed")).toThrow(ROOM_DELETED_BY_HOST_ERROR);
    expect(() => post(coordinator, "doomed")).toThrow(ROOM_DELETED_BY_HOST_ERROR);
    expect(() => coordinator.fetchGroupMessages({ groupId: "doomed" })).toThrow(
      ROOM_DELETED_BY_HOST_ERROR,
    );
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("close", () => {
  test("ends streams waiting for a message instead of leaving them hanging", async () => {
    const coordinator = createQuietCoordinator();
    const single = coordinator.subscribeGroupMessages({ groupId: "group-a" });
    const many = coordinator.subscribeManyGroupMessages({
      groups: [{ groupId: "group-a" }, { groupId: "group-b" }],
    });
    const pendingSingle = single.messages[Symbol.asyncIterator]().next();
    const pendingMany = many.messages[Symbol.asyncIterator]().next();

    coordinator.close();

    const ended = Promise.all([pendingSingle, pendingMany]);
    const hung = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20));
    await expect(Promise.race([ended, hung])).resolves.toEqual([
      { value: undefined, done: true },
      { value: undefined, done: true },
    ]);
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });

    // A caller's own cleanup still runs after close.
    expect(() => {
      single.unsubscribe();
      many.unsubscribe();
    }).not.toThrow();
  });

  test("closes storage that supports it and tolerates storage that does not", () => {
    const storage = new InMemoryCoordinatorStorage();
    const close = vi.spyOn(storage, "close");
    createQuietCoordinator(storage).close();
    expect(close).toHaveBeenCalledOnce();

    const withoutClose = new InMemoryCoordinatorStorage() as CoordinatorStorage;
    withoutClose.close = undefined;
    expect(() => createQuietCoordinator(withoutClose).close()).not.toThrow();
  });
});
