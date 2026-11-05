import type {
  ConsumedWelcomeRef,
  FetchManyGroupMessagesInput,
  FetchManyPendingJoinRequestsInput,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  JoinRequestRecord,
  PostGroupMessageInput,
  PublishedKeyPackageRecord,
  PublishKeyPackageInput,
  StoreJoinRequestInput,
  SubscribeGroupMessagesInput,
  SubscribeManyGroupMessagesInput,
  StoreWelcomeInput,
  WelcomeQueueRecord,
} from "./types.js";
import type { CoordinatorStorage } from "./storage/storage.js";
import { ROOM_DELETED_BY_HOST_ERROR } from "./storage/storage.js";
import { InMemoryCoordinatorStorage } from "./storage/inMemoryStorage.js";
import { isLastResortKeyPackage } from "../mls/lastResortKeyPackage.js";


export interface CoordinatorOptions {
  storage?: CoordinatorStorage;
  now?: () => number;
  /** TTL in ms for read welcome and join request cleanup. Read records whose readAt is older than this threshold are deleted. Default: 1h. */
  welcomeTtlMs?: number;
  /** Interval in ms between cleanup runs. Set to 0 to disable. Default: 1h. */
  welcomeCleanupIntervalMs?: number;
  /** Max age in ms for unread welcome and join request records. Unread records created before (now - maxAge) are deleted. Set to 0 or negative to disable (keep unread forever). Default: 30 days (2_592_000_000). */
  welcomeMaxAgeMs?: number;
}

export interface ActiveSubscriptionMetrics {
  activeStreams: number;
  groupLegs: number;
}

class AsyncMessageQueue implements AsyncIterable<GroupMessageRecord> {
  private readonly values: GroupMessageRecord[] = [];
  private nextValueIndex = 0;
  private readonly waiters: Array<
    (result: IteratorResult<GroupMessageRecord>) => void
  > = [];
  private closed = false;

