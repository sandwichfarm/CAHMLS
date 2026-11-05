import type { NostrSigner } from "@contextvm/sdk/core";
import { hexToBytes } from "nostr-tools/utils";
import { BrowserNostrSigner } from "../crypto/browser-nostr-signer";
import { notificationCenter } from "../notifications/notification-center.svelte";
import { normalizeRoomHostIdentity, type ChatInvite, type CoordinatorKeyMode, type RoomHostIdentity } from "./invite";
import {
  CHAT_EMOJI_SHORTCUTS,
  addMember,
  createKeyPackage,
  createRoomState,
  decodeState,
  decryptMessage,
  encodeState,
  encryptMessage,
  groupCreatorPubkey,
  groupId,
  hasValidChatEnvelopeAuth,
  isChatReactionMutation,
  joinWelcome,
  sanitizeChatEnvelopeHostBadge,
  signChatEnvelope,
  type ChatEmojiShortcut,
  type ChatEnvelope,
  type ChatReactionMutation,
  type LocalKeyPackage,
} from "./protocol";
import { persistRemovedSidebarRoom } from "./sidebar-ledger";
import {
  ChatCoordinatorClient,
  type ChatCoordinatorClientFactory,
  type ChatCoordinatorOperations,
  type RemoteJoinRequest,
} from "./coordinator-client";

const ROOM_KEY_PREFIX = "cordn-adhoc-chat-room:";
const ROOM_KEY_V2_PREFIX = `${ROOM_KEY_PREFIX}v2:`;
const ACTIVE_HOST_ROOM_KEY_PREFIX = "cordn-adhoc-active-host-room:";
export const ROOMS_CHANGED_EVENT = "cordn:rooms-changed";
/** Metadata-only signal for unread changes. It never contains message content. */
export const ROOM_UNREAD_CHANGED_EVENT = "cordn:room-unread-changed";
export const SERVER_ONLINE_EVENT = "cordn:server-online";
export const SERVER_OFFLINE_EVENT = "cordn:server-offline";

export interface StoredMessage extends ChatEnvelope {
  cursor?: number;
  pending?: boolean;
}

export interface PendingMessage {
  id: string;
  opaqueBase64: string;
}

/** A committed membership change whose Welcome still needs to reach Cordn. */
export interface PendingWelcomeDelivery {
  requestPk: string;
  requestKpRef: string;
  requestAt: number;
  targetPubkey: string;
  keyPackageRef: string;
  welcomeBase64: string;
  after: number;
}

/** Bounded latest-state record: one entry per message, emoji, and participant. */
export interface StoredReaction extends ChatReactionMutation {
  id: string;
  sender: string;
  createdAt: number;
  cursor?: number;
}

export interface ReactionSummary {
  emoji: ChatEmojiShortcut;
  count: number;
  viewerActive: boolean;
}

export interface RoomIdentity {
  name: string;
  avatar?: string;
  badgeLabel?: string;
  badgeEmoji?: string;
}

/** Immutable authority and navigation identity for a stored room. */
export type RoomTarget = Readonly<{ coordinatorPubkey: string; roomId: string }>;

export interface RoomReadState {
  version: 1;
  baselineEstablished: boolean;
  lastReadCursor: number;
  unreadCount: number;
}

interface LastOpenRoomRecord {
  version: 1;
  coordinatorPubkey: string;
  roomId: string;
}

export function roomTargetFor(room: Pick<StoredRoom, "id" | "coordinatorPubkey">): RoomTarget {
  return Object.freeze({ coordinatorPubkey: room.coordinatorPubkey, roomId: room.id });
}

/** Which kind of signer owned the room when its local authority was created. */
export type RoomIdentityOwner = "anonymous" | "external";

export interface StoredRoom {
  version: 1;
  id: string;
  title: string;
  coordinatorPubkey: string;
  coordinatorOrigin?: string;
  coordinatorName?: string;
  relayUrls: string[];
  name: string;
  avatar?: string;
  badgeLabel?: string;
  badgeEmoji?: string;
  stablePubkey: string;
  /** Durable signer provenance. Missing only on records written before Phase 15. */
  identityOwner?: RoomIdentityOwner;
  /** Retired records retain display cache only and must never create a session. */
  membershipStatus?: "active" | "retired";
  isHost: boolean;
  stateBase64: string;
  keyPackage: LocalKeyPackage;
  anonymousSecretKey?: string;
  lastCursor: number;
  messages: StoredMessage[];
  pending: PendingMessage[];
  /** Durable so a transient welcome_store failure cannot strand an admitted guest. */
  pendingWelcomes?: PendingWelcomeDelivery[];
  /** Optional because rooms persisted before unread accounting have no ledger. */
  readState?: RoomReadState;
  /** Optional for version-1 cached rooms written before reactions existed. */
  reactions?: StoredReaction[];
  autoApprove?: boolean;
  inviteToken?: string;
  host?: RoomHostIdentity;
  coordinatorKeyMode?: CoordinatorKeyMode;
  joinRequestSent?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface AnonymousMembershipImpact {
  count: number;
}

export interface MembershipRetirementJournal {
  count: number;
  commit(): void;
  rollback(): void;
}

export interface RoomStatus {
  connection: "connecting" | "connected" | "offline";
  detail?: string;
}

/**
 * Canonical Cordn clients identify an invitation by its group id and do not
 * send CAHMLS's optional rotating token. A present token is therefore an
 * additional freshness check, not a requirement for protocol admission.
 */
export function isCurrentInviteRequest(
  inviteToken: string | undefined,
  request: Pick<RemoteJoinRequest, "invite_token">,
): boolean {
  return !inviteToken || !request.invite_token || request.invite_token === inviteToken;
}

export class ChatRoomSession {
  private client: ChatCoordinatorOperations | null = null;
  private timer: number | null = null;
  private joinRequestUnsubscribe: (() => void) | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private pendingSync: Promise<void> | null = null;
  private serverWasOnline = false;
  private stopped = false;
  private persistenceEnabled = true;
  private lifecycleGeneration = 0;
  private hasCompletedInitialMessageSync = false;
  private readonly knownJoinRequestIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  status: RoomStatus = { connection: "connecting" };
  pendingJoinRequests: RemoteJoinRequest[] = [];
  /**
   * Why the last admission attempt could not admit everyone. Admission runs on
   * a poll, so a failure that stays in the console reads to the host as a
   * button that silently does nothing.
   */
  admissionError: string | null = null;

  constructor(
    public room: StoredRoom,
    private signer: NostrSigner,
    private readonly createClient: ChatCoordinatorClientFactory = (target, clientSigner) =>
      new ChatCoordinatorClient(target, clientSigner),
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.stopped = false;
    this.detachSteadyState();
    await this.sync();
    if (this.stopped || generation !== this.lifecycleGeneration) return;
    this.attachSteadyState(generation);
  }

  /**
   * Continue polling after a successful startup recovery without performing a
   * second synchronous fetch inside the coordinator's recovery deadline.
   */
  activateSteadyState(): void {
    if (this.stopped) return;
    this.attachSteadyState(this.lifecycleGeneration);
  }

