import type { NostrSigner } from "@contextvm/sdk/core";
import { getEventHash, verifyEvent, type EventTemplate, type NostrEvent, type UnsignedEvent } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import {
  base64ToBytes,
  bytesToBase64,
  createApplicationMessage,
  createCommit,
  createGroup,
  defaultCredentialTypes,
  encode,
  generateKeyPackage,
  getCiphersuiteImpl,
  getGroupMembers,
  isDefaultCredential,
  joinGroup,
  keyPackageDecoder,
  keyPackageEncoder,
  mlsMessageDecoder,
  mlsMessageEncoder,
  makeKeyPackageRef,
  nobleCryptoProvider,
  privateKeyPackageDecoder,
  privateKeyPackageEncoder,
  processMessage,
  unsafeTestingAuthenticationService,
  wireformats,
  clientStateDecoder,
  clientStateEncoder,
  type ClientState,
  type KeyPackage,
  type PrivateKeyPackage,
  type Welcome,
} from "ts-mls";
import {
  createCordnMetadataCapabilities,
  makeCordnGroupMetadataExtension,
  makeCordnLastResortKeyPackageExtension,
  sealCordnGroupPayloadBase64,
  unsealCordnGroupPayloadBase64,
  type CordnGroupMetadata,
} from "./cordn-wire";

const CIPHER_SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
const CHAT_ENVELOPE_AUTH_KIND = 24_242;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Keep composer and reaction controls interoperable across every chat surface. */
export const CHAT_EMOJI_SHORTCUTS = ["👍", "❤️", "😂", "🎉", "👋", "✨"] as const;
export type ChatEmojiShortcut = typeof CHAT_EMOJI_SHORTCUTS[number];

export interface ChatReactionMutation {
  targetMessageId: string;
  /** Canonical NIP-25 target author. Optional only for persisted legacy reactions. */
  targetPubkey?: string;
  /** Canonical NIP-25 target event kind. Optional only for persisted legacy reactions. */
  targetKind?: number;
  emoji: ChatEmojiShortcut;
  active: boolean;
}

export interface ChatEnvelope {
  type: "message";
  id: string;
  sender: string;
  name: string;
  avatar?: string;
  badgeLabel?: string;
  badgeEmoji?: string;
  content: string;
  createdAt: number;
  /** Optional authenticated kind-9 recipients used for mentions and targeted invites. */
  recipientPubkeys?: string[];
  /** Optional so pre-reaction clients still advance MLS state using `type: message`. */
  reaction?: ChatReactionMutation;
  auth?: {
    id: string;
    sig: string;
  };
}

/** Accept arrays of Nostr pubkeys only; presentation text never establishes identity. */
export function normalizeRecipientPubkeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !/^[0-9a-f]{64}$/i.test(candidate)) continue;
    const pubkey = candidate.toLowerCase();
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    recipients.push(pubkey);
  }
  return recipients;
}

function hasCanonicalRecipientPubkeys(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const normalized = normalizeRecipientPubkeys(value);
  return normalized.length === value.length && normalized.every((pubkey, index) => pubkey === value[index]);
}

export interface LocalKeyPackage {
  reference: string;
  publicBase64: string;
  privateBase64: string;
  /** Cordn clients reuse this package across room joins for the same coordinator. */
  lastResort?: boolean;
}

async function cipherSuite() {
  return getCiphersuiteImpl(CIPHER_SUITE, nobleCryptoProvider);
}

function decodeExact<T>(bytes: Uint8Array, decoder: (value: Uint8Array, offset: number) => [T, number] | undefined, label: string): T {
  const decoded = decoder(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) throw new Error(`Invalid ${label}`);
  return decoded[0];
}

export function encodeState(state: ClientState): string {
  return bytesToBase64(encode(clientStateEncoder, state));
}

export function decodeState(value: string): ClientState {
  return decodeExact(base64ToBytes(value), clientStateDecoder, "stored chat state");
}

export function groupId(state: ClientState): string {
  return textDecoder.decode(state.groupContext.groupId);
}

/**
 * The creator occupies the first non-blank leaf in a newly joined MLS tree.
 * Read its BasicCredential identity so invite metadata can be checked against
 * membership authenticated by the Welcome rather than coordinator metadata.
 */
