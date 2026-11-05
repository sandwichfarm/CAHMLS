import type {
  ConsumedJoinRequestRef,
  ConsumedWelcomeRef,
  FetchManyGroupMessagesInput,
  FetchManyPendingJoinRequestsInput,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  JoinRequestRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../types";

import {
  type AppendGroupMessageParams,
  type CoordinatorStorage,
  MAX_PENDING_JOIN_REQUESTS_PER_GROUP,
  ROOM_DELETED_BY_HOST_ERROR,
} from "./storage";
import { decodeBase64, encodeBase64 } from "../../server/base64";
import {
  decodeKeyPackage,
  decodeWelcome,
  encodeKeyPackage,
  encodeWelcome,
} from "../../mlsCodec";

interface GroupLog {
  nextCursor: number;
  routing: GroupRoutingRecord;
  messages: GroupMessageRecord[];
}

export interface CoordinatorStorageSnapshot {
  version: 1;
  /** Optional to preserve compatibility with snapshots written before room deletion. */
  deletedGroups?: string[];
  keyPackages: Array<{
    stablePubkey: string;
    keyPackageRef: string;
    isLastResort: boolean;
    publishedAt: number;
    publicationEvent: PublishedKeyPackageRecord["publicationEvent"];
    keyPackage64: string;
  }>;
  welcomes: Array<{
    targetStablePubkey: string;
    keyPackageReference: string;
    welcome64: string;
    createdAt: number;
    readAt: number | null;
    joinAfterCursor?: number;
    /** Legacy field written by the browser coordinator before canonical alignment. */
    afterCursor?: number;
  }>;
  joinRequests: JoinRequestRecord[];
  groups: Array<{
    groupId: string;
    nextCursor: number;
    routing: {
      groupId: string;
      latestHandshakeEpoch: string;
      lastMessageCursor: number;
    };
    messages: Array<{
      cursor: number;
      groupId: string;
      epoch: string;
      ephemeralSenderPubkey: string;
      opaqueMessage64: string;
      createdAt: number;
    }>;
  }>;
}

/**
 * Browser persistence is deliberately outside Cordn's synchronous storage
 * contract. Mutations remain synchronous; an immutable snapshot is queued by
 * the owning browser adapter and joined later by the lifecycle owner.
 */
export interface CoordinatorSnapshotLifecycle {
  queueSnapshot(snapshot: CoordinatorStorageSnapshot): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

function createGroupLog(groupId: string, epoch: bigint): GroupLog {
  return {
    nextCursor: 1,
    routing: {
      groupId,
      latestHandshakeEpoch: epoch,
      lastMessageCursor: 0,
    },
    messages: [],
  };
}

export class InMemoryCoordinatorStorage implements CoordinatorStorage {
  private readonly keyPackagesByIdentity = new Map<
    string,
    PublishedKeyPackageRecord[]
  >();
  private readonly welcomesByIdentity = new Map<string, WelcomeQueueRecord[]>();
  private readonly joinRequestsByGroup = new Map<string, JoinRequestRecord[]>();
  private readonly groups = new Map<string, GroupLog>();
  private readonly deletedGroups = new Set<string>();

  constructor(
    snapshot?: CoordinatorStorageSnapshot | null,
    private readonly onChange?: (snapshot: CoordinatorStorageSnapshot) => void,
    private readonly snapshotLifecycle?: CoordinatorSnapshotLifecycle,
  ) {
    if (snapshot) {
      this.restoreSnapshot(snapshot);
    }
  }

  toSnapshot(): CoordinatorStorageSnapshot {
    return {
      version: 1,
      deletedGroups: [...this.deletedGroups].sort(),
      keyPackages: this.listAllKeyPackages().map((record) => ({
        stablePubkey: record.stablePubkey,
        keyPackageRef: record.keyPackageRef,
        isLastResort: record.isLastResort,
        publishedAt: record.publishedAt,
        publicationEvent: record.publicationEvent,
        keyPackage64: encodeBase64(encodeKeyPackage(record.keyPackage)),
      })),
      welcomes: [...this.welcomesByIdentity.values()].flatMap((records) =>
        records.map((record) => ({
          targetStablePubkey: record.targetStablePubkey,
          keyPackageReference: record.keyPackageReference,
          welcome64: encodeBase64(encodeWelcome(record.welcome)),
          createdAt: record.createdAt,
          readAt: record.readAt,
          joinAfterCursor: record.joinAfterCursor,
        })),
      ),
      joinRequests: [...this.joinRequestsByGroup.values()].flatMap((records) =>
        records.map((record) => ({ ...record })),
      ),
      groups: [...this.groups.values()].map((group) => ({
        groupId: group.routing.groupId,
        nextCursor: group.nextCursor,
        routing: {
          groupId: group.routing.groupId,
          latestHandshakeEpoch: group.routing.latestHandshakeEpoch.toString(),
          lastMessageCursor: group.routing.lastMessageCursor,
        },
        messages: group.messages.map((record) => ({
          cursor: record.cursor,
          groupId: record.groupId,
          epoch: record.epoch.toString(),
          ephemeralSenderPubkey: record.ephemeralSenderPubkey,
          opaqueMessage64: encodeBase64(record.opaqueMessage),
          createdAt: record.createdAt,
        })),
      })),
    };
  }

  publishKeyPackage(
    record: PublishedKeyPackageRecord,
  ): PublishedKeyPackageRecord {
    const records = this.keyPackagesByIdentity.get(record.stablePubkey) ?? [];
    records.push(record);
    this.keyPackagesByIdentity.set(record.stablePubkey, records);

    this.persist();
    return record;
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    return this.keyPackagesByIdentity.get(stablePubkey) ?? [];
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    const records: PublishedKeyPackageRecord[] = [];

    for (const keyPackages of this.keyPackagesByIdentity.values()) {
      for (let index = 0; index < keyPackages.length; index += 1) {
        records.push(keyPackages[index]!);
      }
    }

    return records;
  }

  getKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    const located = this.findKeyPackage(keyPackageRef);
    if (located) {
      return located.record;
    }

    return null;
  }

  removeKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    const located = this.findKeyPackage(keyPackageRef);
    if (!located) {
      return null;
    }

    const { stablePubkey, index, records } = located;
    const [removed] = records.splice(index, 1);
    if (records.length === 0) {
      this.keyPackagesByIdentity.delete(stablePubkey);
    }

    this.persist();
    return removed ?? null;
  }

  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null {
    const directRecord = this.consumeKeyPackageByReference(identifier);
    if (directRecord) return directRecord;

    return this.consumeKeyPackageByIdentity(identifier);
  }

  storeWelcome(record: WelcomeQueueRecord): WelcomeQueueRecord {
    const stored: WelcomeQueueRecord = { ...record };
    const existing =
      this.welcomesByIdentity.get(stored.targetStablePubkey) ?? [];
    existing.push(stored);
    this.welcomesByIdentity.set(stored.targetStablePubkey, existing);

    this.persist();
    return stored;
  }

  fetchPendingWelcomes(
    targetStablePubkey: string,
    now: number,
    consumed?: ConsumedWelcomeRef[],
  ): WelcomeQueueRecord[] {
    const existing = this.welcomesByIdentity.get(targetStablePubkey) ?? [];
    const records = consumed?.length
      ? existing.filter((record) => !consumed.some((entry) =>
          entry.keyPackageReference === record.keyPackageReference &&
          entry.createdAt === record.createdAt))
      : existing;
    let changed = records.length !== existing.length;
    if (changed) {
      if (records.length === 0) this.welcomesByIdentity.delete(targetStablePubkey);
      else this.welcomesByIdentity.set(targetStablePubkey, records);
    }
    for (const record of records) {
      if (record.readAt === null) {
        record.readAt = now;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return records;
  }

  deleteExpiredWelcomes(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    let deleted = 0;

    for (const [targetStablePubkey, records] of this.welcomesByIdentity) {
      const kept = records.filter(
        (record) =>
          (record.readAt === null && record.createdAt >= unreadThreshold) ||
          (record.readAt !== null && record.readAt >= readThreshold),
      );
      deleted += records.length - kept.length;

      if (kept.length === 0) {
        this.welcomesByIdentity.delete(targetStablePubkey);
      } else {
        this.welcomesByIdentity.set(targetStablePubkey, kept);
      }
    }

    if (deleted > 0) {
      this.persist();
    }
    return deleted;
  }

  storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord {
    this.assertGroupAvailable(record.groupId);
    const existing = this.joinRequestsByGroup.get(record.groupId) ?? [];
    const duplicate = existing.find(
      (req) => req.requesterStablePubkey === record.requesterStablePubkey,
    );
    if (duplicate) {
      // Match Cordn's consume-ack model: a retry from the same identity is
      // the same logical request, but it must carry the requester's newest
      // KeyPackage and timestamp. Refreshing in place prevents a host's old
      // consumed reference from discarding the retried request.
      duplicate.keyPackageRef = record.keyPackageRef;
      duplicate.inviteToken = record.inviteToken;
      duplicate.createdAt = record.createdAt;
      duplicate.readAt = null;
      this.persist();
      return { ...duplicate };
    }

    // Enforce the cap only for a genuinely new requester. Re-requests must
    // remain possible even when the queue is full.
    if (existing.length >= MAX_PENDING_JOIN_REQUESTS_PER_GROUP) {
      throw new Error("Too many pending join requests for this group");
    }

    const stored: JoinRequestRecord = { ...record };
    existing.push(stored);
    this.joinRequestsByGroup.set(record.groupId, existing);

    this.persist();
    return stored;
  }

  fetchPendingJoinRequests(
    groupId: string,
    now: number,
    consumed?: ConsumedJoinRequestRef[],
  ): JoinRequestRecord[] {
    const existing = this.joinRequestsByGroup.get(groupId) ?? [];
    const records = consumed?.length
      ? existing.filter((record) => !consumed.some((entry) =>
          entry.requesterStablePubkey === record.requesterStablePubkey &&
          entry.createdAt === record.createdAt))
      : existing;
    let changed = records.length !== existing.length;
    if (changed) {
      if (records.length === 0) this.joinRequestsByGroup.delete(groupId);
      else this.joinRequestsByGroup.set(groupId, records);
    }
    for (const record of records) {
      if (record.readAt === null) {
        record.readAt = now;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return records;
  }

  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
    now: number,
  ): JoinRequestRecord[] {
    return input.groups.flatMap((group) =>
      this.fetchPendingJoinRequests(
        group.groupId,
        now,
        input.consumed?.filter((entry) => entry.groupId === group.groupId),
      ),
    );
  }

  deleteExpiredJoinRequests(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    let deleted = 0;

    for (const [groupId, records] of this.joinRequestsByGroup) {
      const kept = records.filter(
        (record) =>
          (record.readAt === null && record.createdAt >= unreadThreshold) ||
          (record.readAt !== null && record.readAt >= readThreshold),
      );
      deleted += records.length - kept.length;

      if (kept.length === 0) {
        this.joinRequestsByGroup.delete(groupId);
      } else {
        this.joinRequestsByGroup.set(groupId, kept);
      }
    }

    if (deleted > 0) {
      this.persist();
    }
    return deleted;
  }

  isGroupDeleted(groupId: string): boolean {
    return this.deletedGroups.has(groupId);
  }

  deleteGroup(groupId: string): void {
    const newlyDeleted = !this.deletedGroups.has(groupId);
    const removedGroup = this.groups.delete(groupId);
    const removedJoinRequests = this.joinRequestsByGroup.delete(groupId);
    this.deletedGroups.add(groupId);

    if (newlyDeleted || removedGroup || removedJoinRequests) {
      this.persist();
    }
  }

  appendGroupMessage(params: AppendGroupMessageParams): GroupMessageRecord {
    this.assertGroupAvailable(params.groupId);
    const group =
      this.groups.get(params.groupId) ??
      createGroupLog(params.groupId, params.latestHandshakeEpoch);

    const record: GroupMessageRecord = {
      cursor: group.nextCursor,
      groupId: params.groupId,
      epoch: params.epoch,
      ephemeralSenderPubkey: params.ephemeralSenderPubkey,
      opaqueMessage: params.opaqueMessage,
      createdAt: params.createdAt,
    };
    group.nextCursor += 1;

    group.messages.push(record);
    group.routing.latestHandshakeEpoch = params.latestHandshakeEpoch;
    group.routing.lastMessageCursor = record.cursor;

    this.groups.set(params.groupId, group);

    this.persist();
    return record;
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    this.assertGroupAvailable(input.groupId);
    const messages = this.groups.get(input.groupId)?.messages ?? [];
    const sinceEpoch = input.sinceEpoch;
    const afterCursor = input.afterCursor;

    let filtered = messages;
    if (sinceEpoch !== undefined && sinceEpoch > 0n) {
      filtered = messages.filter((record) => record.epoch >= sinceEpoch);
    }

    if (afterCursor === undefined) {
      return filtered;
    }

    return filtered.filter((record) => record.cursor > afterCursor);
  }

  fetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): GroupMessageRecord[] {
    return input.groups.flatMap((group) => this.fetchGroupMessages(group));
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.groups.get(groupId)?.routing ?? null;
  }

  /** Wait for the browser adapter without making Cordn storage calls async. */
  flush(): Promise<void> {
    return this.snapshotLifecycle?.flush() ?? Promise.resolve();
  }

  close(): void {
    // Transport lifecycle callers flush before close. Retain a best-effort
    // join for legacy synchronous callers so a close never deliberately drops
    // an already queued snapshot.
    void this.snapshotLifecycle?.close();
  }

  private consumeKeyPackageByIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord | null {
    const records = this.keyPackagesByIdentity.get(stablePubkey);
    if (!records || records.length === 0) {
      return null;
    }

    // Match Cordn's canonical selection order. A room-scoped ordinary package
    // is consumed before falling back to the newest reusable last-resort
    // package. Reversing this order encrypts the Welcome for a different local
    // private package whenever both kinds have been published by one client.
    const regular = records.find((record) => !record.isLastResort);
    if (regular) return this.removeKeyPackage(regular.keyPackageRef);

    return records.at(-1) ?? null;
  }

  private consumeKeyPackageByReference(
    keyPackageRef: string,
  ): PublishedKeyPackageRecord | null {
    const record = this.getKeyPackage(keyPackageRef);
    if (!record) {
      return null;
    }

    return record.isLastResort ? record : this.removeKeyPackage(keyPackageRef);
  }

  private findKeyPackage(keyPackageRef: string):
    | {
        stablePubkey: string;
        index: number;
        records: PublishedKeyPackageRecord[];
        record: PublishedKeyPackageRecord;
      }
    | undefined {
    for (const [
      stablePubkey,
      records,
    ] of this.keyPackagesByIdentity.entries()) {
      const index = records.findIndex(
        (candidate) => candidate.keyPackageRef === keyPackageRef,
      );
      if (index >= 0) {
        return {
          stablePubkey,
          index,
          records,
          record: records[index]!,
        };
      }
    }

    return undefined;
  }

  private restoreSnapshot(snapshot: CoordinatorStorageSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error("Unsupported coordinator storage snapshot");
    }

    for (const groupId of snapshot.deletedGroups ?? []) {
      this.deletedGroups.add(groupId);
    }

    for (const record of snapshot.keyPackages) {
      const keyPackageRecords =
        this.keyPackagesByIdentity.get(record.stablePubkey) ?? [];
      keyPackageRecords.push({
        stablePubkey: record.stablePubkey,
        keyPackageRef: record.keyPackageRef,
        keyPackage: decodeKeyPackage(decodeBase64(record.keyPackage64)),
        isLastResort: record.isLastResort,
        publishedAt: record.publishedAt,
        publicationEvent: record.publicationEvent,
      });
      this.keyPackagesByIdentity.set(record.stablePubkey, keyPackageRecords);
    }

    for (const record of snapshot.welcomes) {
      const records =
        this.welcomesByIdentity.get(record.targetStablePubkey) ?? [];
      records.push({
        targetStablePubkey: record.targetStablePubkey,
        keyPackageReference: record.keyPackageReference,
        welcome: decodeWelcome(decodeBase64(record.welcome64)),
        createdAt: record.createdAt,
        readAt: record.readAt,
        joinAfterCursor: record.joinAfterCursor ?? record.afterCursor,
      });
      this.welcomesByIdentity.set(record.targetStablePubkey, records);
    }

    for (const record of snapshot.joinRequests) {
      if (this.isGroupDeleted(record.groupId)) {
        continue;
      }
      const records = this.joinRequestsByGroup.get(record.groupId) ?? [];
      records.push({ ...record });
      this.joinRequestsByGroup.set(record.groupId, records);
    }

    for (const group of snapshot.groups) {
      if (this.isGroupDeleted(group.groupId)) {
        continue;
      }
      this.groups.set(group.groupId, {
        nextCursor: group.nextCursor,
        routing: {
          groupId: group.routing.groupId,
          latestHandshakeEpoch: BigInt(group.routing.latestHandshakeEpoch),
          lastMessageCursor: group.routing.lastMessageCursor,
        },
        messages: group.messages.map((record) => ({
          cursor: record.cursor,
          groupId: record.groupId,
          epoch: BigInt(record.epoch),
          ephemeralSenderPubkey: record.ephemeralSenderPubkey,
          opaqueMessage: decodeBase64(record.opaqueMessage64),
          createdAt: record.createdAt,
        })),
      });
    }
  }

  private persist(): void {
    const snapshot = this.toSnapshot();
    this.onChange?.(snapshot);
    this.snapshotLifecycle?.queueSnapshot(snapshot);
  }

  private assertGroupAvailable(groupId: string): void {
    if (this.isGroupDeleted(groupId)) {
      throw new Error(ROOM_DELETED_BY_HOST_ERROR);
    }
  }
}
