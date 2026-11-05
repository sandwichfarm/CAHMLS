import type { NostrSigner } from "@contextvm/sdk/core";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
  type UnsignedEvent,
} from "nostr-tools";

export interface Nip44Signer extends NostrSigner {
  nip44: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

export function supportsNip44(signer: NostrSigner | null): signer is Nip44Signer {
  if (!signer || typeof signer !== "object" || !("nip44" in signer)) return false;
  const value = signer.nip44 as Partial<Nip44Signer["nip44"]> | undefined;
  return typeof value?.encrypt === "function" && typeof value.decrypt === "function";
}

export async function createGiftWrap(
  signer: Nip44Signer,
  recipient: string,
  kind: number,
  payload: unknown,
  outerKind: 1059 | 21059,
): Promise<NostrEvent> {
  const pubkey = await signer.getPublicKey();
  const rumorTemplate: UnsignedEvent = {
    pubkey,
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(payload),
  };
  const rumor = { ...rumorTemplate, id: getEventHash(rumorTemplate) };
  const seal = await signer.signEvent({
    kind: 13,
    created_at: randomPastTimestamp(),
    tags: [],
    content: await signer.nip44.encrypt(recipient, JSON.stringify(rumor)),
  });

  const ephemeralSecret = generateSecretKey();
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSecret, recipient);
  return finalizeEvent({
    kind: outerKind,
    created_at: randomPastTimestamp(),
    tags: [["p", recipient]],
    content: nip44.v2.encrypt(JSON.stringify(seal), conversationKey),
  }, ephemeralSecret);
}

export async function unwrapGiftWrap(
  signer: Nip44Signer,
  giftWrap: NostrEvent,
): Promise<{ sender: string; kind: number; payload: unknown; rumor: NostrEvent }> {
  if ((giftWrap.kind !== 1059 && giftWrap.kind !== 21059) || !verifyEvent(giftWrap)) {
    throw new Error("Invalid gift wrap");
  }
  const seal = JSON.parse(await signer.nip44.decrypt(giftWrap.pubkey, giftWrap.content)) as NostrEvent;
  if (seal.kind !== 13 || seal.tags.length !== 0 || !verifyEvent(seal)) throw new Error("Invalid gift-wrap seal");

  const rumor = JSON.parse(await signer.nip44.decrypt(seal.pubkey, seal.content)) as NostrEvent;
  if (rumor.pubkey !== seal.pubkey || rumor.tags.length !== 0 || rumor.id !== getEventHash(rumor)) {
    throw new Error("Invalid gift-wrap rumor");
  }
  return {
    sender: seal.pubkey,
    kind: rumor.kind,
    payload: JSON.parse(rumor.content) as unknown,
    rumor,
  };
}

function randomPastTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return now - (random % (2 * 24 * 60 * 60));
}

export function createLocalNip44Signer(secret: Uint8Array): Nip44Signer {
  const pubkey = getPublicKey(secret);
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (event: EventTemplate) => finalizeEvent(event, secret),
    nip44: {
      encrypt: async (recipient, plaintext) =>
        nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, recipient)),
      decrypt: async (sender, ciphertext) =>
        nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secret, sender)),
    },
  };
}