export function groupCreatorPubkey(state: ClientState): string | null {
  const creator = getGroupMembers(state)[0];
  if (!creator) return null;
  const credential = creator.credential;
  if (!isDefaultCredential(credential)
    || credential.credentialType !== defaultCredentialTypes.basic
    || !("identity" in credential)) return null;
  const pubkey = textDecoder.decode(credential.identity).trim();
  return /^[0-9a-f]{64}$/i.test(pubkey) ? pubkey : null;
}

export async function createKeyPackage(
  stablePubkey: string,
  options: { lastResort?: boolean } = {},
): Promise<{ keyPackage: KeyPackage; privateKeyPackage: PrivateKeyPackage; stored: LocalKeyPackage }> {
  const now = Math.floor(Date.now() / 1000);
  const suite = await cipherSuite();
  const generated = await generateKeyPackage({
    credential: { credentialType: defaultCredentialTypes.basic, identity: textEncoder.encode(stablePubkey) },
    cipherSuite: suite,
    capabilities: createCordnMetadataCapabilities(),
    ...(options.lastResort
      ? { extensions: [makeCordnLastResortKeyPackageExtension()] }
      : {}),
    lifetime: { notBefore: BigInt(now - 86_400), notAfter: BigInt(now + 31_536_000) },
  });
  const publicBase64 = bytesToBase64(encode(keyPackageEncoder, generated.publicPackage));
  const reference = bytesToHex(await makeKeyPackageRef(generated.publicPackage, suite.hash));
  return {
    keyPackage: generated.publicPackage,
    privateKeyPackage: generated.privatePackage,
    stored: {
      reference,
      publicBase64,
      privateBase64: bytesToBase64(encode(privateKeyPackageEncoder, generated.privatePackage)),
      ...(options.lastResort ? { lastResort: true } : {}),
    },
  };
}

export function decodeLocalKeyPackage(stored: LocalKeyPackage): { keyPackage: KeyPackage; privateKeyPackage: PrivateKeyPackage } {
  return {
    keyPackage: decodeExact(base64ToBytes(stored.publicBase64), keyPackageDecoder, "key package"),
    privateKeyPackage: decodeExact(base64ToBytes(stored.privateBase64), privateKeyPackageDecoder, "private key package"),
  };
}

export async function createRoomState(
  keyPackage: KeyPackage,
  privateKeyPackage: PrivateKeyPackage,
  metadata?: CordnGroupMetadata,
): Promise<ClientState> {
  return createGroup({
    context: { cipherSuite: await cipherSuite(), authService: unsafeTestingAuthenticationService },
    groupId: textEncoder.encode(crypto.randomUUID()),
    keyPackage,
    privateKeyPackage,
    ...(metadata ? { extensions: [makeCordnGroupMetadataExtension(metadata)] } : {}),
  });
}

export async function sealGroupPayloadBase64(
  state: ClientState,
  opaqueMessageBase64: string,
): Promise<string> {
  return sealCordnGroupPayloadBase64(state, opaqueMessageBase64, await cipherSuite());
}

export async function unsealGroupPayloadBase64(
  state: ClientState,
  encryptedBase64: string,
): Promise<string> {
  return unsealCordnGroupPayloadBase64(state, encryptedBase64, await cipherSuite());
}

export function encodeWelcome(welcome: Welcome): string {
  return bytesToBase64(encode(mlsMessageEncoder, { version: 1, wireformat: wireformats.mls_welcome, welcome }));
}

export async function joinWelcome(welcomeBase64: string, stored: LocalKeyPackage): Promise<ClientState> {
  const { keyPackage, privateKeyPackage } = decodeLocalKeyPackage(stored);
  const message = decodeExact(base64ToBytes(welcomeBase64), mlsMessageDecoder, "welcome");
  if (message.wireformat !== wireformats.mls_welcome) throw new Error("Invite did not contain an MLS welcome");
  return joinGroup({
    context: { cipherSuite: await cipherSuite(), authService: unsafeTestingAuthenticationService },
    welcome: message.welcome,
    keyPackage,
    privateKeys: privateKeyPackage,
  });
}

