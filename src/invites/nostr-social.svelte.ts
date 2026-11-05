import type { NostrSigner } from "@contextvm/sdk/core";
import { SimplePool, type Event as NostrEvent } from "nostr-tools";
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
import { createGiftWrap, supportsNip44, unwrapGiftWrap, type Nip44Signer } from "@cahmls/sdk/client";

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

export class NostrSocialStore {
  status = $state<"idle" | "connecting" | "ready" | "error">("idle");
  following = $state<string[]>([]);
  followers = $state<string[]>([]);
  onlineContacts = $state<SocialContact[]>([]);
  incomingInvites = $state<IncomingNostrInvite[]>([]);
  error = $state("");
  private signer: Nip44Signer | null = null;
  private pubkey = "";
  private pool: SimplePool | null = null;
  private subscription: { close(): void } | null = null;
  private heartbeat: number | null = null;
  private expiryTimer: number | null = null;
  private presence: PresenceState = "invisible";
  private descriptor: PresenceDescriptor | null = null;
  private socialGraphRefreshedAt = 0;
  private readonly seen = new SvelteSet<string>();
  private readonly profiles = new SvelteMap<string, NostrProfile>();

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

    this.disconnect();
    this.signer = signer;
    this.pubkey = pubkey;
    this.pubkey = pubkey;
    this.pool = new SimplePool();
    this.status = "connecting";
    this.error = "";
    try {
      await this.refreshSocialGraph();
      this.subscribe();
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
    const [ownLists, followerCandidates] = await Promise.all([
      this.pool.querySync(SOCIAL_RELAYS, { kinds: [3], authors: [this.pubkey], limit: 10 }, { maxWait: 4_000 }),
      this.pool.querySync(SOCIAL_RELAYS, { kinds: [3], "#p": [this.pubkey], limit: 500 }, { maxWait: 4_000 }),
    ]);
    const ownLatest = ownLists.sort((left, right) => right.created_at - left.created_at)[0];
    this.following = ownLatest
      ? [...new SvelteSet(ownLatest.tags.filter((tag) => tag[0] === "p" && tag[1]).map((tag) => tag[1]!))]
      : [];

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
    this.following = [];
    this.followers = [];
    this.onlineContacts = [];
  }

  private subscribe(): void {
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
