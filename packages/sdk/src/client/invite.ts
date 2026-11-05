import { nip19 } from "nostr-tools";
import { shareableRelayUrls } from "../relay/relay-pool.js";

export interface RoomHostIdentity {
  name: string;
  pubkey: string;
  avatar?: string;
}

export type CoordinatorKeyMode = "ephemeral" | "persistent";

export interface ChatInvite {
  groupId: string;
  coordinatorPubkey: string;
  relayUrls: string[];
  title?: string;
  coordinatorOrigin?: string;
  coordinatorName?: string;
  inviteToken?: string;
  host?: RoomHostIdentity;
  coordinatorKeyMode?: CoordinatorKeyMode;
}

interface InviteMetadata {
  /** Canonical Cordn clients require the room label under `name`. */
  name: string;
  coordinatorOrigin: string;
  coordinatorName?: string;
  host?: RoomHostIdentity;
  coordinatorKeyMode?: CoordinatorKeyMode;
}
export const CORDN_DEFAULT_COORDINATOR_PUBKEY =
  "92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5";
export const CORDN_DEFAULT_RELAY_URLS = [
  "wss://relay2.contextvm.org",
  "wss://bucket.coracle.social",
  "wss://nos.lol",
] as const;

const HOST_NAME_MAX_LENGTH = 96;
const COORDINATOR_NAME_MAX_LENGTH = 96;
const HOST_AVATAR_MAX_LENGTH = 2_048;
const NOSTR_PUBKEY_PATTERN = /^[0-9a-f]{64}$/i;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function base64UrlEncode(value: unknown): string {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return JSON.parse(decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
}

function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function requireHttpOrigin(value: string): string {
  const origin = normalizeHttpOrigin(value);
  if (!origin) throw new TypeError("Chat invite origins must use http or https");
  return origin;
}

/**
 * Accept only the small, display-safe subset of host metadata that may travel
 * in an invite. Invalid optional metadata is intentionally ignored so older
 * and third-party invite links remain usable.
 */
export function normalizeRoomHostIdentity(value: unknown): RoomHostIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const pubkey = typeof value.pubkey === "string" ? value.pubkey.trim() : "";
  if (!name || name.length > HOST_NAME_MAX_LENGTH || !NOSTR_PUBKEY_PATTERN.test(pubkey)) return undefined;

  const avatar = normalizeShareSafeAvatar(value.avatar);
  return {
    name,
    pubkey,
    ...(avatar ? { avatar } : {}),
  };
}

function normalizeShareSafeAvatar(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > HOST_AVATAR_MAX_LENGTH) return undefined;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCoordinatorKeyMode(value: unknown): CoordinatorKeyMode | undefined {
  return value === "ephemeral" || value === "persistent" ? value : undefined;
}

function normalizeCoordinatorName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && Array.from(normalized).length <= COORDINATOR_NAME_MAX_LENGTH ? normalized : undefined;
}

function decodeCoordinator(value: string | null): { pubkey: string; relayUrls: string[] } | null {
  const coordinator = value?.trim();
  if (!coordinator) {
    return {
      pubkey: CORDN_DEFAULT_COORDINATOR_PUBKEY,
      relayUrls: [],
    };
  }

  if (NOSTR_PUBKEY_PATTERN.test(coordinator)) {
    return { pubkey: coordinator.toLowerCase(), relayUrls: [] };
  }

  try {
    const decoded = nip19.decode(coordinator);
    if (decoded.type === "npub") {
      return { pubkey: decoded.data.toLowerCase(), relayUrls: [] };
    }
    if (decoded.type === "nprofile") {
      return {
        pubkey: decoded.data.pubkey.toLowerCase(),
        /* v8 ignore next -- nip19.decode always sets relays; only its type marks them optional */
        relayUrls: normalizeRelayUrls(decoded.data.relays ?? []),
      };
    }
  } catch {
    // A present but malformed coordinator must never fall back to another host.
  }
  return null;
}

function normalizeRelayUrls(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed);
      if (url.protocol === "ws:" || url.protocol === "wss:") normalized.add(trimmed);
    } catch {
      // Invalid relay hints are non-authoritative and can be ignored safely.
    }
  }
  return [...normalized];
}

