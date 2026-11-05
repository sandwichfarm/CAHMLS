import { ExtensionSigner, NostrConnectSigner } from "applesauce-signers/signers";
import type { NostrPool } from "applesauce-signers";
import type { NostrSigner } from "@contextvm/sdk/core";
import { SimplePool, type Event as NostrEvent, type Filter } from "nostr-tools";
import { Observable } from "rxjs";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import {
  createAnonymousIdentity,
  loadAnonymousIdentity,
  prepareAnonymousIdentityReplacement,
} from "./anonymous-identity";
import type { BrowserNostrSigner } from "../crypto/browser-nostr-signer";
import { retireAnonymousMemberships, type MembershipRetirementJournal } from "../chat/room-store";

export const PROFILE_RELAYS = ["wss://purplepag.es", "wss://relay.damus.io"] as const;
export const NIP46_CONNECT_RELAYS = ["wss://bucket.coracle.social"] as const;
const NIP07_SESSION_STORAGE_KEY = "cordn:v1:nip07-session";
const NIP07_STARTUP_WAIT_MS = 1_000;
const NIP07_STARTUP_POLL_MS = 25;
export const ANONYMOUS_IDENTITY_RECOVERY_STORAGE_KEY = "cordn:v1:anonymous-identity-recovery";

export type UserAuthMethod = "anonymous" | "nip07" | "nip46";
export type UserProfileStatus = "idle" | "connecting" | "loading" | "ready" | "error";

export interface NostrProfile {
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  about?: string;
}

interface NostrConnectPool {
  adapter: NostrPool;
  destroy: () => void;
}

export interface AnonymousSessionLifecycle {
  stablePubkey: string;
  retire: () => void | Promise<void>;
  restore: () => void | Promise<void>;
}

export class UserProfileStore {
  method = $state<UserAuthMethod>("anonymous");
  pubkey = $state("");
  anonymousName = $state("");
  profile = $state<NostrProfile | null>(null);
  status = $state<UserProfileStatus>("idle");
  error = $state("");
  initialized = $state(false);
  recoveryRequired = $state(false);
  rotationInProgress = $state(false);
  private signer: NostrSigner | null = null;
  private anonymousSigner: BrowserNostrSigner | null = null;
  private remoteSigner: NostrConnectSigner | null = null;
  private remotePool: NostrConnectPool | null = null;
  private initialization: Promise<void> | null = null;
  private anonymousSessions = new SvelteSet<AnonymousSessionLifecycle>();

  get displayName(): string {
    return this.profile?.display_name?.trim()
      || this.profile?.name?.trim()
      || this.anonymousName.trim()
      || "anon";
  }

  get authLabel(): string {
    if (this.method === "nip07") return "NIP-07";
    if (this.method === "nip46") return "NIP-46";
    return "local";
  }

  get avatarUrl(): string {
    return this.profile?.picture?.trim() || createPubkeyAvatar(this.pubkey || "anon");
  }

  get nip07Available(): boolean {
    return typeof window !== "undefined" && "nostr" in window;
  }

  get activeSigner(): NostrSigner | null {
    return this.method === "anonymous" ? this.anonymousSigner : this.signer;
  }

  get hasIdentity(): boolean {
    return this.pubkey.trim().length > 0;
  }

  initialize(anonymousName = ""): Promise<void> {
    if (this.initialization) {
      if (this.initialized) this.setAnonymousName(anonymousName);
      return this.initialization;
    }
    this.initialization ??= this.bootstrap(anonymousName);
    return this.initialization;
  }

  setAnonymousName(name = ""): void {
    this.anonymousName = name;
  }

  setAnonymous(_legacyPubkey: string, name = ""): void {
    this.setAnonymousName(name);
  }

  registerAnonymousSession(lifecycle: AnonymousSessionLifecycle): () => void {
    this.anonymousSessions.add(lifecycle);
    return () => this.anonymousSessions.delete(lifecycle);
  }