  /**
   * Perform one startup-only synchronization attempt. Recovery deliberately
   * avoids the steady-state offline path: the coordinator owns retry and may
   * discard this session after an aborted or failed attempt.
   */
  async recover(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException("Recovery cancelled", "AbortError");
    const generation = ++this.lifecycleGeneration;
    this.stopped = false;
    this.detachSteadyState();
    const abort = () => {
      if (generation !== this.lifecycleGeneration) return;
      this.lifecycleGeneration += 1;
      this.stopped = true;
      void this.client?.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.runExclusive(() => this.recoverOnce(generation, signal));
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    this.stopped = true;
    this.detachSteadyState();
    void this.client?.close();
    this.client = null;
  }

  private attachSteadyState(generation: number): void {
    this.detachSteadyState();
    if (this.stopped || generation !== this.lifecycleGeneration) return;
    if (this.room.isHost && this.client?.subscribeJoinRequests) {
      this.joinRequestUnsubscribe = this.client.subscribeJoinRequests(
        this.room.id,
        () => this.syncAfterJoinRequest(generation),
      );
    }
    this.timer = window.setInterval(() => {
      if (this.stopped || generation !== this.lifecycleGeneration) return;
      void this.sync();
    }, 4_000);
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
  }

  private detachSteadyState(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    this.joinRequestUnsubscribe?.();
    this.joinRequestUnsubscribe = null;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
  }

  private async syncAfterJoinRequest(generation: number): Promise<void> {
    if (this.stopped || generation !== this.lifecycleGeneration) return;
    const syncAlreadyInFlight = this.pendingSync !== null;
    await this.sync();
    // If the signal arrived after an in-flight sync had already fetched its
    // requests, perform one more pass so the request cannot wait for polling.
    if (
      syncAlreadyInFlight
      && !this.stopped
      && generation === this.lifecycleGeneration
    ) {
      await this.sync();
    }
  }

  /**
   * Permanently stop this session without allowing an in-flight operation to
   * write the room back to local storage. Use this before deleting or leaving
   * a room; `stop()` alone intentionally remains restartable.
   */
  discard(): void {
    this.persistenceEnabled = false;
    this.stop();
  }

  async send(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    await this.runExclusive(async () => {
      if (this.stopped || this.status.connection !== "connected") {
        throw new Error("The coordinator must be connected before you can send a message");
      }
      if (this.room.joinRequestSent) {
        throw new Error("Wait for the host to admit you before sending a message");
      }
      const event = await signChatEnvelope({
        type: "message",
        id: crypto.randomUUID(),
        sender: this.room.stablePubkey,
        name: this.room.name,
        avatar: this.room.avatar,
        badgeLabel: this.room.badgeLabel,
        badgeEmoji: this.room.badgeEmoji,
        content: trimmed,
        createdAt: Date.now(),
      }, this.signer);
      const encrypted = await encryptMessage(decodeState(this.room.stateBase64), event);
      this.room.stateBase64 = encodeState(encrypted.state);
      this.room.messages = [...this.room.messages, { ...event, pending: true }];
      this.room.pending = [...this.room.pending, { id: event.id, opaqueBase64: encrypted.opaqueBase64 }];
      this.persist();
      this.emit();
      await this.syncOnce();
    });
  }

  async setReaction(targetMessageId: string, emoji: ChatEmojiShortcut, active: boolean): Promise<void> {
    await this.runExclusive(async () => {
      if (this.stopped || this.status.connection !== "connected") {
        throw new Error("The coordinator must be connected before you can react");
      }
      if (this.room.joinRequestSent) throw new Error("Wait for the host to admit you before reacting");
      const targetMessage = this.room.messages.find((message) => message.id === targetMessageId);
      if (!targetMessage) {
        throw new Error("That message is no longer available for reactions");
      }
      if (targetMessage.sender === this.room.stablePubkey) {
        throw new Error("You cannot react to your own message");
      }
      if (!(CHAT_EMOJI_SHORTCUTS as readonly string[]).includes(emoji)) {
        throw new Error("That emoji is not available as a reaction");
      }
      const event = await signChatEnvelope({
        type: "message",
        id: crypto.randomUUID(),
        sender: this.room.stablePubkey,
        name: this.room.name,
        avatar: this.room.avatar,
        badgeLabel: this.room.badgeLabel,
        badgeEmoji: this.room.badgeEmoji,
        content: `${active ? "Reacted" : "Removed reaction"} ${emoji}`,
        createdAt: Date.now(),
        reaction: {
          targetMessageId,
          targetPubkey: targetMessage.sender,
          targetKind: 9,
          emoji,
          active,
        },
      }, this.signer);
      const encrypted = await encryptMessage(decodeState(this.room.stateBase64), event);
      this.room.stateBase64 = encodeState(encrypted.state);
      this.applyReaction(event);
      this.room.pending = [...this.room.pending, { id: event.id, opaqueBase64: encrypted.opaqueBase64 }];
      this.persist();
      this.emit();
      await this.syncOnce();
    });
  }

  async toggleReaction(targetMessageId: string, emoji: ChatEmojiShortcut): Promise<void> {
    const current = reactionSummary(this.room, targetMessageId, this.room.stablePubkey)
      .find((reaction) => reaction.emoji === emoji);
    await this.setReaction(targetMessageId, emoji, !current?.viewerActive);
  }

  setIdentity(identity: RoomIdentity): void {
    this.room.name = identity.name.trim() || (this.room.isHost ? "Host" : "Anonymous");
    this.room.avatar = identity.avatar?.trim() || undefined;
    this.room.badgeLabel = identity.badgeLabel?.trim() || undefined;
    this.room.badgeEmoji = identity.badgeEmoji?.trim() || undefined;
    if (this.room.isHost) {
      this.room.host = normalizeRoomHostIdentity({
        name: this.room.name,
        pubkey: this.room.stablePubkey,
        avatar: this.room.avatar,
      });
    }
    this.persist();
    this.emit();
  }

  async setAutoApprove(enabled: boolean): Promise<void> {
    await this.runExclusive(async () => {
      this.room.autoApprove = enabled;
      this.persist();
      await this.syncOnce();
    });
  }

  async approveJoinRequests(): Promise<void> {
    await this.runExclusive(async () => {
      const client = this.getClient();
      const requests = this.pendingJoinRequests.length > 0
        ? [...this.pendingJoinRequests]
        : this.currentInviteRequests(await client.fetchJoinRequests(this.room.id));
      const result = await this.acceptJoinRequests(client, requests);
      this.recordJoinedGuests(result.accepted);
      this.pendingJoinRequests = result.retryable;
      await this.syncOnce();
    });
  }

  /** Persist acknowledgement on the live room so a later sync cannot restore stale unread. */
  markRead(): void {
    const previousCount = roomUnreadCount(this.room);
    this.room.readState = {
      version: 1,
      baselineEstablished: true,
      lastReadCursor: safeCursor(this.room.lastCursor),
      unreadCount: 0,
    };
    this.persist();
    this.emit();
    if (previousCount > 0) emitUnreadChange(this.room, previousCount, 0);
  }

  async sync(): Promise<void> {
    if (this.stopped) return;
    if (this.pendingSync) return this.pendingSync;
    const operation = this.runExclusive(() => this.syncOnce());
    this.pendingSync = operation;
    try {
      await operation;
    } finally {
      if (this.pendingSync === operation) this.pendingSync = null;
    }
  }

  private async syncOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.status.connection !== "connected" && this.status.connection !== "offline") {
      this.status = { connection: "connecting" };
      this.emit();
    }
    try {
      const client = this.getClient();
      if (this.room.isHost) {
        this.recordJoinedGuests(await this.flushPendingWelcomes(client));
        const requests = this.currentInviteRequests(await client.fetchJoinRequests(this.room.id));
        const newRequests = requests.filter((request) => !this.knownJoinRequestIds.has(request.kp_ref));
        for (const request of requests) this.knownJoinRequestIds.add(request.kp_ref);
        if (this.room.autoApprove !== false) {
          const result = await this.acceptJoinRequests(client, requests);
          this.recordJoinedGuests(result.accepted);
          this.pendingJoinRequests = result.retryable;
        } else {
          this.recordWaitingGuests(newRequests);
          this.pendingJoinRequests = requests;
        }
      }
      if (!this.room.isHost && this.room.joinRequestSent) {
        await this.upgradeLegacyJoinRequest(client);
        await this.restoreMissingKeyPackage(client);
        await this.acceptWelcome(client);
      }
      if (!this.room.isHost && this.room.joinRequestSent) {
        this.markServerOnline("Waiting for the host to admit you");
        return;
      }
      await this.flushPending(client);
      await this.pullMessages(client);
      if (this.stopped) return;
      this.markServerOnline();
    } catch (error) {
      this.markServerOffline(error instanceof Error ? error.message : "Coordinator unavailable");
      await this.client?.close();
      this.client = null;
    } finally {
      this.persist();
      this.emit();
    }
  }