  push(value: GroupMessageRecord): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<GroupMessageRecord> {
    return {
      next: async (): Promise<IteratorResult<GroupMessageRecord>> => {
        if (this.nextValueIndex < this.values.length) {
          const value = this.values[this.nextValueIndex]!;
          this.nextValueIndex += 1;

          if (
            this.nextValueIndex > 1024 &&
            this.nextValueIndex * 2 >= this.values.length
          ) {
            this.values.splice(0, this.nextValueIndex);
            this.nextValueIndex = 0;
          }

          return { value, done: false };
        }

        if (this.closed) {
          return { value: undefined, done: true };
        }

        return new Promise<IteratorResult<GroupMessageRecord>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<GroupMessageRecord>> => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

interface GroupMessageSubscription {
  messages: AsyncIterable<GroupMessageRecord>;
  unsubscribe: () => void;
}

interface GroupMessageSubscriber {
  push(record: GroupMessageRecord): void;
  close(): void;
}

export class Coordinator {
  private readonly storage: CoordinatorStorage;
  private readonly now: () => number;
  private readonly groupSubscribers = new Map<
    string,
    Set<GroupMessageSubscriber>
  >();
  private readonly joinRequestSubscribers = new Map<
    string,
    Set<(record: JoinRequestRecord) => void | Promise<void>>
  >();
  private readonly joinRequestNotifications = new WeakMap<
    JoinRequestRecord,
    Promise<void>
  >();
  private readonly cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CoordinatorOptions = {}) {
    this.storage = options.storage ?? new InMemoryCoordinatorStorage();
    this.now = options.now ?? Date.now;

    const intervalMs = options.welcomeCleanupIntervalMs ?? 3_600_000;
    if (intervalMs > 0) {
      const ttlMs = options.welcomeTtlMs ?? 3_600_000;
      const maxAgeMs = options.welcomeMaxAgeMs ?? 2_592_000_000; // 30 days
      this.cleanupTimer = setInterval(() => {
        const now = this.now();
        const readThreshold = now - ttlMs;
        const unreadThreshold = maxAgeMs > 0 ? now - maxAgeMs : 0;
        this.deleteExpiredWelcomes(readThreshold, unreadThreshold);
        this.deleteExpiredJoinRequests(readThreshold, unreadThreshold);
      }, intervalMs);
      // Allow the timer to not keep the process alive.
      (this.cleanupTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  publishKeyPackage(input: PublishKeyPackageInput): PublishedKeyPackageRecord {
    const record: PublishedKeyPackageRecord = {
      stablePubkey: input.stablePubkey,
      keyPackage: input.keyPackage,
      keyPackageRef: input.keyPackageRef,
      isLastResort: isLastResortKeyPackage(input.keyPackage),
      publishedAt: this.now(),
      publicationEvent: input.publicationEvent,
    };

    return this.storage.publishKeyPackage(record);
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    return this.storage.listKeyPackagesForIdentity(stablePubkey);
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    return this.storage.listAllKeyPackages();
  }

  getKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    return this.storage.getKeyPackage(keyPackageRef);
  }

  removeKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    return this.storage.removeKeyPackage(keyPackageRef);
  }

  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null {
    return this.storage.consumeKeyPackage(identifier);
  }

  storeWelcome(input: StoreWelcomeInput): WelcomeQueueRecord {
    const record: WelcomeQueueRecord = {
      targetStablePubkey: input.targetStablePubkey,
      keyPackageReference: input.keyPackageReference,
      welcome: input.welcome,
      createdAt: this.now(),
      readAt: null,
      joinAfterCursor: input.joinAfterCursor,
    };

    return this.storage.storeWelcome(record);
  }

  fetchPendingWelcomes(
    targetStablePubkey: string,
    consumed?: ConsumedWelcomeRef[],
  ): WelcomeQueueRecord[] {
    return this.storage.fetchPendingWelcomes(
      targetStablePubkey,
      this.now(),
      consumed,
    );
  }

  deleteExpiredWelcomes(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    return this.storage.deleteExpiredWelcomes(readThreshold, unreadThreshold);
  }

  storeJoinRequest(input: StoreJoinRequestInput): JoinRequestRecord {
    const record: JoinRequestRecord = {
      groupId: input.groupId,
      requesterStablePubkey: input.requesterStablePubkey,
      keyPackageRef: input.keyPackageRef,
      inviteToken: input.inviteToken,
      createdAt: this.now(),
      readAt: null,
    };

    const stored = this.storage.storeJoinRequest(record);
    const completions: Promise<void>[] = [];
    for (const subscriber of this.joinRequestSubscribers.get(stored.groupId) ?? []) {
      try {
        completions.push(Promise.resolve(subscriber(stored)));
      } catch (error) {
        completions.push(Promise.reject(error));
      }
    }
    const notifications = Promise.all(completions).then(() => undefined);
    // A failing listener is reported to whoever waits on this request. Without
    // a waiter it must not surface as an unhandled rejection: the request has
    // already been stored, and hosts also pick it up by polling.
    notifications.catch(() => undefined);
    this.joinRequestNotifications.set(stored, notifications);
    return stored;
  }

  /**
   * Wait for same-process join-request listeners that were started by this
   * exact request. The persisted request remains asynchronous for remote
   * hosts; only the wire adapter uses this to provide an immediate Welcome
   * when an auto-approving host is already active in this tab.
   */
  waitForJoinRequestNotifications(record: JoinRequestRecord): Promise<void> {
    return this.joinRequestNotifications.get(record) ?? Promise.resolve();
  }

  subscribeJoinRequests(
    groupId: string,
    subscriber: (record: JoinRequestRecord) => void | Promise<void>,
  ): () => void {
    const subscribers =
      this.joinRequestSubscribers.get(groupId) ??
      new Set<(record: JoinRequestRecord) => void | Promise<void>>();
    this.joinRequestSubscribers.set(groupId, subscribers);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
      // Only drop the Set this subscription joined. A repeated unsubscribe, or
      // one that outlives close(), must not remove a newer group registration.
      if (
        subscribers.size === 0 &&
        this.joinRequestSubscribers.get(groupId) === subscribers
      ) {
        this.joinRequestSubscribers.delete(groupId);
      }
    };
  }

  fetchPendingJoinRequests(groupId: string): JoinRequestRecord[] {
    return this.storage.fetchPendingJoinRequests(groupId, this.now());
  }

  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
  ): JoinRequestRecord[] {
    return this.storage.fetchManyPendingJoinRequests(input, this.now());
  }

  deleteExpiredJoinRequests(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    return this.storage.deleteExpiredJoinRequests(
      readThreshold,
      unreadThreshold,
    );
  }

  deleteGroup(groupId: string): void {
    this.storage.deleteGroup(groupId);
    this.closeSubscribersForGroup(groupId);
    this.joinRequestSubscribers.delete(groupId);
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    // End open streams; otherwise a consumer waiting on `messages` never wakes.
    for (const subscribers of this.groupSubscribers.values()) {
      for (const subscriber of subscribers) {
        subscriber.close();
      }
    }
    this.groupSubscribers.clear();
    this.joinRequestSubscribers.clear();
    this.storage.close?.();
  }

  postGroupMessage(input: PostGroupMessageInput): GroupMessageRecord {
    // Cordn spec/03 makes msg_64 an encrypted, opaque delivery payload. The
    // coordinator routes exclusively by the outer gid and must never attempt
    // to parse MLS framing, epochs, or membership data from these bytes.
    const currentRouting = this.storage.getGroupRouting(input.groupId);
    const opaqueEpoch = currentRouting?.latestHandshakeEpoch ?? 0n;

    const record = this.storage.appendGroupMessage({
      groupId: input.groupId,
      latestHandshakeEpoch: opaqueEpoch,
      epoch: opaqueEpoch,
      ephemeralSenderPubkey: input.ephemeralSenderPubkey,
      opaqueMessage: input.opaqueMessage,
      createdAt: this.now(),
    });

    this.publishLiveGroupMessage(record);

    return record;
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    return this.storage.fetchGroupMessages(input);
  }

  fetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): GroupMessageRecord[] {
    return this.storage.fetchManyGroupMessages(input);
  }

  subscribeGroupMessages(
    input: SubscribeGroupMessagesInput,
  ): GroupMessageSubscription {
    this.assertGroupAvailable(input.groupId);
    const queue = new AsyncMessageQueue();
    const subscriber: GroupMessageSubscriber = queue;

    this.addGroupSubscriber(input.groupId, subscriber);

    return {
      messages: queue,
      unsubscribe: () => {
        subscriber.close();
        this.removeGroupSubscriber(input.groupId, subscriber);
      },
    };
  }

  subscribeManyGroupMessages(
    input: SubscribeManyGroupMessagesInput,
  ): GroupMessageSubscription {
    for (const group of input.groups) {
      this.assertGroupAvailable(group.groupId);
    }

    const queue = new AsyncMessageQueue();
    const cursorsByGroup = new Map<string, number>();
    const liveBuffer: GroupMessageRecord[] = [];
    let replayingBacklog = true;
    for (const group of input.groups) {
      cursorsByGroup.set(group.groupId, group.afterCursor ?? 0);
    }
    const groupIds = [...cursorsByGroup.keys()];
    const emitIfNew = (record: GroupMessageRecord): void => {
      const lastEmittedCursor = cursorsByGroup.get(record.groupId)!;
      if (record.cursor <= lastEmittedCursor) {
        return;
      }

      cursorsByGroup.set(record.groupId, record.cursor);
      queue.push(record);
    };
    const subscriber: GroupMessageSubscriber = {
      push: (record) => {
        if (replayingBacklog) {
          liveBuffer.push(record);
          return;
        }

        emitIfNew(record);
      },
      close: () => queue.close(),
    };
    const unsubscribe = (): void => {
      subscriber.close();
      for (const groupId of groupIds) {
        this.removeGroupSubscriber(groupId, subscriber);
      }
    };

    for (const groupId of groupIds) {
      this.addGroupSubscriber(groupId, subscriber);
    }

    try {
      for (const record of this.fetchManyGroupMessages(input)) {
        emitIfNew(record);
      }
    } catch (error) {
      unsubscribe();
      throw error;
    }
    replayingBacklog = false;
    for (const record of liveBuffer.splice(0)) {
      subscriber.push(record);
    }

    return { messages: queue, unsubscribe };
  }

  private addGroupSubscriber(
    groupId: string,
    subscriber: GroupMessageSubscriber,
  ): void {
    let subscribers = this.groupSubscribers.get(groupId);
    if (!subscribers) {
      subscribers = new Set();
      this.groupSubscribers.set(groupId, subscribers);
    }

    subscribers.add(subscriber);
  }

  private removeGroupSubscriber(
    groupId: string,
    subscriber: GroupMessageSubscriber,
  ): void {
    const subscribers = this.groupSubscribers.get(groupId);
    if (!subscribers) {
      return;
    }

    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      this.groupSubscribers.delete(groupId);
    }
  }