export async function addMember(state: ClientState, memberKeyPackageBase64: string): Promise<{ state: ClientState; commitBase64: string; welcomeBase64: string }> {
  const memberKeyPackage = decodeExact(base64ToBytes(memberKeyPackageBase64), keyPackageDecoder, "member key package");
  const result = await createCommit({
    context: { cipherSuite: await cipherSuite(), authService: unsafeTestingAuthenticationService },
    state,
    ratchetTreeExtension: true,
    extraProposals: [{ proposalType: 1, add: { keyPackage: memberKeyPackage } }],
  });
  if (!result.welcome) throw new Error("Coordinator could not make an invite welcome");
  const serializedCommit = bytesToBase64(encode(mlsMessageEncoder, result.commit));
  return {
    state: result.newState,
    // The Commit advances the epoch, so spec/03 seals it with the exporter
    // secret from the pre-Commit state that every current member still holds.
    commitBase64: await sealGroupPayloadBase64(state, serializedCommit),
    welcomeBase64: encodeWelcome(result.welcome.welcome),
  };
}

export async function encryptMessage(state: ClientState, envelope: ChatEnvelope): Promise<{ state: ClientState; opaqueBase64: string }> {
  // A locally signed presentation may have been mutated after signing. Do not
  // let conversion to Cordn's MLS-authenticated event format accidentally
  // bless the forged role metadata with a new valid event id.
  let wireEnvelope = envelope;
  const currentCordnId = finalizeCordnMessageEvent(chatEnvelopeToCordnEvent(envelope)).id;
  if (envelope.auth
    && (!hasValidChatEnvelopeAuth(envelope) || envelope.id !== currentCordnId)) {
    const safeEnvelope = { ...envelope };
    delete safeEnvelope.auth;
    delete safeEnvelope.badgeLabel;
    delete safeEnvelope.badgeEmoji;
    delete safeEnvelope.recipientPubkeys;
    wireEnvelope = safeEnvelope;
  }
  const event = finalizeCordnMessageEvent(chatEnvelopeToCordnEvent(wireEnvelope));
  const result = await createApplicationMessage({
    context: { cipherSuite: await cipherSuite(), authService: unsafeTestingAuthenticationService },
    state,
    message: textEncoder.encode(JSON.stringify(event)),
    authenticatedData: textEncoder.encode(wireEnvelope.sender),
  });
  const serialized = bytesToBase64(encode(mlsMessageEncoder, result.message));
  return {
    state: result.newState,
    opaqueBase64: await sealGroupPayloadBase64(state, serialized),
  };
}

/** Sign all user-controlled presentation fields without embedding a full Nostr event. */
export async function signChatEnvelope(envelope: ChatEnvelope, signer: NostrSigner): Promise<ChatEnvelope> {
  const canonicalEnvelope = { ...envelope };
  const recipientPubkeys = envelope.reaction ? [] : normalizeRecipientPubkeys(envelope.recipientPubkeys);
  if (recipientPubkeys.length > 0) canonicalEnvelope.recipientPubkeys = recipientPubkeys;
  else delete canonicalEnvelope.recipientPubkeys;
  canonicalEnvelope.id = finalizeCordnMessageEvent(chatEnvelopeToCordnEvent(canonicalEnvelope)).id;
  const signed = await signer.signEvent(chatEnvelopeAuthTemplate(canonicalEnvelope));
  const authenticated = { ...canonicalEnvelope, auth: { id: signed.id, sig: signed.sig } };
  if (signed.pubkey !== envelope.sender || !hasValidChatEnvelopeAuth(authenticated)) {
    throw new Error("The chat signer returned an invalid message signature");
  }
  return authenticated;
}

/**
 * Validate the compact Nostr proof over every user-controlled envelope field.
 * New messages always carry this proof; unsigned legacy messages remain valid
 * chat history but their presentation must not be treated as authoritative.
 */
export function hasValidChatEnvelopeAuth(envelope: ChatEnvelope): boolean {
  if (!envelope.auth || !/^[0-9a-f]{64}$/i.test(envelope.sender)
    || !hasCanonicalRecipientPubkeys(envelope.recipientPubkeys)
    || (envelope.reaction !== undefined && (!isChatReactionMutation(envelope.reaction)
      || envelope.recipientPubkeys !== undefined))) return false;
  if (envelope.auth.sig === "cordn") {
    return envelope.id === envelope.auth.id
      && finalizeCordnMessageEvent(chatEnvelopeToCordnEvent(envelope)).id === envelope.id;
  }
  try {
    const event: NostrEvent = {
      ...chatEnvelopeAuthTemplate(envelope),
      pubkey: envelope.sender,
      id: envelope.auth.id,
      sig: envelope.auth.sig,
    };
    return verifyEvent(event);
  } catch {
    return false;
  }
}