  private async recoverOnce(generation: number, signal: AbortSignal): Promise<void> {
    const active = (): boolean => !signal.aborted && !this.stopped && generation === this.lifecycleGeneration;
    if (!active()) throw new DOMException("Recovery cancelled", "AbortError");
    this.status = { connection: "connecting" };
    try {
      const client = this.getClient();
      if (this.room.isHost) {
        this.recordJoinedGuests(await this.flushPendingWelcomes(client));
        const requests = this.currentInviteRequests(await client.fetchJoinRequests(this.room.id));
        if (!active()) throw new DOMException("Recovery cancelled", "AbortError");
        const newRequests = requests.filter((request) => !this.knownJoinRequestIds.has(request.kp_ref));
        for (const request of requests) this.knownJoinRequestIds.add(request.kp_ref);
        if (this.room.autoApprove !== false) {
          const result = await this.acceptJoinRequests(client, requests);
          this.recordJoinedGuests(result.accepted);
          if (!active()) throw new DOMException("Recovery cancelled", "AbortError");
          this.pendingJoinRequests = result.retryable;
        } else {
          this.recordWaitingGuests(newRequests);
          this.pendingJoinRequests = requests;
        }
      }
      if (!this.room.isHost && this.room.joinRequestSent) {
        await this.upgradeLegacyJoinRequest(client);
        await this.acceptWelcome(client);
        if (!active()) throw new DOMException("Recovery cancelled", "AbortError");
      }
      if (!this.room.isHost && this.room.joinRequestSent) {
        this.status = { connection: "connected", detail: "Waiting for the host to admit you" };
        this.persist();
        this.emit();
        return;
      }
      await this.flushPending(client);
      if (!active()) throw new DOMException("Recovery cancelled", "AbortError");
      await this.pullMessages(client);
      if (!active()) throw new DOMException("Recovery cancelled", "AbortError");
      this.status = { connection: "connected" };
      this.persist();
      this.emit();
      if (!this.serverWasOnline) {
        this.serverWasOnline = true;
        window.dispatchEvent(new CustomEvent(SERVER_ONLINE_EVENT, {
          detail: { coordinatorPubkey: this.room.coordinatorPubkey, roomId: this.room.id },
        }));
      }
    } catch (error) {
      await this.client?.close();
      if (!active()) throw new DOMException("Recovery cancelled", "AbortError");
      this.client = null;
      this.status = { connection: "connecting" };
      throw new Error("Hosted room recovery failed", { cause: error });
    }
  }

  private handleOnline = () => void this.sync();
  private handleOffline = () => this.markServerOffline("Browser offline");

  private markServerOnline(detail?: string): void {
    this.status = { connection: "connected", detail };
    this.emit();
    if (this.serverWasOnline) return;
    this.serverWasOnline = true;
    window.dispatchEvent(new CustomEvent(SERVER_ONLINE_EVENT, {
      detail: {
        coordinatorPubkey: this.room.coordinatorPubkey,
        roomId: this.room.id,
      },
    }));
  }

  private markServerOffline(detail: string): void {
    const alreadyOffline = this.status.connection === "offline";
    this.serverWasOnline = false;
    this.status = { connection: "offline", detail };
    this.emit();
    if (alreadyOffline) return;
    window.dispatchEvent(new CustomEvent(SERVER_OFFLINE_EVENT, {
      detail: {
        coordinatorPubkey: this.room.coordinatorPubkey,
        roomId: this.room.id,
      },
    }));
  }

  private getClient(): ChatCoordinatorOperations {
    if (!this.client) {
      this.client = this.createClient(
        { coordinatorPubkey: this.room.coordinatorPubkey, relayUrls: this.room.relayUrls },
        this.signer,
      );
    }
    return this.client;
  }

  private currentInviteRequests(requests: RemoteJoinRequest[]): RemoteJoinRequest[] {
    const inFlight = new Set((this.room.pendingWelcomes ?? [])
      .map((pending) => `${pending.requestPk}:${pending.requestAt}`));
    const current = new Map<string, RemoteJoinRequest>();
    for (const request of requests) {
      if (!isCurrentInviteRequest(this.room.inviteToken, request)
        || inFlight.has(`${request.pk}:${request.at}`)) continue;
      const existing = current.get(request.kp_ref);
      if (!existing || request.at > existing.at) current.set(request.kp_ref, request);
    }
    return [...current.values()];
  }

  private async acceptJoinRequests(
    client: ChatCoordinatorOperations,
    requests: RemoteJoinRequest[],
  ): Promise<{ accepted: RemoteJoinRequest[]; retryable: RemoteJoinRequest[] }> {
    const retryable: RemoteJoinRequest[] = [];
    const failures: string[] = [];
    for (const request of requests) {
      try {
        // Prefer the exact package named by this request. A stable Nostr
        // identity can have packages from several Cordn-compatible clients;
        // consuming by identity first can produce a valid Welcome for the
        // wrong device, leaving the requester waiting forever. If that exact
        // package was rotated or evicted, retain Cordn's identity fallback so
        // a refreshed last-resort package can still complete admission.
        const consumed = await client.consumeKeyPackage(request.kp_ref)
          ?? await client.consumeKeyPackage(request.pk);
        if (!consumed) {
          // The coordinator no longer holds admission material for this
          // request. Retrying alone never recovers it; the guest has to
          // republish, so say so rather than looping in silence.
          failures.push("the invitee's key package is no longer on the coordinator");
          retryable.push(request);
          continue;
        }
        const event = consumed.event as { content?: string };
        const published = JSON.parse(event.content ?? "{}") as {
          params?: { arguments?: { kp_64?: string; keyPackageBase64?: string } };
        };
        const keyPackageBase64 = published.params?.arguments?.kp_64
          ?? published.params?.arguments?.keyPackageBase64;
        if (!keyPackageBase64) {
          console.warn("Cordn join request contained no published key package", request.pk);
          failures.push("the invitee's publication did not carry a key package");
          continue;
        }
        const added = await addMember(decodeState(this.room.stateBase64), keyPackageBase64);
        const posted = await client.postGroupMessage(this.room.id, added.commitBase64);
        this.room.stateBase64 = encodeState(added.state);
        this.room.lastCursor = Math.max(this.room.lastCursor, posted.cursor);
        this.room.pendingWelcomes = [...(this.room.pendingWelcomes ?? []), {
          requestPk: request.pk,
          requestKpRef: request.kp_ref,
          requestAt: request.at,
          targetPubkey: consumed.pk,
          keyPackageRef: consumed.kp_ref,
          welcomeBase64: added.welcomeBase64,
          after: posted.cursor,
        }];
        // Persist the advanced epoch and its delivery outbox atomically from
        // the browser's perspective before attempting the network delivery.
        // A storage failure must not interrupt the canonical post -> Welcome
        // sequence after the membership commit is already public.
        try {
          this.persist();
        } catch (error) {
          console.warn("Could not persist Cordn Welcome outbox before delivery", error);
        }
      } catch (error) {
        // A malformed or stale remote request must not take the hosted room
        // offline. Requests that failed before consumption can be retried.
        console.warn("Could not admit Cordn join request", request.pk, error);
        failures.push(error instanceof Error ? error.message : "admission failed");
        retryable.push(request);
      }
    }
    const accepted = await this.flushPendingWelcomes(client);
    this.admissionError = failures.length > 0
      ? `Could not admit ${failures.length} ${failures.length === 1 ? "invitee" : "invitees"}: ${failures[0]}`
      : null;
    return { accepted, retryable };
  }