  async rotateAnonymousIdentity(): Promise<void> {
    if (this.method !== "anonymous" || this.recoveryRequired) throw new Error("Local identity rotation is unavailable");
    if (this.rotationInProgress) return;
    const oldSigner = this.anonymousSigner;
    if (!oldSigner) throw new Error("Local identity rotation is unavailable");

    this.rotationInProgress = true;
    this.error = "";
    let candidate: Awaited<ReturnType<typeof prepareAnonymousIdentityReplacement>> | null = null;
    let journal: MembershipRetirementJournal | null = null;
    const retiredSessions: AnonymousSessionLifecycle[] = [];
    let crossedBoundary = false;
    let wroteRecoveryMarker = false;
    try {
      candidate = await prepareAnonymousIdentityReplacement();
      const stablePubkey = await oldSigner.getPublicKey();
      if (!writeRecoveryMarker()) throw new Error("Unable to set the local recovery boundary");
      wroteRecoveryMarker = true;

      // Once this marker is persisted, a process crash must take the conservative
      // recovery path instead of silently resuming a partially retired identity.
      for (const lifecycle of this.anonymousSessions) {
        if (lifecycle.stablePubkey !== stablePubkey) continue;
        await lifecycle.retire();
        retiredSessions.push(lifecycle);
      }
      journal = await retireAnonymousMemberships(stablePubkey);
      crossedBoundary = true;

      this.anonymousSigner = null;
      oldSigner.destroy();
      if (!candidate.commit()) throw new Error("Unable to write the new local identity");
      journal.commit();

      this.anonymousSigner = candidate.signer;
      this.pubkey = candidate.pubkey;
      this.profile = null;
      this.status = "ready";
      this.error = "";
      this.recoveryRequired = false;
      if (!clearRecoveryMarker()) throw new Error("Unable to acknowledge the new local identity");
    } catch (cause) {
      candidate?.abort();
      if (!crossedBoundary) {
        let rollbackSucceeded = false;
        try {
          journal?.rollback();
          for (const lifecycle of retiredSessions.reverse()) await lifecycle.restore();
          this.anonymousSigner = oldSigner;
          rollbackSucceeded = !wroteRecoveryMarker || clearRecoveryMarker();
        } catch {
          // A failed rollback must retain the marker so a reload stays conservative.
        }
        if (rollbackSucceeded) {
          throw new Error("Unable to rotate your identity. Your current identity and local room access are unchanged. Try again.", { cause });
        }
      }
      this.enterRecovery("Identity replacement was interrupted. Create a new identity to continue.");
      throw cause;
    } finally {
      this.rotationInProgress = false;
    }
  }

  async recoverAnonymousIdentity(): Promise<void> {
    if (!this.recoveryRequired || this.rotationInProgress) return;
    this.rotationInProgress = true;
    this.error = "";
    let candidate: Awaited<ReturnType<typeof prepareAnonymousIdentityReplacement>> | null = null;
    let journal: MembershipRetirementJournal | null = null;
    let crossedBoundary = false;
    let wroteRecoveryMarker = false;
    try {
      candidate = await prepareAnonymousIdentityReplacement();
      // Recovery is an explicit consent boundary: the corrupt identity cannot
      // prove ownership of pre-provenance rooms, so retire their local authority
      // before any replacement signer is published.
      if (!hasRecoveryMarker()) {
        if (!writeRecoveryMarker()) throw new Error("Unable to set the local recovery boundary");
        wroteRecoveryMarker = true;
      }
      journal = await retireAnonymousMemberships();
      crossedBoundary = true;
      if (!candidate.commit()) throw new Error("Unable to write the new local identity");
      journal.commit();
      this.anonymousSigner = candidate.signer;
      this.pubkey = candidate.pubkey;
      this.profile = null;
      this.status = "ready";
      this.error = "";
      this.recoveryRequired = false;
      this.initialized = true;
      if (!clearRecoveryMarker()) throw new Error("Unable to acknowledge the new local identity");
    } catch {
      candidate?.abort();
      if (!crossedBoundary) {
        try {
          journal?.rollback();
          if (wroteRecoveryMarker && !clearRecoveryMarker()) throw new Error("Unable to clear the local recovery boundary");
        } catch {
          // A failed rollback or marker clear must preserve recovery on reload.
        }
      }
      this.enterRecovery("Unable to create a new local identity. No identity is active. Try again.");
      throw new Error(this.error);
    } finally {
      this.rotationInProgress = false;
    }
  }

  private async showAnonymousIdentity(): Promise<void> {
    if (!this.anonymousSigner) return;
    this.pubkey = await this.anonymousSigner.getPublicKey();
    this.profile = null;
    this.status = "ready";
  }

  async connectNip07(): Promise<NostrSigner> {
    this.status = "connecting";
    this.error = "";
    try {
      const signer = new ExtensionSigner() as unknown as NostrSigner;
      await this.adoptSigner(signer, "nip07");
      return signer;
    } catch (cause) {
      this.status = "error";
      this.error = cause instanceof Error ? cause.message : "Could not connect the NIP-07 signer";
      throw cause;
    }
  }

  private async restoreNip07Session(): Promise<boolean> {
    if (this.method !== "anonymous" || !hasStoredNip07Session() || !(await waitForNip07Availability())) return false;
    try {
      await this.connectNip07();
      return true;
    } catch {
      this.status = "ready";
      this.error = "";
      return false;
    }
  }