function decodeInviteMetadata(value: string | null): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const decoded = base64UrlDecode(value.trim());
    return isRecord(decoded) ? decoded : {};
  } catch {
    // Metadata is only cosmetic. A damaged name or icon must not sink a valid invite.
    return {};
  }
}

/**
 * One self-contained, Cordn-compatible invite: group, coordinator identity,
 * relay hints, and optional CAHMLS presentation metadata travel together.
 * Canonical clients read `c` plus `m.name` and safely ignore extra metadata.
 */
export function createInviteUrl(origin: string, invite: ChatInvite): string {
  const shellOrigin = requireHttpOrigin(origin);
  const coordinatorOrigin = requireHttpOrigin(invite.coordinatorOrigin ?? shellOrigin);
  const host = normalizeRoomHostIdentity(invite.host);
  const coordinatorKeyMode = normalizeCoordinatorKeyMode(invite.coordinatorKeyMode);
  const coordinatorName = normalizeCoordinatorName(invite.coordinatorName);
  const coordinator = nip19.nprofileEncode({
    pubkey: invite.coordinatorPubkey,
    relays: shareableRelayUrls(invite.relayUrls),
  });
  const meta = base64UrlEncode({
    name: invite.title?.trim() || "Chat",
    coordinatorOrigin,
    ...(coordinatorName ? { coordinatorName } : {}),
    ...(host ? { host } : {}),
    ...(coordinatorKeyMode ? { coordinatorKeyMode } : {}),
  } satisfies InviteMetadata);
  const params = new URLSearchParams({ c: coordinator, m: meta });
  if (invite.inviteToken) params.set("i", invite.inviteToken);
  return `${shellOrigin}/chat/${encodeURIComponent(invite.groupId)}?${params}`;
}

export function parseInviteUrl(value: string): ChatInvite | null {
  try {
    const url = new URL(value.trim(), (globalThis as { location?: { origin?: string } }).location?.origin);
    const match = url.pathname.match(/^\/chat\/([^/]+)\/?$/);
    if (!match) return null;

    const shellOrigin = normalizeHttpOrigin(url.origin);
    if (!shellOrigin) return null;

    const coordinator = decodeCoordinator(url.searchParams.get("c"));
    if (!coordinator) return null;
    const meta = decodeInviteMetadata(url.searchParams.get("m"));
    const rawTitle = typeof meta.title === "string" ? meta.title : meta.name;
    const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : undefined;
    const rawCoordinatorOrigin = meta.coordinatorOrigin;
    const coordinatorOrigin = rawCoordinatorOrigin === undefined
      ? shellOrigin
      : typeof rawCoordinatorOrigin === "string"
        ? normalizeHttpOrigin(rawCoordinatorOrigin)
        : null;
    if (!coordinatorOrigin) return null;
    const host = normalizeRoomHostIdentity(meta.host);
    const coordinatorKeyMode = normalizeCoordinatorKeyMode(meta.coordinatorKeyMode);
    const coordinatorName = normalizeCoordinatorName(meta.coordinatorName);
    const inviteToken = url.searchParams.get("i")?.trim() || undefined;
    const groupId = decodeURIComponent(match[1]).trim();
    if (!groupId) return null;

    return {
      groupId,
      coordinatorPubkey: coordinator.pubkey,
      relayUrls: coordinator.relayUrls,
      title,
      coordinatorOrigin,
      ...(coordinatorName ? { coordinatorName } : {}),
      ...(inviteToken ? { inviteToken } : {}),
      ...(host ? { host } : {}),
      ...(coordinatorKeyMode ? { coordinatorKeyMode } : {}),
    };
  } catch {
    return null;
  }
}

/** Recognize only messages whose complete content is one validated Cordn invite. */
export function parseInviteMessage(value: string): ChatInvite | null {
  const candidate = value.trim();
  if (!candidate || /\s/.test(candidate)) return null;
  // parseInviteUrl resolves relative input for the address bar, but chat text
  // such as "chat/hello" must not turn into a join card for the default host.
  if (!/^https?:\/\//i.test(candidate)) return null;
  return parseInviteUrl(candidate);
}