  private async flushPendingWelcomes(client: ChatCoordinatorOperations): Promise<RemoteJoinRequest[]> {
    const accepted: RemoteJoinRequest[] = [];
    for (const pending of [...(this.room.pendingWelcomes ?? [])]) {
      try {
        await client.storeWelcome(
          pending.targetPubkey,
          pending.keyPackageRef,
          pending.welcomeBase64,
          pending.after,
        );
        this.room.pendingWelcomes = (this.room.pendingWelcomes ?? []).filter((entry) => entry !== pending);
        accepted.push({
          gid: this.room.id,
          pk: pending.requestPk,
          kp_ref: pending.requestKpRef,
          at: pending.requestAt,
        });
        this.persist();
      } catch (error) {
        // Keep the durable outbox item. A later room sync will retry it while
        // the room itself remains online and usable.
        console.warn("Could not deliver Cordn Welcome; will retry", pending.targetPubkey, error);
      }
    }
    if (accepted.length > 0) {
      try {
        await client.fetchJoinRequests(this.room.id, accepted.map(({ pk, at }) => ({ pk, at })));
      } catch (error) {
        // Welcome delivery is the admission boundary. Failure to acknowledge
        // an already-consumed request must not undo it or report a false outage.
        console.warn("Could not acknowledge admitted Cordn join requests", error);
      }
    }
    return accepted;
  }

  private recordWaitingGuests(requests: RemoteJoinRequest[]): void {
    for (const request of requests) {
      notificationCenter.record({
        category: "join_request",
        key: `${this.room.id}:${request.kp_ref}`,
        room: this.room.title,
        action: "waiting",
      });
    }
  }

  private recordJoinedGuests(requests: RemoteJoinRequest[]): void {
    for (const request of requests) {
      notificationCenter.record({
        category: "join_request",
        key: `${this.room.id}:${request.kp_ref}`,
        room: this.room.title,
        action: "joined",
      });
    }
  }

  private async acceptWelcome(client: ChatCoordinatorOperations): Promise<void> {
    const welcomes = (await client.fetchWelcomes())
      .filter((entry) => entry.kp_ref === this.room.keyPackage.reference);
    for (const welcome of welcomes) {
      try {
        const state = await joinWelcome(welcome.welcome_64, this.room.keyPackage);
        // One canonical last-resort KeyPackage can have pending Welcomes for
        // several rooms. Leave non-matching Welcomes queued for their room.
        if (groupId(state) !== this.room.id) continue;
        this.room.host = reconcileRoomHostIdentity(this.room.host, groupCreatorPubkey(state));
        this.room.stateBase64 = encodeState(state);
        this.room.lastCursor = welcome.after ?? 0;
        this.room.joinRequestSent = false;
        await client.fetchWelcomes([{ kp_ref: welcome.kp_ref, at: welcome.at }]);
        return;
      } catch {
        // The Welcome may belong to a different room sharing this reusable
        // KeyPackage. A matching Welcome later in the queue can still succeed.
      }
    }
  }

  /**
   * Rooms saved before canonical Cordn interoperability used a one-time MLS
   * KeyPackage. Cordn resolves admission by stable identity and expects a
   * reusable last-resort package, so repair those pending rooms in place on
   * their next retry. Commit the replacement locally only after both remote
   * publications succeed; a transient failure can then safely retry.
   */
  private async upgradeLegacyJoinRequest(client: ChatCoordinatorOperations): Promise<void> {
    if (this.room.isHost || !this.room.joinRequestSent || this.room.keyPackage.lastResort === true) return;
    const reusable = storedRoomEntries()
      .map(({ room }) => room)
      .find((room) => room !== this.room
        && room.coordinatorPubkey === this.room.coordinatorPubkey
        && room.stablePubkey === this.room.stablePubkey
        && room.keyPackage.lastResort === true)
      ?.keyPackage;
    const keyPackage = reusable ?? (await createKeyPackage(this.room.stablePubkey, { lastResort: true })).stored;
    await client.publishKeyPackage(keyPackage.reference, keyPackage.publicBase64);
    await client.storeJoinRequest(this.room.id, keyPackage.reference, this.room.inviteToken);
    this.room.keyPackage = keyPackage;
    this.persist();
  }

  /**
   * A pending invite is only admissible while the coordinator still holds the
   * KeyPackage the join request names. That material can disappear underneath a
   * waiting guest — a replacement publication evicts the previous last-resort
   * package, and a coordinator can restart into a fresh or temporary store.
   * Nothing else republishes it, because the legacy upgrade deliberately skips
   * rooms that already hold a last-resort package, so the host would consume
   * nothing, retry silently, and strand the invite forever. Restore it in place
   * instead: republishing is idempotent because the reference and bytes are
   * unchanged.
   */
  private async restoreMissingKeyPackage(client: ChatCoordinatorOperations): Promise<void> {
    if (this.room.isHost || !this.room.joinRequestSent) return;
    let published: string[];
    try {
      published = await client.listOwnKeyPackageRefs();
    } catch {
      // Never fail an otherwise healthy wait on an optional recovery probe.
      return;
    }
    if (published.includes(this.room.keyPackage.reference)) return;
    await client.publishKeyPackage(this.room.keyPackage.reference, this.room.keyPackage.publicBase64);
    await client.storeJoinRequest(this.room.id, this.room.keyPackage.reference, this.room.inviteToken);
  }

  private async flushPending(client: ChatCoordinatorOperations): Promise<void> {
    for (const pending of [...this.room.pending]) {
      const posted = await client.postGroupMessage(this.room.id, pending.opaqueBase64);
      this.room.lastCursor = Math.max(this.room.lastCursor, posted.cursor);
      this.room.messages = this.room.messages.map((message) => message.id === pending.id ? { ...message, cursor: posted.cursor, pending: false } : message);
      this.room.reactions = (this.room.reactions ?? []).map((reaction) => reaction.id === pending.id ? { ...reaction, cursor: posted.cursor } : reaction);
      this.room.pending = this.room.pending.filter((message) => message.id !== pending.id);
    }
  }

  private async pullMessages(client: ChatCoordinatorOperations): Promise<void> {
    const messages = await client.fetchMessages(this.room.id, this.room.lastCursor);
    let state = decodeState(this.room.stateBase64);
    const shouldNotify = this.hasCompletedInitialMessageSync;
    const hadEstablishedBaseline = this.room.readState?.baselineEstablished === true && isRoomReadState(this.room.readState);
    for (const message of messages) {
      try {
        const decoded = await decryptMessage(state, message.msg_64, {
          expectedHostPubkey: groupCreatorPubkey(state) ?? undefined,
        });
        state = decoded.state;
        this.room.lastCursor = Math.max(this.room.lastCursor, message.cursor);
        if (decoded.envelope?.reaction) {
          this.applyReaction({ ...decoded.envelope, cursor: message.cursor });
        } else if (decoded.envelope && !this.room.messages.some((entry) => entry.id === decoded.envelope?.id)) {
          this.room.messages = [...this.room.messages, { ...decoded.envelope, cursor: message.cursor }];
          if (hadEstablishedBaseline
            && hasValidChatEnvelopeAuth(decoded.envelope)
            && decoded.envelope.sender !== this.room.stablePubkey) {
            this.incrementUnread(message.cursor);
          }
          if (shouldNotify && decoded.envelope.sender !== this.room.stablePubkey) {
            notificationCenter.record({
              category: "new_message",
              key: decoded.envelope.id,
              actor: decoded.envelope.name,
              room: this.room.title,
              roomKey: roomIdentityKey(this.room.coordinatorPubkey, this.room.id),
              actorPubkey: decoded.envelope.sender,
            });
          }
        }
      } catch {
        // A stale pre-join message is intentionally ignored. Its cursor is still
        // advanced so a coordinator replay cannot trap the client in a loop.
        this.room.lastCursor = Math.max(this.room.lastCursor, message.cursor);
      }
    }
    this.room.stateBase64 = encodeState(state);
    if (!hadEstablishedBaseline) {
      this.room.readState = {
        version: 1,
        baselineEstablished: true,
        lastReadCursor: safeCursor(this.room.lastCursor),
        unreadCount: 0,
      };
    }
    this.hasCompletedInitialMessageSync = true;
  }