  private publishLiveGroupMessage(record: GroupMessageRecord): void {
    const subscribers = this.groupSubscribers.get(record.groupId);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber.push(record);
    }
  }

  private closeSubscribersForGroup(groupId: string): void {
    const deletedGroupSubscribers = this.groupSubscribers.get(groupId);
    if (!deletedGroupSubscribers) {
      return;
    }

    this.groupSubscribers.delete(groupId);
    for (const subscriber of deletedGroupSubscribers) {
      subscriber.close();
      for (const [subscribedGroupId, subscribers] of this.groupSubscribers) {
        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
          this.groupSubscribers.delete(subscribedGroupId);
        }
      }
    }
  }

  private assertGroupAvailable(groupId: string): void {
    if (this.storage.isGroupDeleted(groupId)) {
      throw new Error(ROOM_DELETED_BY_HOST_ERROR);
    }
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.storage.getGroupRouting(groupId);
  }

  getActiveSubscriptionMetrics(): ActiveSubscriptionMetrics {
    const activeSubscribers = new Set<GroupMessageSubscriber>();
    let groupLegs = 0;
    for (const subscribers of this.groupSubscribers.values()) {
      groupLegs += subscribers.size;
      for (const subscriber of subscribers) {
        activeSubscribers.add(subscriber);
      }
    }
    return {
      activeStreams: activeSubscribers.size,
      groupLegs,
    };
  }

  getActiveSubscriptionCount(): number {
    return this.getActiveSubscriptionMetrics().groupLegs;
  }
}

export function createCoordinator(
  options: CoordinatorOptions = {},
): Coordinator {
  return new Coordinator(options);
}