/** Remove invalid proofs and role presentation not signed by the MLS-verified host. */
export function sanitizeChatEnvelopeHostBadge<T extends ChatEnvelope>(envelope: T, expectedHostPubkey?: string): T {
  const authenticated = hasValidChatEnvelopeAuth(envelope);
  const hasAuthorizedBadge = expectedHostPubkey
    && envelope.sender.toLowerCase() === expectedHostPubkey.toLowerCase()
    && authenticated;
  const stripsBadge = Boolean((envelope.badgeLabel || envelope.badgeEmoji) && !hasAuthorizedBadge);
  if ((!envelope.auth || authenticated) && !stripsBadge) return envelope;
  const sanitized = { ...envelope };
  // The signature covers the badge fields. Once role presentation is removed,
  // its proof no longer describes the returned envelope and must go with it.
  if (!authenticated || stripsBadge) delete sanitized.auth;
  if (stripsBadge) {
    delete sanitized.badgeLabel;
    delete sanitized.badgeEmoji;
  }
  return sanitized;
}

export async function decryptMessage(state: ClientState, opaqueBase64: string, options: { expectedHostPubkey?: string } = {}): Promise<{ state: ClientState; envelope?: ChatEnvelope }> {
  const serialized = await unsealGroupPayloadBase64(state, opaqueBase64);
  const message = decodeExact(base64ToBytes(serialized), mlsMessageDecoder, "MLS message");
  const result = await processMessage({
    context: { cipherSuite: await cipherSuite(), authService: unsafeTestingAuthenticationService },
    state,
    // The welcome form is rejected above; ts-mls' discriminator is not
    // currently narrowed by TypeScript across its numeric wireformat field.
    message: message as Parameters<typeof processMessage>[0]["message"],
  });
  if (result.kind !== "applicationMessage") return { state: result.newState };
  if (result.aad.length === 0) throw new Error("Cordn message has no authenticated sender");
  const sender = textDecoder.decode(result.aad);
  const event = decodeCordnMessageEvent(result.message);
  if (event.pubkey !== sender) throw new Error("Cordn message sender does not match MLS authenticated data");
  const candidate = cordnEventToChatEnvelope(event);
  if (!candidate) return { state: result.newState };
  return {
    state: result.newState,
    envelope: sanitizeChatEnvelopeHostBadge(candidate, options.expectedHostPubkey),
  };
}

type CordnMessageEvent = UnsignedEvent & { id: string };

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

export function chatEnvelopeToCordnEvent(envelope: ChatEnvelope): UnsignedEvent {
  const tags: string[][] = [];
  if (envelope.name.trim()) tags.push(["name", envelope.name.trim()]);
  if (envelope.avatar?.trim()) tags.push(["avatar", envelope.avatar.trim()]);
  if (envelope.badgeLabel?.trim()) tags.push(["cahmls-badge-label", envelope.badgeLabel.trim()]);
  if (envelope.badgeEmoji?.trim()) tags.push(["cahmls-badge-emoji", envelope.badgeEmoji.trim()]);
  if (envelope.reaction) {
    tags.push(envelope.reaction.targetPubkey
      ? ["e", envelope.reaction.targetMessageId, "", envelope.reaction.targetPubkey]
      : ["e", envelope.reaction.targetMessageId]);
    if (envelope.reaction.targetPubkey) tags.push(["p", envelope.reaction.targetPubkey]);
    if (envelope.reaction.targetKind !== undefined) tags.push(["k", String(envelope.reaction.targetKind)]);
    tags.push(["cahmls-active", envelope.reaction.active ? "1" : "0"]);
  } else {
    for (const recipientPubkey of normalizeRecipientPubkeys(envelope.recipientPubkeys)) {
      tags.push(["p", recipientPubkey]);
    }
  }
  return {
    pubkey: envelope.sender,
    content: envelope.reaction?.emoji ?? envelope.content,
    created_at: Math.floor(envelope.createdAt / 1_000),
    kind: envelope.reaction ? 7 : 9,
    tags,
  };
}

function finalizeCordnMessageEvent(event: UnsignedEvent): CordnMessageEvent {
  return { ...event, id: getEventHash(event) };
}