  async connectNip46(bunkerUri: string): Promise<NostrSigner> {
    this.status = "connecting";
    this.error = "";
    const connection = createNostrConnectPool();
    try {
      const parsed = NostrConnectSigner.parseBunkerURI(bunkerUri.trim());
      const remote = new NostrConnectSigner({
        relays: parsed.relays,
        remote: parsed.remote,
        bunkerSecret: parsed.bunkerSecret ?? parsed.secret,
        pool: connection.adapter,
      });
      await withTimeout(remote.connect(parsed.bunkerSecret ?? parsed.secret), 20_000, "Remote signer timed out");
      this.remoteSigner = remote;
      this.remotePool?.destroy();
      this.remotePool = connection;
      await this.adoptSigner(remote as unknown as NostrSigner, "nip46");
      return remote as unknown as NostrSigner;
    } catch (cause) {
      connection.destroy();
      this.status = "error";
      this.error = cause instanceof Error ? cause.message : "Could not connect the NIP-46 signer";
      throw cause;
    }
  }

  createNip46Request(relays: readonly string[] = NIP46_CONNECT_RELAYS): { signer: NostrConnectSigner; uri: string } {
    this.status = "connecting";
    this.error = "";
    const connection = createNostrConnectPool();
    const signer = new NostrConnectSigner({ relays: [...relays], pool: connection.adapter });
    this.remoteSigner = signer;
    this.remotePool?.destroy();
    this.remotePool = connection;
    return {
      signer,
      uri: signer.getNostrConnectURI({ name: "Cordn Ad-Hoc", url: window.location.origin }),
    };
  }

  async adoptNip46(signer: NostrConnectSigner): Promise<NostrSigner> {
    await this.adoptSigner(signer as unknown as NostrSigner, "nip46");
    return signer as unknown as NostrSigner;
  }

  cancelNip46Request(signer: NostrConnectSigner, closeSigner = true): void {
    if (this.remoteSigner !== signer || this.method !== "anonymous") return;
    if (closeSigner) void signer.close();
    this.remotePool?.destroy();
    this.remotePool = null;
    this.remoteSigner = null;
    this.status = "ready";
    this.error = "";
  }

  async logout(): Promise<void> {
    try {
      await this.remoteSigner?.logout();
    } catch {
      // A remote signer may already be offline; local logout still succeeds.
    }
    this.remotePool?.destroy();
    this.remotePool = null;
    this.remoteSigner = null;
    this.signer = null;
    clearStoredNip07Session();
    this.method = "anonymous";
    this.profile = null;
    this.error = "";
    await this.showAnonymousIdentity();
  }

  async refreshProfile(): Promise<void> {
    if (this.method === "anonymous" || !this.pubkey) return;
    this.status = "loading";
    this.error = "";
    const pool = new SimplePool();
    try {
      const events = await pool.querySync(
        [...PROFILE_RELAYS],
        { kinds: [0], authors: [this.pubkey], limit: 1 },
        { maxWait: 4_000 },
      );
      const newest = events.sort((left, right) => right.created_at - left.created_at)[0];
      this.profile = newest ? parseKindZero(newest.content) : null;
      this.status = "ready";
    } catch {
      this.profile = null;
      this.status = "ready";
    } finally {
      pool.destroy();
    }
  }

  private async adoptSigner(signer: NostrSigner, method: Exclude<UserAuthMethod, "anonymous">): Promise<void> {
    const pubkey = await signer.getPublicKey();
    this.signer = signer;
    this.method = method;
    this.pubkey = pubkey;
    this.profile = null;
    if (method === "nip07") saveNip07Session();
    else clearStoredNip07Session();
    await this.refreshProfile();
  }

  private async bootstrap(anonymousName: string): Promise<void> {
    this.setAnonymousName(anonymousName);
    if (hasRecoveryMarker()) {
      this.enterRecovery("Identity replacement was interrupted. Create a new identity to continue.");
      return;
    }
    const loaded = await loadAnonymousIdentity();
    const identity = loaded.state === "absent" ? await createAnonymousIdentity() : loaded;
    if (identity.state !== "ready") {
      this.recoveryRequired = true;
      this.status = "error";
      this.error = "Local identity needs recovery";
      return;
    }

    this.anonymousSigner = identity.signer;
    if (this.method === "anonymous") await this.showAnonymousIdentity();
    if (this.method === "anonymous") await this.restoreNip07Session();
    this.initialized = true;
  }

  private enterRecovery(message: string): void {
    this.anonymousSigner = null;
    this.signer = null;
    this.pubkey = "";
    this.profile = null;
    this.status = "error";
    this.error = message;
    this.recoveryRequired = true;
    this.initialized = false;
  }
}

function hasRecoveryMarker(): boolean {
  const storage = browserStorage();
  if (!storage) return true;
  try {
    const value = JSON.parse(storage.getItem(ANONYMOUS_IDENTITY_RECOVERY_STORAGE_KEY) ?? "null") as unknown;
    return isRecord(value) && value.version === 1 && Object.keys(value).length === 1;
  } catch {
    return true;
  }
}

