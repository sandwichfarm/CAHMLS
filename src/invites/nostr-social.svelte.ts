import type { NostrSigner } from "@contextvm/sdk/core";
import { SimplePool, getEventHash, verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { PresenceState } from "../config/config.svelte";
import {
  createPubkeyAvatar,
  fetchNostrProfiles,
  PROFILE_RELAYS,
  type NostrProfile,
} from "../identity/user-profile.svelte";
import { notificationCenter } from "../notifications/notification-center.svelte";
import { registerChannelNotificationRelationships } from "../notifications/channel-preferences.svelte";
import { createGiftWrap, supportsNip44, unwrapGiftWrap, type Nip44Signer } from "./nostr-envelope";

const PRESENCE_RUMOR_KIND = 24133;
const INVITE_RUMOR_KIND = 24134;
const PRESENCE_TTL_MS = 120_000;
const HEARTBEAT_MS = 45_000;
export const SOCIAL_RELAYS = [...PROFILE_RELAYS];

export interface PresenceDescriptor {
  coordinatorPubkey: string;
  coordinatorOrigin: string;
  relayUrls: string[];
  coordinatorName: string;
}

export interface SocialContact {
  pubkey: string;
  name: string;
  avatar: string;
  expiresAt: number;
  descriptor?: PresenceDescriptor;
}

export interface IncomingNostrInvite {
  id: string;
  from: string;
  fromName: string;
  fromAvatar: string;
  inviteUrl: string;
  roomTitle: string;
  createdAt: number;
}

interface PresencePayload {
  type: "cordn-presence";
  state: PresenceState;
  expiresAt: number;
  descriptor?: PresenceDescriptor;
}

interface InvitePayload {
  type: "cordn-room-invite";
  id: string;
  inviteUrl: string;
  roomTitle: string;
  createdAt: number;
}

export type ContactListStatus = "idle" | "connecting" | "ready" | "reconnecting" | "error";

interface NostrSocialStoreOptions {
  createPool?: () => SimplePool;
  now?: () => number;
}

function normalizePubkey(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function contactTargets(event: NostrEvent): string[] | null {
  const targets: string[] = [];
  const seen = new SvelteSet<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "p") continue;
    const target = normalizePubkey(tag[1] ?? "");
    if (!target) return null;
    if (!seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

export function isNewerContactEvent(next: NostrEvent, current: NostrEvent | null): boolean {
  if (!current) return true;
  return next.created_at > current.created_at
    || (next.created_at === current.created_at && next.id < current.id);
}

export class NostrSocialStore {
  status = $state<"idle" | "connecting" | "ready" | "error">("idle");
  contactStatus = $state<ContactListStatus>("idle");
  contactError = $state("");
  selectedContactEvent = $state<NostrEvent | null>(null);
  contactPubkey = $state("");
  followStatus = $state<"idle" | "pending" | "success" | "error">("idle");
  followError = $state("");
  following = $state<string[]>([]);
  followers = $state<string[]>([]);
  onlineContacts = $state<SocialContact[]>([]);
  incomingInvites = $state<IncomingNostrInvite[]>([]);
  error = $state("");
  private signer: Nip44Signer | null = null;
  private pubkey = "";
  private pool: SimplePool | null = null;
  private subscription: { close(): void } | null = null;
  private contactSigner: NostrSigner | null = null;
  private contactPool: SimplePool | null = null;
  private contactSubscription: { close(): void } | null = null;
  private contactGeneration = 0;
  private contactStarting: Promise<void> | null = null;
  private pendingContactEventId: string | null = null;
  private followQueue: Promise<void> = Promise.resolve();
  private readonly createPool: () => SimplePool;
  private readonly now: () => number;
  private heartbeat: number | null = null;
  private expiryTimer: number | null = null;
  private presence: PresenceState = "invisible";
  private descriptor: PresenceDescriptor | null = null;
  private socialGraphRefreshedAt = 0;
  private readonly seen = new SvelteSet<string>();
  private readonly profiles = new SvelteMap<string, NostrProfile>();

  constructor(options: NostrSocialStoreOptions = {}) {
    this.createPool = options.createPool ?? (() => new SimplePool());
    this.now = options.now ?? (() => Date.now());
  }

  get mutuals(): string[] {
    const followers = new SvelteSet(this.followers);
    return this.following.filter((pubkey) => followers.has(pubkey));
  }

  async connect(signer: NostrSigner, presence: PresenceState, descriptor: PresenceDescriptor): Promise<void> {
    if (!supportsNip44(signer)) {
      this.status = "error";
      this.error = "This signer does not support NIP-44 private messages";
      return;
    }
    const pubkey = await signer.getPublicKey();
    this.signer = signer;
    this.presence = presence;
    this.descriptor = descriptor;
    if (this.pubkey === pubkey && this.pool) {
      await this.setPresence(presence, descriptor);
      return;
    }

    this.disconnectPresence();
    this.signer = signer;
    this.pubkey = pubkey;
    this.pool = this.createPool();
    this.status = "connecting";
    this.error = "";
    try {
      await this.refreshSocialGraph();
      this.subscribeGiftWraps();
      this.expiryTimer = window.setInterval(() => this.pruneExpired(), 10_000);
      await this.setPresence(presence, descriptor);
      this.status = "ready";
    } catch (cause) {
      this.status = "error";
      this.error = cause instanceof Error ? cause.message : "Could not start private Nostr presence";
    }
  }

  async refreshSocialGraph(): Promise<void> {
    if (!this.pool || !this.pubkey) return;
    const followerCandidates = await this.pool.querySync(
      SOCIAL_RELAYS,
      { kinds: [3], "#p": [this.pubkey], limit: 500 },
      { maxWait: 4_000 },
    );

    const candidates = [...new SvelteSet(followerCandidates.map((event) => event.pubkey))];
    const currentLists = candidates.length
      ? await this.pool.querySync(SOCIAL_RELAYS, { kinds: [3], authors: candidates, limit: Math.max(candidates.length * 2, 20) }, { maxWait: 4_000 })
      : [];
    const latestByAuthor = new SvelteMap<string, NostrEvent>();
    for (const event of currentLists) {
      const current = latestByAuthor.get(event.pubkey);
      if (!current || event.created_at > current.created_at) latestByAuthor.set(event.pubkey, event);
    }
    this.followers = [...latestByAuthor.values()]
      .filter((event) => event.tags.some((tag) => tag[0] === "p" && tag[1] === this.pubkey))
      .map((event) => event.pubkey);
    this.socialGraphRefreshedAt = Date.now();
    const mutuals = new SvelteSet(this.mutuals);
    this.onlineContacts = this.onlineContacts.filter((contact) => mutuals.has(contact.pubkey));

    const profiles = await fetchNostrProfiles([...new SvelteSet([...this.following, ...this.followers])]);
    this.profiles.clear();
    for (const [key, profile] of profiles) this.profiles.set(key, profile);
  }

  async startContactList(signer: NostrSigner): Promise<void> {
    const pubkey = normalizePubkey(await signer.getPublicKey());
    if (!pubkey) {
      this.stopContactList();
      return;
    }
    if (this.contactPubkey === pubkey && this.contactPool) {
      await this.contactStarting;
      return;
    }

    this.stopContactList();
    const generation = this.contactGeneration;
    this.contactSigner = signer;
    this.contactPubkey = pubkey;
    this.contactPool = this.createPool();
    this.contactStatus = "connecting";
    this.contactError = "";
    this.followStatus = "idle";
    this.followError = "";
    this.pendingContactEventId = null;
    this.contactSubscription = this.contactPool.subscribeMany(
      SOCIAL_RELAYS,
      { kinds: [3], authors: [pubkey] },
      { onevent: (event) => this.considerContactEvent(event, generation) },
    );
    const starting = this.refreshContactList(generation).then(() => undefined);
    this.contactStarting = starting;
    try {
      await starting;
    } finally {
      if (this.contactStarting === starting) this.contactStarting = null;
    }
  }

  stopContactList(): void {
    this.contactGeneration += 1;
    // Operations from an old identity must never hold up this identity's
    // serialized follow queue. Destroying a relay pool does not settle an
    // already-published Promise.any, so give the replacement generation its
    // own queue immediately.
    this.followQueue = Promise.resolve();
    this.contactSubscription?.close();
    this.contactSubscription = null;
    this.contactPool?.destroy();
    this.contactPool = null;
    this.contactSigner = null;
    this.contactStarting = null;
    this.pendingContactEventId = null;
    this.contactPubkey = "";
    this.selectedContactEvent = null;
    this.following = [];
    this.contactStatus = "idle";
    this.contactError = "";
    this.followStatus = "idle";
    this.followError = "";
  }

  async refreshContactList(expectedGeneration = this.contactGeneration): Promise<boolean> {
    const pool = this.contactPool;
    const pubkey = this.contactPubkey;
    if (!pool || !pubkey || expectedGeneration !== this.contactGeneration) return false;
    try {
      const events = await pool.querySync(
        SOCIAL_RELAYS,
        { kinds: [3], authors: [pubkey], limit: 10 },
        { maxWait: 4_000 },
      );
      if (expectedGeneration !== this.contactGeneration) return false;
      for (const event of events) this.considerContactEvent(event, expectedGeneration);
      if (expectedGeneration === this.contactGeneration) {
        this.contactStatus = "ready";
        this.contactError = "";
      }
      return true;
    } catch {
      if (expectedGeneration !== this.contactGeneration) return false;
      this.contactStatus = "reconnecting";
      this.contactError = "Unable to refresh contacts. Try again.";
      return false;
    }
  }

  private considerContactEvent(event: NostrEvent, generation: number): boolean {
    if (!this.isValidOwnContactEvent(event, generation)) return false;
    if (event.id === this.pendingContactEventId) return false;
    const targets = contactTargets(event);
    if (!targets || !isNewerContactEvent(event, this.selectedContactEvent)) return false;
    this.selectedContactEvent = event;
    this.following = targets;
    return true;
  }

  async follow(targetPubkey: string): Promise<void> {
    const target = normalizePubkey(targetPubkey);
    if (!target) return this.failFollow();
    const generation = this.contactGeneration;
    const operation = this.followQueue.then(
      () => this.publishFollow(target, generation),
      () => this.publishFollow(target, generation),
    );
    this.followQueue = operation.catch(() => undefined);
    return operation;
  }

  private async publishFollow(target: string, generation: number): Promise<void> {
    if (generation !== this.contactGeneration) return this.failFollow(generation);
    const signer = this.contactSigner;
    const pool = this.contactPool;
    const pubkey = this.contactPubkey;
    if (!signer || !pool || !pubkey) return this.failFollow(generation);

    this.followStatus = "pending";
    this.followError = "";
    if (!await this.refreshContactList(generation) || generation !== this.contactGeneration) return this.failFollow(generation);

    const signed = await signer.signEvent(this.nextContactEvent(target));
    if (!this.isValidOwnContactEvent(signed, generation)) return this.failFollow(generation);

    this.pendingContactEventId = signed.id;
    try {
      await Promise.any(pool.publish(SOCIAL_RELAYS, signed));
      if (generation !== this.contactGeneration || this.contactPool !== pool) return this.failFollow(generation);
      this.pendingContactEventId = null;
      this.considerContactEvent(signed, generation);
      this.followStatus = "success";
      this.followError = "";
    } catch {
      if (this.pendingContactEventId === signed.id) this.pendingContactEventId = null;
      return this.failFollow(generation);
    }
  }

  private nextContactEvent(target: string): { kind: number; created_at: number; tags: string[][]; content: string } {
    const base = this.selectedContactEvent;
    const tags: string[][] = [];
    const seenTargets = new SvelteSet<string>();
    for (const tag of base?.tags ?? []) {
      if (tag[0] !== "p") {
        tags.push([...tag]);
        continue;
      }
      const existing = normalizePubkey(tag[1] ?? "");
      if (existing && !seenTargets.has(existing)) {
        seenTargets.add(existing);
        tags.push([...tag]);
      }
    }
    if (!seenTargets.has(target)) tags.push(["p", target]);
    return {
      kind: 3,
      created_at: Math.max(Math.floor(this.now() / 1_000), (base?.created_at ?? 0) + 1),
      tags,
      content: base?.content ?? "",
    };
  }

  private isValidOwnContactEvent(event: NostrEvent, generation: number): boolean {
    return generation === this.contactGeneration
      && event.kind === 3
      && event.pubkey === this.contactPubkey
      && event.id === getEventHash(event)
      && verifyEvent(event)
      && contactTargets(event) !== null;
  }

  private failFollow(generation = this.contactGeneration): never {
    const message = "Unable to follow on Nostr. Try again.";
    if (generation === this.contactGeneration) {
      this.followStatus = "error";
      this.followError = message;
    }
    throw new Error(message);
  }

  async setPresence(state: PresenceState, descriptor = this.descriptor): Promise<void> {
    this.presence = state;
    if (descriptor) this.descriptor = descriptor;
    if (!this.signer || !this.pool) return;
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.publishPresence();
    if (state === "online") {
      this.heartbeat = window.setInterval(() => void this.publishPresence(), HEARTBEAT_MS);
    }
  }

  async sendInvite(recipient: string, inviteUrl: string, roomTitle: string): Promise<void> {
    if (!this.signer || !this.pool) throw new Error("Connect a NIP-07 or NIP-46 identity first");
    await this.refreshSocialGraph();
    const eligibilityError = inviteEligibilityError(recipient, this.mutuals, this.onlineContacts);
    if (eligibilityError) throw new Error(eligibilityError);
    const payload: InvitePayload = {
      type: "cordn-room-invite",
      id: crypto.randomUUID(),
      inviteUrl,
      roomTitle,
      createdAt: Date.now(),
    };
    const event = await createGiftWrap(this.signer, recipient, INVITE_RUMOR_KIND, payload, 1059);
    await Promise.any(this.pool.publish(SOCIAL_RELAYS, event));
  }

  dismissInvite(id: string): void {
    this.resolveInvite(id);
  }

  resolveInvite(id: string): void {
    notificationCenter.resolveInvitation(id);
    this.incomingInvites = this.incomingInvites.filter((invite) => invite.id !== id);
  }

  disconnect(): void {
    this.stopContactList();
    this.disconnectPresence();
  }

  disconnectPresence(): void {
    this.subscription?.close();
    this.subscription = null;
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    if (this.expiryTimer !== null) window.clearInterval(this.expiryTimer);
    this.heartbeat = null;
    this.expiryTimer = null;
    this.pool?.destroy();
    this.pool = null;
    this.pubkey = "";
    this.signer = null;
    this.status = "idle";
    this.followers = [];
    this.onlineContacts = [];
  }

  private subscribeGiftWraps(): void {
    if (!this.pool || !this.signer) return;
    const since = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
    this.subscription = this.pool.subscribeMany(
      SOCIAL_RELAYS,
      { kinds: [1059, 21059], "#p": [this.pubkey], since },
      { onevent: (event) => void this.receive(event) },
    );
  }

  private async receive(event: NostrEvent): Promise<void> {
    if (!this.signer || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    try {
      const envelope = await unwrapGiftWrap(this.signer, event);
      if (envelope.kind === PRESENCE_RUMOR_KIND) this.receivePresence(envelope.sender, envelope.payload);
      if (envelope.kind === INVITE_RUMOR_KIND) await this.receiveInvite(envelope.sender, envelope.payload);
    } catch {
      // Invalid or undecryptable envelopes are intentionally ignored at ingress.
    }
  }

  private receivePresence(sender: string, value: unknown): void {
    if (!this.mutuals.includes(sender) || !isPresencePayload(value)) return;
    const wasOnline = this.onlineContacts.some((contact) => contact.pubkey === sender && contact.expiresAt > Date.now());
    this.onlineContacts = this.onlineContacts.filter((contact) => contact.pubkey !== sender);
    if (value.state !== "online" || value.expiresAt <= Date.now()) return;
    const profile = this.profiles.get(sender);
    const name = profile?.display_name?.trim() || profile?.name?.trim() || "anon";
    this.onlineContacts = [...this.onlineContacts, {
      pubkey: sender,
      name,
      avatar: profile?.picture?.trim() || createPubkeyAvatar(sender),
      expiresAt: value.expiresAt,
      descriptor: value.descriptor,
    }].sort((left, right) => left.name.localeCompare(right.name));
    if (!wasOnline) notificationCenter.record({ category: "user_online", key: sender, actor: name });
  }

  private async receiveInvite(sender: string, value: unknown): Promise<void> {
    if (Date.now() - this.socialGraphRefreshedAt > 60_000) await this.refreshSocialGraph();
    if (!shouldAcceptInvite(sender, this.following) || !isInvitePayload(value)) return;
    if (this.incomingInvites.some((invite) => invite.id === value.id) || notificationCenter.isInvitationResolved(value.id)) return;
    let profile = this.profiles.get(sender);
    if (!profile) {
      profile = (await fetchNostrProfiles([sender])).get(sender);
      if (profile) this.profiles.set(sender, profile);
    }
    const fromName = profile?.display_name?.trim() || profile?.name?.trim() || "anon";
    this.incomingInvites = [...this.incomingInvites, {
      id: value.id,
      from: sender,
      fromName,
      fromAvatar: profile?.picture?.trim() || createPubkeyAvatar(sender),
      inviteUrl: value.inviteUrl,
      roomTitle: value.roomTitle,
      createdAt: value.createdAt,
    }];
    notificationCenter.record({ category: "room_invite", key: value.id, actor: fromName, room: value.roomTitle });
  }

  private async publishPresence(): Promise<void> {
    if (!this.signer || !this.pool) return;
    const payload: PresencePayload = {
      type: "cordn-presence",
      state: this.presence,
      expiresAt: this.presence === "online" ? Date.now() + PRESENCE_TTL_MS : Date.now(),
      descriptor: this.presence === "online" ? this.descriptor ?? undefined : undefined,
    };
    await Promise.allSettled(this.followers.map(async (recipient) => {
      const event = await createGiftWrap(this.signer!, recipient, PRESENCE_RUMOR_KIND, payload, 21059);
      await Promise.any(this.pool!.publish(SOCIAL_RELAYS, event));
    }));
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.onlineContacts = this.onlineContacts.filter((contact) => contact.expiresAt > now);
  }
}

function isPresencePayload(value: unknown): value is PresencePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PresencePayload>;
  return candidate.type === "cordn-presence"
    && (candidate.state === "online" || candidate.state === "invisible" || candidate.state === "offline")
    && typeof candidate.expiresAt === "number";
}

function isInvitePayload(value: unknown): value is InvitePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InvitePayload>;
  return candidate.type === "cordn-room-invite"
    && typeof candidate.id === "string"
    && typeof candidate.inviteUrl === "string"
    && typeof candidate.roomTitle === "string"
    && typeof candidate.createdAt === "number";
}

export const nostrSocialStore = new NostrSocialStore();
registerChannelNotificationRelationships(() => ({ following: nostrSocialStore.following, mutuals: nostrSocialStore.mutuals }));

export function inviteEligibilityError(
  recipient: string,
  mutuals: string[],
  onlineContacts: Array<Pick<SocialContact, "pubkey" | "expiresAt">>,
  now = Date.now(),
): string | null {
  if (!mutuals.includes(recipient)) return "Invites can only be sent to mutual follows";
  if (!onlineContacts.some((contact) => contact.pubkey === recipient && contact.expiresAt > now)) {
    return "This mutual is not currently online";
  }
  return null;
}

export function shouldAcceptInvite(sender: string, following: string[]): boolean {
  return following.includes(sender);
}
