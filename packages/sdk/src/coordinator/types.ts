import type { NostrEvent } from "nostr-tools";
import type { KeyPackage, Welcome } from "ts-mls";

export interface PublishedKeyPackageRecord {
  stablePubkey: string;
  keyPackage: KeyPackage;
  keyPackageRef: string;
  isLastResort: boolean;
  publishedAt: number;
  publicationEvent: NostrEvent;
}

export interface WelcomeQueueRecord {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  createdAt: number;
  readAt: number | null;
  /** Cursor of the Commit already incorporated by the Welcome. */
  joinAfterCursor?: number;
}

export interface ConsumedWelcomeRef {
  keyPackageReference: string;
  createdAt: number;
}

export interface ConsumedJoinRequestRef {
  requesterStablePubkey: string;
  createdAt: number;
}

export interface ConsumedJoinRequestWithGroupRef extends ConsumedJoinRequestRef {
  groupId: string;
}

export interface JoinRequestRecord {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  inviteToken?: string;
  createdAt: number;
  readAt: number | null;
}

export interface GroupRoutingRecord {
  groupId: string;
  latestHandshakeEpoch: bigint;
  lastMessageCursor: number;
}

export interface GroupMessageRecord {
  cursor: number;
  groupId: string;
  epoch: bigint;
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
}

export interface PublishKeyPackageInput {
  stablePubkey: string;
  keyPackage: KeyPackage;
  keyPackageRef: string;
  publicationEvent: NostrEvent;
}

export interface StoreWelcomeInput {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  joinAfterCursor?: number;
}

export interface StoreJoinRequestInput {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  inviteToken?: string;
}

export interface PostGroupMessageInput {
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  /** Canonical outer routing id. The coordinator must not inspect msg_64. */
  groupId: string;
}

export interface FetchGroupMessagesInput {
  groupId: string;
  afterCursor?: number;
  sinceEpoch?: bigint;
}

export type SubscribeGroupMessagesInput = FetchGroupMessagesInput;

export interface FetchManyGroupMessagesInput {
  groups: FetchGroupMessagesInput[];
}

export type SubscribeManyGroupMessagesInput = FetchManyGroupMessagesInput;

export interface FetchManyPendingJoinRequestsInput {
  groups: { groupId: string }[];
  consumed?: ConsumedJoinRequestWithGroupRef[];
}