function writeRecoveryMarker(): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.setItem(ANONYMOUS_IDENTITY_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1 }));
    return hasRecoveryMarker();
  } catch {
    return false;
  }
}

function clearRecoveryMarker(): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.removeItem(ANONYMOUS_IDENTITY_RECOVERY_STORAGE_KEY);
    return !hasRecoveryMarker();
  } catch {
    return false;
  }
}

function hasStoredNip07Session(): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    const value = JSON.parse(storage.getItem(NIP07_SESSION_STORAGE_KEY) ?? "null") as unknown;
    return isRecord(value) && value.version === 1 && value.method === "nip07";
  } catch {
    return false;
  }
}

function saveNip07Session(): void {
  try {
    browserStorage()?.setItem(NIP07_SESSION_STORAGE_KEY, JSON.stringify({ version: 1, method: "nip07" }));
  } catch {
    // Browser storage may be unavailable; the in-memory identity remains usable.
  }
}

function clearStoredNip07Session(): void {
  try {
    browserStorage()?.removeItem(NIP07_SESSION_STORAGE_KEY);
  } catch {
    // Local logout still succeeds when browser storage is unavailable.
  }
}

async function waitForNip07Availability(): Promise<boolean> {
  if (typeof window === "undefined" || "nostr" in window) return typeof window !== "undefined" && "nostr" in window;
  const deadline = Date.now() + NIP07_STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, NIP07_STARTUP_POLL_MS));
    if ("nostr" in window) return true;
  }
  return "nostr" in window;
}

function browserStorage(): Storage | null {
  return "localStorage" in globalThis ? globalThis.localStorage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseKindZero(content: string): NostrProfile | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const profile: NostrProfile = {};
    for (const key of ["name", "display_name", "picture", "nip05", "about"] as const) {
      if (typeof value[key] === "string") profile[key] = value[key];
    }
    return profile;
  } catch {
    return null;
  }
}

export function createPubkeyAvatar(pubkey: string): string {
  const normalized = pubkey.toLowerCase().replace(/[^a-f0-9]/g, "") || "a110";
  const hue = Number.parseInt(normalized.slice(0, 6).padEnd(6, "0"), 16) % 360;
  const cells: string[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const index = (row * 3 + column) * 2;
      const pair = normalized.slice(index, index + 2).padEnd(2, normalized[index % normalized.length] || "a");
      if (Number.parseInt(pair, 16) % 2 === 0) continue;
      const mirror = 4 - column;
      cells.push(`<rect x="${column}" y="${row}" width="1" height="1"/>`);
      if (mirror !== column) cells.push(`<rect x="${mirror}" y="${row}" width="1" height="1"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5"><rect width="5" height="5" fill="hsl(${hue} 20% 10%)"/><g fill="hsl(${hue} 72% 68%)">${cells.join("")}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export async function fetchNostrProfiles(pubkeys: string[]): Promise<Map<string, NostrProfile>> {
  const authors = [...new SvelteSet(pubkeys.filter(Boolean))];
  const profiles = new SvelteMap<string, NostrProfile>();
  if (authors.length === 0) return profiles;

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      [...PROFILE_RELAYS],
      { kinds: [0], authors, limit: Math.max(authors.length * 2, 20) },
      { maxWait: 4_000 },
    );
    const newestByAuthor = new SvelteMap<string, NostrEvent>();
    for (const event of events) {
      const current = newestByAuthor.get(event.pubkey);
      if (!current || event.created_at > current.created_at) newestByAuthor.set(event.pubkey, event);
    }
    for (const [pubkey, event] of newestByAuthor) {
      const profile = parseKindZero(event.content);
      if (profile) profiles.set(pubkey, profile);
    }
  } catch {
    // Missing metadata should never prevent a requester from being admitted.
  } finally {
    pool.destroy();
  }
  return profiles;
}

function createNostrConnectPool(): NostrConnectPool {
  const pool = new SimplePool();
  return {
    adapter: {
      subscription: (relays, filters) => new Observable<NostrEvent>((subscriber) => {
        let closed = 0;
        const subscriptions = (filters as Filter[]).map((filter) => pool.subscribeMany(relays, filter, {
          onevent: (event) => subscriber.next(event),
          onclose: () => {
            closed += 1;
            if (closed === filters.length) subscriber.complete();
          },
        }));
        return () => subscriptions.forEach((subscription) => subscription.close());
      }),
      publish: async (relays, event) => {
        await Promise.any(pool.publish(relays, event as NostrEvent));
      },
    },
    destroy: () => pool.destroy(),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export const userProfileStore = new UserProfileStore();