function decodeCordnMessageEvent(bytes: Uint8Array): CordnMessageEvent {
  const parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Cordn message envelope");
  }
  const candidate = parsed as Record<string, unknown>;
  if ("sig" in candidate
    || typeof candidate.id !== "string"
    || typeof candidate.pubkey !== "string"
    || typeof candidate.content !== "string"
    || typeof candidate.created_at !== "number"
    || typeof candidate.kind !== "number"
    || !Array.isArray(candidate.tags)) {
    throw new Error("Invalid Cordn message envelope");
  }
  const event = candidate as unknown as CordnMessageEvent;
  if (getEventHash(event) !== event.id) {
    throw new Error("Cordn message envelope id mismatch");
  }
  return event;
}

function cordnEventToChatEnvelope(event: CordnMessageEvent): ChatEnvelope | undefined {
  const avatar = tagValue(event.tags, "avatar");
  const badgeLabel = tagValue(event.tags, "cahmls-badge-label");
  const badgeEmoji = tagValue(event.tags, "cahmls-badge-emoji");
  const base: ChatEnvelope = {
    type: "message",
    id: event.id,
    sender: event.pubkey,
    name: tagValue(event.tags, "name") ?? `${event.pubkey.slice(0, 8)}…`,
    ...(avatar ? { avatar } : {}),
    ...(badgeLabel ? { badgeLabel } : {}),
    ...(badgeEmoji ? { badgeEmoji } : {}),
    content: event.content,
    createdAt: event.created_at * 1_000,
    auth: { id: event.id, sig: "cordn" },
  };
  if (event.kind !== 7) {
    const recipientPubkeys = normalizeRecipientPubkeys(event.tags
      .filter((tag) => tag[0] === "p")
      .map((tag) => tag[1]));
    return event.kind === 9
      ? { ...base, ...(recipientPubkeys.length > 0 ? { recipientPubkeys } : {}) }
      : undefined;
  }
  const targetMessageId = tagValue(event.tags, "e");
  if (!targetMessageId || !(CHAT_EMOJI_SHORTCUTS as readonly string[]).includes(event.content)) {
    return undefined;
  }
  return {
    ...base,
    content: `Reacted ${event.content}`,
    reaction: {
      targetMessageId,
      ...(tagValue(event.tags, "p") ? { targetPubkey: tagValue(event.tags, "p") } : {}),
      ...(tagValue(event.tags, "k") !== undefined
        ? { targetKind: Number(tagValue(event.tags, "k")) }
        : {}),
      emoji: event.content as ChatEmojiShortcut,
      active: tagValue(event.tags, "cahmls-active") !== "0",
    },
  };
}

function chatEnvelopeAuthTemplate(envelope: ChatEnvelope): EventTemplate {
  return {
    kind: CHAT_ENVELOPE_AUTH_KIND,
    created_at: Math.floor(envelope.createdAt / 1_000),
    tags: [["d", envelope.id]],
    content: JSON.stringify({
      type: envelope.type,
      id: envelope.id,
      sender: envelope.sender,
      name: envelope.name,
      avatar: envelope.avatar ?? null,
      badgeLabel: envelope.badgeLabel ?? null,
      badgeEmoji: envelope.badgeEmoji ?? null,
      content: envelope.content,
      createdAt: envelope.createdAt,
      recipientPubkeys: envelope.reaction ? null : (envelope.recipientPubkeys ?? null),
      reaction: envelope.reaction ?? null,
    }),
  };
}

/** Strictly validate the compact mutation before it can affect a room projection. */
export function isChatReactionMutation(value: unknown): value is ChatReactionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reaction = value as Record<string, unknown>;
  const keys = Object.keys(reaction).sort();
  const legacyKeys = keys.length === 3
    && keys[0] === "active" && keys[1] === "emoji" && keys[2] === "targetMessageId";
  const canonicalKeys = keys.length === 5
    && keys[0] === "active" && keys[1] === "emoji" && keys[2] === "targetKind"
    && keys[3] === "targetMessageId" && keys[4] === "targetPubkey";
  if (!legacyKeys && !canonicalKeys) return false;
  return typeof reaction.targetMessageId === "string"
    && reaction.targetMessageId.trim().length > 0
    && (legacyKeys || (/^[0-9a-f]{64}$/i.test(String(reaction.targetPubkey))
      && typeof reaction.targetKind === "number"
      && Number.isSafeInteger(reaction.targetKind)
      && reaction.targetKind >= 0))
    && typeof reaction.emoji === "string"
    && (CHAT_EMOJI_SHORTCUTS as readonly string[]).includes(reaction.emoji)
    && typeof reaction.active === "boolean";
}