  private incrementUnread(cursor: number): void {
    const previousCount = roomUnreadCount(this.room);
    const unreadCount = saturatingAdd(previousCount, 1);
    if (unreadCount === previousCount) return;
    this.room.readState = {
      version: 1,
      baselineEstablished: true,
      lastReadCursor: Math.max(safeCursor(this.room.readState?.lastReadCursor), safeCursor(cursor)),
      unreadCount,
    };
    emitUnreadChange(this.room, previousCount, unreadCount);
  }

  private persist(): void {
    if (!this.persistenceEnabled) return;
    saveRoom(this.room);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private applyReaction(envelope: ChatEnvelope & { cursor?: number }): void {
    const reaction = envelope.reaction;
    if (!reaction || !hasValidChatEnvelopeAuth(envelope) || !this.room.messages.some((message) => message.id === reaction.targetMessageId)) return;
    const next: StoredReaction = {
      id: envelope.id,
      sender: envelope.sender,
      createdAt: envelope.createdAt,
      cursor: envelope.cursor,
      ...reaction,
    };
    const key = reactionKey(next);
    const prior = (this.room.reactions ?? []).find((entry) => reactionKey(entry) === key);
    if (prior && !isLaterReaction(next, prior)) return;
    this.room.reactions = [...(this.room.reactions ?? []).filter((entry) => reactionKey(entry) !== key), next];
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function createHostedRoom(input: { title: string; coordinatorPubkey: string; relayUrls: string[]; signer: NostrSigner; identityOwner: RoomIdentityOwner; coordinatorOrigin?: string; coordinatorName?: string; autoApprove?: boolean; identity?: RoomIdentity; coordinatorKeyMode?: CoordinatorKeyMode }): Promise<StoredRoom> {
  const stablePubkey = await input.signer.getPublicKey();
  const key = await createKeyPackage(stablePubkey);
  const title = input.title.trim() || "Untitled chat";
  const state = await createRoomState(key.keyPackage, key.privateKeyPackage, {
    name: title,
    adminPubkeys: [stablePubkey],
  });
  const name = input.identity?.name.trim() || "Host";
  const avatar = input.identity?.avatar?.trim() || undefined;
  const room: StoredRoom = {
    version: 1,
    id: groupId(state),
    title,
    coordinatorPubkey: input.coordinatorPubkey,
    coordinatorOrigin: input.coordinatorOrigin ?? window.location.origin,
    coordinatorName: input.coordinatorName?.trim() || undefined,
    relayUrls: input.relayUrls,
    name,
    avatar,
    badgeLabel: input.identity?.badgeLabel?.trim() || "host",
    badgeEmoji: input.identity?.badgeEmoji,
    stablePubkey,
    identityOwner: input.identityOwner,
    isHost: true,
    stateBase64: encodeState(state),
    keyPackage: key.stored,
    lastCursor: 0,
    messages: [],
    pending: [],
    reactions: [],
    autoApprove: input.autoApprove ?? true,
    inviteToken: createInviteToken(),
    host: normalizeRoomHostIdentity({ name, pubkey: stablePubkey, avatar }),
    coordinatorKeyMode: input.coordinatorKeyMode,
    createdAt: Date.now(),
  };
  saveRoom(room);
  return room;
}

export async function createJoiningRoom(input: { invite: ChatInvite; name: string; signer: NostrSigner; identityOwner: RoomIdentityOwner; avatar?: string }): Promise<StoredRoom> {
  const stablePubkey = await input.signer.getPublicKey();
  const reusable = storedRoomEntries()
    .map(({ room }) => room)
    .find((room) => room.coordinatorPubkey === input.invite.coordinatorPubkey
      && room.stablePubkey === stablePubkey
      && room.keyPackage.lastResort === true);
  const keyPackage = reusable?.keyPackage
    ?? (await createKeyPackage(stablePubkey, { lastResort: true })).stored;
  const room: StoredRoom = {
    version: 1,
    id: input.invite.groupId,
    title: input.invite.title || "Chat",
    coordinatorPubkey: input.invite.coordinatorPubkey,
    coordinatorOrigin: input.invite.coordinatorOrigin ?? window.location.origin,
    coordinatorName: input.invite.coordinatorName,
    relayUrls: input.invite.relayUrls,
    name: input.name.trim() || "Anonymous",
    avatar: input.avatar,
    stablePubkey,
    identityOwner: input.identityOwner,
    isHost: false,
    stateBase64: "",
    keyPackage,
    lastCursor: 0,
    messages: [],
    pending: [],
    reactions: [],
    inviteToken: input.invite.inviteToken,
    host: normalizeRoomHostIdentity(input.invite.host),
    coordinatorKeyMode: input.invite.coordinatorKeyMode,
    joinRequestSent: true,
    createdAt: Date.now(),
  };
  const client = new ChatCoordinatorClient({ coordinatorPubkey: room.coordinatorPubkey, relayUrls: room.relayUrls }, input.signer);
  try {
    await client.publishKeyPackage(keyPackage.reference, keyPackage.publicBase64);
    await client.storeJoinRequest(room.id, keyPackage.reference, room.inviteToken);
  } finally {
    await client.close();
  }
  saveRoom(room);
  return room;
}

/** Reject every send-capable attachment whose signer does not own this room's immutable key. */
export async function requireRoomSigner(room: Pick<StoredRoom, "stablePubkey" | "membershipStatus">, signer: NostrSigner): Promise<NostrSigner> {
  if (room.membershipStatus === "retired") {
    throw new Error("This room needs a fresh invite before it can reconnect");
  }
  if (await signer.getPublicKey() !== room.stablePubkey) {
    throw new Error("This signer does not match the identity that joined this room");
  }
  return signer;
}

/**
 * Read legacy room-local credentials only for controlled migration/retirement.
 * New rooms never write this field, and UI attachment always uses the active profile signer.
 */
export async function signerForStoredRoom(room: StoredRoom): Promise<BrowserNostrSigner | null> {
  const encoded = room.anonymousSecretKey;
  if (!encoded || !/^[0-9a-f]{64}$/i.test(encoded)) return null;
  try {
    const secret = hexToBytes(encoded);
    if (secret.length !== 32) return null;
    const signer = new BrowserNostrSigner(secret);
    await requireRoomSigner(room, signer);
    return signer;
  } catch {
    return null;
  }
}

/** Count distinct composite room memberships that would lose anonymous authority. */
export async function anonymousMembershipImpact(stablePubkey: string): Promise<AnonymousMembershipImpact> {
  const identities = new Set<string>();
  for (const { room } of storedRoomEntries()) {
    if (await belongsToAnonymousMembership(room, stablePubkey)) {
      identities.add(roomIdentityKey(room.coordinatorPubkey, room.id));
    }
  }
  return { count: identities.size };
}

/**
 * Retire local anonymous authority while retaining room presentation and decrypted cache.
 * Recovery calls this without a public key only
 * after the user explicitly accepts that ambiguous pre-provenance room access is
 * removed; explicitly external records always remain untouched. The returned journal
 * can restore every exact raw storage value until its commit boundary.
 */
export async function retireAnonymousMemberships(stablePubkey?: string): Promise<MembershipRetirementJournal> {
  const originals = new Map<string, string | null>();
  const matching = new Map<string, Array<{ key: string; room: StoredRoom }>>();
  for (const entry of storedRoomEntries()) {
    if (!await belongsToAnonymousMembership(entry.room, stablePubkey)) continue;
    const identity = roomIdentityKey(entry.room.coordinatorPubkey, entry.room.id);
    const entries = matching.get(identity) ?? [];
    entries.push(entry);
    matching.set(identity, entries);
  }

  const capture = (key: string) => {
    if (!originals.has(key)) originals.set(key, localStorage.getItem(key));
  };
  const restoreOriginals = () => {
    for (const [key, raw] of originals) {
      if (raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
    }
  };
  let count = 0;
  const affectedCompositeIdentities: string[] = [];
  try {
    for (const entries of matching.values()) {
      const authoritative = entries.find(({ key, room }) => key === roomStorageKey(room.coordinatorPubkey, room.id)) ?? entries[0];
      if (!authoritative) continue;
      const targetKey = roomStorageKey(authoritative.room.coordinatorPubkey, authoritative.room.id);
      capture(targetKey);
      for (const { key } of entries) capture(key);

      const retired: StoredRoom = {
        ...authoritative.room,
        membershipStatus: "retired",
        anonymousSecretKey: undefined,
        stateBase64: "",
        keyPackage: { reference: "", publicBase64: "", privateBase64: "" },
        pending: [],
        inviteToken: undefined,
        autoApprove: undefined,
        joinRequestSent: undefined,
        updatedAt: Date.now(),
      };
      localStorage.setItem(targetKey, JSON.stringify(retired));
      const verified = readStoredRoom(localStorage.getItem(targetKey));
      if (!sameRoomIdentity(verified, retired) || verified.membershipStatus !== "retired") {
        throw new Error("Unable to verify anonymous membership retirement");
      }

      for (const { key } of entries) {
        if (key === targetKey) continue;
        const source = readStoredRoom(localStorage.getItem(key));
        if (sameRoomIdentity(source, retired)) localStorage.removeItem(key);
      }
      count += 1;
      affectedCompositeIdentities.push(roomIdentityKey(authoritative.room.coordinatorPubkey, authoritative.room.id));
    }
  } catch (cause) {
    restoreOriginals();
    throw cause;
  }

  if (affectedCompositeIdentities.length > 0) {
    window.dispatchEvent(new CustomEvent(ROOMS_CHANGED_EVENT, {
      detail: { action: "membership-retired", affectedCompositeIdentities },
    }));
  }

  let closed = false;
  return {
    count,
    commit() {
      closed = true;
      originals.clear();
    },
    rollback() {
      if (closed) return;
      restoreOriginals();
      closed = true;
      window.dispatchEvent(new CustomEvent(ROOMS_CHANGED_EVENT, {
        detail: { action: "membership-rollback", affectedCompositeIdentities },
      }));
    },
  };
}

async function belongsToAnonymousMembership(room: StoredRoom, stablePubkey?: string): Promise<boolean> {
  if (room.identityOwner) return room.identityOwner === "anonymous" && (!stablePubkey || room.stablePubkey === stablePubkey);
  if (!stablePubkey) return true;
  const encoded = room.anonymousSecretKey;
  if (!encoded || !/^[0-9a-f]{64}$/i.test(encoded)) return false;
  try {
    const secret = hexToBytes(encoded);
    if (secret.length !== 32) return false;
    return await new BrowserNostrSigner(secret).getPublicKey() === stablePubkey;
  } catch {
    return false;
  }
}

/** Resolve an explicit host, with deterministic fallbacks for legacy rooms. */
export function hostIdentityForRoom(room: StoredRoom): RoomHostIdentity {
  const host = normalizeRoomHostIdentity(room.host);
  if (room.isHost) {
    if (host) return host;
    return normalizeRoomHostIdentity({
      name: room.name.trim() || "Host",
      pubkey: room.stablePubkey,
      avatar: room.avatar,
    }) ?? { name: room.name.trim() || "Host", pubkey: room.stablePubkey };
  }
  if (!room.joinRequestSent && room.stateBase64) {
    try {
      return reconcileRoomHostIdentity(host, groupCreatorPubkey(decodeState(room.stateBase64)));
    } catch {
      // A corrupt cached state is handled by the normal room connection flow.
    }
  }
  if (room.joinRequestSent && host) return host;
  return unknownHostIdentity();
}

/** Keep claimed presentation only when MLS proves the same creator key. */
export function reconcileRoomHostIdentity(host: RoomHostIdentity | undefined, creatorPubkey: string | null): RoomHostIdentity {
  const normalized = normalizeRoomHostIdentity(host);
  if (creatorPubkey && normalized?.pubkey.toLowerCase() === creatorPubkey.toLowerCase()) return normalized;
  return unknownHostIdentity(creatorPubkey ?? "");
}

function unknownHostIdentity(pubkey = ""): RoomHostIdentity {
  return { name: "Unknown host", pubkey };
}

export function loadRoom(id: string, coordinatorPubkey?: string): StoredRoom | null {
  try {
    if (coordinatorPubkey) {
      const stored = readStoredRoom(localStorage.getItem(roomStorageKey(coordinatorPubkey, id)));
      if (stored?.id === id && stored.coordinatorPubkey === coordinatorPubkey) return stored;

      const legacyKey = `${ROOM_KEY_PREFIX}${id}`;
      const legacy = readStoredRoom(localStorage.getItem(legacyKey));
      if (legacy?.id !== id || legacy.coordinatorPubkey !== coordinatorPubkey) return null;
      migrateLegacyRoom(legacyKey, legacy);
      return legacy;
    }

    const matches = listRooms().filter((room) => room.id === id);
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

export function listRooms(): StoredRoom[] {
  const rooms = new Map<string, { room: StoredRoom; currentKey: boolean; storageKey: string; sourceKeys: string[] }>();
  try {
    const entries: Array<{ key: string; raw: string }> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(ROOM_KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      entries.push({ key, raw });
    }

    for (const { key, raw } of entries) {
      const room = readStoredRoom(raw);
      if (!room) continue;
      const identity = roomIdentityKey(room.coordinatorPubkey, room.id);
      const currentKey = key === roomStorageKey(room.coordinatorPubkey, room.id);
      const existing = rooms.get(identity);
      if (!existing) {
        rooms.set(identity, { room, currentKey, storageKey: key, sourceKeys: [key] });
      } else {
        existing.sourceKeys.push(key);
        if (currentKey && !existing.currentKey) {
          existing.room = room;
          existing.currentKey = true;
          existing.storageKey = key;
        }
      }
    }

    for (const entry of rooms.values()) {
      if (!entry.currentKey) migrateLegacyRoom(entry.storageKey, entry.room);
    }

    for (const entry of rooms.values()) {
      const currentStorageKey = roomStorageKey(entry.room.coordinatorPubkey, entry.room.id);
      const current = readStoredRoom(localStorage.getItem(currentStorageKey));
      if (!sameRoomIdentity(current, entry.room)) continue;
      entry.room = current;
      entry.currentKey = true;
      for (const sourceKey of entry.sourceKeys) {
        if (sourceKey === currentStorageKey) continue;
        const source = readStoredRoom(localStorage.getItem(sourceKey));
        if (sameRoomIdentity(source, entry.room)) localStorage.removeItem(sourceKey);
      }
    }
  } catch {
    return [];
  }

  return Array.from(rooms.values(), ({ room }) => room).sort((left, right) => {
    const leftActivity = left.updatedAt ?? left.messages.at(-1)?.createdAt ?? left.createdAt ?? 0;
    const rightActivity = right.updatedAt ?? right.messages.at(-1)?.createdAt ?? right.createdAt ?? 0;
    return rightActivity - leftActivity || left.title.localeCompare(right.title);
  });
}

/** Read every validated persisted alias; callers that mutate authority must not use deduplicated room lists. */
function storedRoomEntries(): Array<{ key: string; room: StoredRoom }> {
  const entries: Array<{ key: string; room: StoredRoom }> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(ROOM_KEY_PREFIX)) continue;
      const room = readStoredRoom(localStorage.getItem(key));
      if (room) entries.push({ key, room });
    }
  } catch {
    return [];
  }
  return entries;
}

export function rememberLastOpenRoom(room: Pick<StoredRoom, "id" | "coordinatorPubkey">): void {
  try {
    const key = `${ACTIVE_HOST_ROOM_KEY_PREFIX}${room.coordinatorPubkey}`;
    const record: LastOpenRoomRecord = { version: 1, coordinatorPubkey: room.coordinatorPubkey, roomId: room.id };
    localStorage.setItem(key, JSON.stringify(record));
    if (localStorage.getItem(key) !== JSON.stringify(record)) localStorage.removeItem(key);
  } catch {
    // Room selection still works when storage is unavailable.
  }
}

export function loadLastOpenRoom(coordinatorPubkey: string): StoredRoom | null {
  try {
    const key = `${ACTIVE_HOST_ROOM_KEY_PREFIX}${coordinatorPubkey}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    let record: LastOpenRoomRecord | null = null;
    try {
      const value = JSON.parse(raw) as unknown;
      if (isRecord(value) && value.version === 1 && typeof value.coordinatorPubkey === "string" && typeof value.roomId === "string") {
        record = { version: 1, coordinatorPubkey: value.coordinatorPubkey, roomId: value.roomId };
      }
    } catch { /* legacy raw id handled below */ }
    if (!record && raw.length > 0) {
      const legacy = loadRoom(raw, coordinatorPubkey);
      if (legacy?.coordinatorPubkey === coordinatorPubkey) {
        rememberLastOpenRoom(legacy);
        record = { version: 1, coordinatorPubkey, roomId: legacy.id };
      }
    }
    if (!record || record.coordinatorPubkey !== coordinatorPubkey) {
      localStorage.removeItem(key);
      return null;
    }
    const room = loadRoom(record.roomId, record.coordinatorPubkey);
    if (room?.membershipStatus !== "retired" && sameRoomIdentity(room, { id: record.roomId, coordinatorPubkey })) return room;
    localStorage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

export function forgetLastOpenRoom(coordinatorPubkey: string): void {
  try {
    localStorage.removeItem(`${ACTIVE_HOST_ROOM_KEY_PREFIX}${coordinatorPubkey}`);
  } catch {
    // Nothing else depends on selection persistence.
  }
}

/** @deprecated Use the composite last-open helpers. */
export function rememberActiveHostRoom(room: StoredRoom): void { if (room.isHost) rememberLastOpenRoom(room); }
/** @deprecated Use the composite last-open helpers. */
export function loadRememberedHostRoom(coordinatorPubkey: string): StoredRoom | null { return loadLastOpenRoom(coordinatorPubkey); }
/** @deprecated Use the composite last-open helpers. */
export function forgetRememberedHostRoom(coordinatorPubkey: string): void { forgetLastOpenRoom(coordinatorPubkey); }

export function saveRoom(room: StoredRoom): void {
  room.updatedAt = Date.now();
  const currentKey = roomStorageKey(room.coordinatorPubkey, room.id);
  localStorage.setItem(currentKey, JSON.stringify(room));
  const verified = readStoredRoom(localStorage.getItem(currentKey));
  if (!sameRoomIdentity(verified, room)) return;
  const legacyKey = `${ROOM_KEY_PREFIX}${room.id}`;
  const legacy = readStoredRoom(localStorage.getItem(legacyKey));
  if (legacy?.id === room.id && legacy.coordinatorPubkey === room.coordinatorPubkey) {
    localStorage.removeItem(legacyKey);
  }
  window.dispatchEvent(new CustomEvent(ROOMS_CHANGED_EVENT, {
    detail: { roomId: room.id, coordinatorPubkey: room.coordinatorPubkey },
  }));
}

export function removeStoredRoom(
  room: Pick<StoredRoom, "id" | "coordinatorPubkey">,
  history?: { reason: "deleted" | "left"; coordinatorLabel: string },
): void {
  // Resolve the validated preference while the room still exists. Once storage is
  // removed loadLastOpenRoom can no longer distinguish this exact composite room
  // from a stale/corrupt preference.
  const remembered = loadLastOpenRoom(room.coordinatorPubkey);
  if (remembered && sameRoomIdentity(remembered, room)) {
    forgetLastOpenRoom(room.coordinatorPubkey);
  }

  const currentKey = roomStorageKey(room.coordinatorPubkey, room.id);
  const current = readStoredRoom(localStorage.getItem(currentKey));
  if (current && history) persistRemovedSidebarRoom(current, history.reason, history.coordinatorLabel);
  if (sameRoomIdentity(current, room)) localStorage.removeItem(currentKey);

  const legacyKey = `${ROOM_KEY_PREFIX}${room.id}`;
  const legacy = readStoredRoom(localStorage.getItem(legacyKey));
  if (sameRoomIdentity(legacy, room)) localStorage.removeItem(legacyKey);

  window.dispatchEvent(new CustomEvent(ROOMS_CHANGED_EVENT, {
    detail: { roomId: room.id, coordinatorPubkey: room.coordinatorPubkey, action: "removed" },
  }));
}

/** Remove every local room owned by a coordinator whose durable identity is being destroyed. */
export function removeHostedRoomsForCoordinator(coordinatorPubkey: string): void {
  const normalizedCoordinatorPubkey = coordinatorPubkey.trim().toLowerCase();
  if (!normalizedCoordinatorPubkey) return;

  const targets = new Map<string, StoredRoom>();
  for (const { room } of storedRoomEntries()) {
    if (!room.isHost || room.coordinatorPubkey.trim().toLowerCase() !== normalizedCoordinatorPubkey) continue;
    targets.set(roomIdentityKey(room.coordinatorPubkey, room.id), room);
  }

  for (const room of targets.values()) {
    removeStoredRoom(room, { reason: "deleted", coordinatorLabel: `Previous local ${room.coordinatorPubkey.slice(0, 6)}` });
  }
  forgetLastOpenRoom(coordinatorPubkey);
}

/** Return the validated exact-room unread count, never a coerced persisted value. */
export function roomUnreadCount(room: Pick<StoredRoom, "readState">): number {
  return isRoomReadState(room.readState) && room.readState.baselineEstablished ? room.readState.unreadCount : 0;
}

/** Sum only child rooms belonging to the requested coordinator, without overflow. */
export function coordinatorUnreadTotal(rooms: Iterable<Pick<StoredRoom, "coordinatorPubkey" | "readState">>, coordinatorPubkey: string): number {
  let total = 0;
  for (const room of rooms) {
    if (room.coordinatorPubkey === coordinatorPubkey) total = saturatingAdd(total, roomUnreadCount(room));
  }
  return total;
}

/** Acknowledge exactly one persisted room; same room IDs under another coordinator remain untouched. */
export function markRoomRead(target: RoomTarget): void {
  const room = loadRoom(target.roomId, target.coordinatorPubkey);
  if (!room || room.id !== target.roomId || room.coordinatorPubkey !== target.coordinatorPubkey) return;
  const previousCount = roomUnreadCount(room);
  room.readState = {
    version: 1,
    baselineEstablished: true,
    lastReadCursor: safeCursor(room.lastCursor),
    unreadCount: 0,
  };
  saveRoom(room);
  if (previousCount > 0) emitUnreadChange(room, previousCount, 0);
}

export function rotateRoomInvite(room: StoredRoom): StoredRoom {
  room.inviteToken = createInviteToken();
  saveRoom(room);
  return room;
}

function createInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The only authoritative room identity: coordinator public key plus room id. */
export function roomIdentityKey(coordinatorPubkey: string, id: string): string {
  return `${coordinatorPubkey}\u0000${id}`;
}

function roomStorageKey(coordinatorPubkey: string, id: string): string {
  return `${ROOM_KEY_V2_PREFIX}${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(id)}`;
}

function readStoredRoom(raw: string | null): StoredRoom | null {
  if (!raw) return null;
  try {
    const room = JSON.parse(raw) as unknown;
    if (!isRecord(room)
      || room.version !== 1
      || typeof room.id !== "string"
      || typeof room.title !== "string"
      || typeof room.coordinatorPubkey !== "string"
      || !isStringArray(room.relayUrls)
      || typeof room.name !== "string"
      || typeof room.stablePubkey !== "string"
      || typeof room.isHost !== "boolean"
      || typeof room.stateBase64 !== "string"
      || !isLocalKeyPackage(room.keyPackage)
      || typeof room.lastCursor !== "number"
      || !Number.isFinite(room.lastCursor)
      || !Array.isArray(room.messages)
      || !room.messages.every(isStoredMessage)
      || !Array.isArray(room.pending)
      || !room.pending.every(isPendingMessage)) return null;
    const stored = room as unknown as StoredRoom;
    stored.messages = normalizeStoredMessages(stored.messages);
    stored.pending = uniqueById(stored.pending);
    if (!Array.isArray(stored.pendingWelcomes)
      || !stored.pendingWelcomes.every(isPendingWelcomeDelivery)) {
      delete stored.pendingWelcomes;
    }
    if (!isRoomReadState(stored.readState)) delete stored.readState;
    if (stored.membershipStatus !== "active" && stored.membershipStatus !== "retired") {
      delete stored.membershipStatus;
    }
    if (stored.identityOwner !== "anonymous" && stored.identityOwner !== "external") {
      delete stored.identityOwner;
    }
    if (stored.anonymousSecretKey !== undefined && (typeof stored.anonymousSecretKey !== "string" || !/^[0-9a-f]{64}$/i.test(stored.anonymousSecretKey))) {
      delete stored.anonymousSecretKey;
    }
    if (stored.coordinatorKeyMode !== "ephemeral" && stored.coordinatorKeyMode !== "persistent") {
      delete stored.coordinatorKeyMode;
    }
    const host = normalizeRoomHostIdentity(room.host);
    if (host) stored.host = host;
    else delete stored.host;
    const expectedHostPubkey = stored.isHost
      ? stored.stablePubkey
      : verifiedCreatorPubkeyFromStoredState(stored);
    const cachedReactions = Array.isArray(room.reactions)
      ? room.reactions.filter(isStoredReaction)
      : [];
    stored.messages = stored.messages.map((message) => sanitizeChatEnvelopeHostBadge(message, expectedHostPubkey));
    for (const message of stored.messages) {
      if (message.reaction && isChatReactionMutation(message.reaction) && hasValidChatEnvelopeAuth(message)) {
        cachedReactions.push({
          id: message.id,
          sender: message.sender,
          createdAt: message.createdAt,
          cursor: message.cursor,
          ...message.reaction,
        });
      }
    }
    stored.messages = stored.messages.filter((message) => !message.reaction || !isChatReactionMutation(message.reaction) || !hasValidChatEnvelopeAuth(message));
    stored.reactions = normalizeReactionProjection(cachedReactions);
    return stored;
  } catch {
    return null;
  }
}

function isPendingWelcomeDelivery(value: unknown): value is PendingWelcomeDelivery {
  return isRecord(value)
    && typeof value.requestPk === "string"
    && typeof value.requestKpRef === "string"
    && typeof value.requestAt === "number"
    && Number.isFinite(value.requestAt)
    && typeof value.targetPubkey === "string"
    && typeof value.keyPackageRef === "string"
    && typeof value.welcomeBase64 === "string"
    && typeof value.after === "number"
    && Number.isFinite(value.after);
}

function isRoomReadState(value: unknown): value is RoomReadState {
  return isRecord(value)
    && value.version === 1
    && typeof value.baselineEstablished === "boolean"
    && isSafeNonNegativeInteger(value.lastReadCursor)
    && isSafeNonNegativeInteger(value.unreadCount);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeCursor(value: unknown): number {
  return isSafeNonNegativeInteger(value) ? value : 0;
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function emitUnreadChange(room: Pick<StoredRoom, "id" | "coordinatorPubkey">, previousCount: number, unreadCount: number): void {
  window.dispatchEvent(new CustomEvent(ROOM_UNREAD_CHANGED_EVENT, {
    detail: { coordinatorPubkey: room.coordinatorPubkey, roomId: room.id, previousCount, unreadCount },
  }));
}

function migrateLegacyRoom(storageKey: string, room: StoredRoom): void {
  const nextKey = roomStorageKey(room.coordinatorPubkey, room.id);
  const current = readStoredRoom(localStorage.getItem(nextKey));
  if (!sameRoomIdentity(current, room)) localStorage.setItem(nextKey, JSON.stringify(room));
  const verified = readStoredRoom(localStorage.getItem(nextKey));
  if (storageKey !== nextKey && sameRoomIdentity(verified, room)) {
    const source = readStoredRoom(localStorage.getItem(storageKey));
    if (sameRoomIdentity(source, room)) localStorage.removeItem(storageKey);
  }
}

export function sameRoomIdentity(left: Pick<StoredRoom, "coordinatorPubkey" | "id"> | null | undefined, right: Pick<StoredRoom, "coordinatorPubkey" | "id">): left is StoredRoom {
  return left?.coordinatorPubkey === right.coordinatorPubkey && left.id === right.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isLocalKeyPackage(value: unknown): value is LocalKeyPackage {
  return isRecord(value)
    && typeof value.reference === "string"
    && typeof value.publicBase64 === "string"
    && typeof value.privateBase64 === "string";
}

function isStoredMessage(value: unknown): value is StoredMessage {
  return isRecord(value)
    && value.type === "message"
    && typeof value.id === "string"
    && typeof value.sender === "string"
    && typeof value.name === "string"
    && typeof value.content === "string"
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && (value.auth === undefined || (isRecord(value.auth)
      && typeof value.auth.id === "string"
      && typeof value.auth.sig === "string"))
    && (value.cursor === undefined || (typeof value.cursor === "number" && Number.isFinite(value.cursor)))
    && (value.pending === undefined || typeof value.pending === "boolean");
}

function normalizeStoredMessages(messages: StoredMessage[]): StoredMessage[] {
  const normalized = new Map<string, StoredMessage>();
  for (const message of messages) {
    const existing = normalized.get(message.id);
    if (!existing) {
      normalized.set(message.id, message);
      continue;
    }
    const existingCursor = existing.cursor ?? -1;
    const nextCursor = message.cursor ?? -1;
    if (nextCursor > existingCursor || (existing.pending === true && message.pending !== true)) {
      normalized.set(message.id, message);
    }
  }
  return [...normalized.values()];
}

function uniqueById<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function verifiedCreatorPubkeyFromStoredState(room: StoredRoom): string | undefined {
  if (room.joinRequestSent || !room.stateBase64) return undefined;
  try {
    return groupCreatorPubkey(decodeState(room.stateBase64)) ?? undefined;
  } catch {
    return undefined;
  }
}

function isPendingMessage(value: unknown): value is PendingMessage {
  return isRecord(value) && typeof value.id === "string" && typeof value.opaqueBase64 === "string";
}

export function reactionSummary(room: Pick<StoredRoom, "reactions">, targetMessageId: string, viewerPubkey: string): ReactionSummary[] {
  const summaries = new Map<ChatEmojiShortcut, ReactionSummary>();
  for (const reaction of room.reactions ?? []) {
    if (reaction.targetMessageId !== targetMessageId || !reaction.active) continue;
    const summary = summaries.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, viewerActive: false };
    summary.count += 1;
    summary.viewerActive ||= reaction.sender === viewerPubkey;
    summaries.set(reaction.emoji, summary);
  }
  return [...summaries.values()];
}

function isStoredReaction(value: unknown): value is StoredReaction {
  if (!isRecord(value)) return false;
  const validMutation = isChatReactionMutation({
    targetMessageId: value.targetMessageId,
    emoji: value.emoji,
    active: value.active,
  });
  return validMutation
    && typeof value.id === "string"
    && typeof value.sender === "string"
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && (value.cursor === undefined || (typeof value.cursor === "number" && Number.isFinite(value.cursor)));
}

function normalizeReactionProjection(reactions: StoredReaction[]): StoredReaction[] {
  const latest = new Map<string, StoredReaction>();
  for (const reaction of reactions) {
    const prior = latest.get(reactionKey(reaction));
    if (!prior || isLaterReaction(reaction, prior)) latest.set(reactionKey(reaction), reaction);
  }
  return [...latest.values()];
}

function reactionKey(reaction: Pick<StoredReaction, "targetMessageId" | "emoji" | "sender">): string {
  return `${reaction.targetMessageId}\u0000${reaction.emoji}\u0000${reaction.sender}`;
}

function isLaterReaction(next: StoredReaction, prior: StoredReaction): boolean {
  if (next.cursor !== undefined && prior.cursor !== undefined && next.cursor !== prior.cursor) return next.cursor > prior.cursor;
  if (next.createdAt !== prior.createdAt) return next.createdAt > prior.createdAt;
  return next.id > prior.id;
}
