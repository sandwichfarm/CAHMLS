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
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createGiftWrap,
  createLocalNip44Signer,
  supportsNip44,
  unwrapGiftWrap,
  type Nip44Signer,
} from "../src/client/nostr-envelope.js";
import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";
import type { NostrSigner } from "@contextvm/sdk/core";

const TWO_DAYS = 2 * 24 * 60 * 60;

/** A wire copy: JSON drops the verification cache nostr-tools hides under a symbol. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function identity() {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret), signer: createLocalNip44Signer(secret) };
}

function encryptFor(secret: Uint8Array, recipient: string, plaintext: string): string {
  return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, recipient));
}

function rumorFrom(pubkey: string, overrides: Partial<UnsignedEvent> = {}): NostrEvent {
  const unsigned: UnsignedEvent = {
    pubkey,
    kind: 1_000,
    created_at: 1_700_000_000,
    tags: [],
    content: JSON.stringify({ hello: "world" }),
    ...overrides,
  };
  return { ...unsigned, id: getEventHash(unsigned) } as NostrEvent;
}

function sealFrom(secret: Uint8Array, recipient: string, rumor: unknown, overrides: Partial<EventTemplate> = {}): NostrEvent {
  return finalizeEvent({
    kind: 13,
    created_at: 1_700_000_000,
    tags: [],
    content: encryptFor(secret, recipient, JSON.stringify(rumor)),
    ...overrides,
  }, secret);
}

function wrapSealText(sealText: string, recipient: string, kind: 1059 | 21059 = 1059): NostrEvent {
  const ephemeral = generateSecretKey();
  return overTheWire(finalizeEvent({
    kind,
    created_at: 1_700_000_000,
    tags: [["p", recipient]],
    content: encryptFor(ephemeral, recipient, sealText),
  }, ephemeral));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supportsNip44", () => {
  const base = { getPublicKey: async () => "pk", signEvent: async () => ({}) as NostrEvent };

  test.each<[string, unknown, boolean]>([
    ["null", null, false],
    ["a non-object", "signer", false],
    ["a signer without nip44", base, false],
    ["undefined nip44", { ...base, nip44: undefined }, false],
    ["encrypt only", { ...base, nip44: { encrypt: async () => "" } }, false],
    ["decrypt only", { ...base, nip44: { decrypt: async () => "" } }, false],
    ["non-function members", { ...base, nip44: { encrypt: "x", decrypt: "y" } }, false],
    ["both functions", { ...base, nip44: { encrypt: async () => "", decrypt: async () => "" } }, true],
  ])("%s -> %s", (_label, signer, expected) => {
    expect(supportsNip44(signer as NostrSigner | null)).toBe(expected);
  });

  test("the shipped signers qualify", () => {
    expect(supportsNip44(new BrowserNostrSigner(generateSecretKey()))).toBe(true);
    expect(supportsNip44(createLocalNip44Signer(generateSecretKey()))).toBe(true);
  });
});

describe("createLocalNip44Signer", () => {
  test("signs and encrypts as the supplied key", async () => {
    const alice = identity();
    const bob = identity();

    await expect(alice.signer.getPublicKey()).resolves.toBe(alice.pubkey);
    const signed = await alice.signer.signEvent({ kind: 1, created_at: 1, tags: [], content: "x" });
    expect(signed.pubkey).toBe(alice.pubkey);
    expect(verifyEvent(overTheWire(signed))).toBe(true);

    const ciphertext = await alice.signer.nip44.encrypt(bob.pubkey, "note");
    await expect(bob.signer.nip44.decrypt(alice.pubkey, ciphertext)).resolves.toBe("note");
  });
});

describe("createGiftWrap", () => {
  test.each([1059, 21059] as const)("round trips through outer kind %i", async (outerKind) => {
    const alice = identity();
    const bob = identity();

    const wrap = await createGiftWrap(alice.signer, bob.pubkey, 1_000, { body: "hi" }, outerKind);
    const opened = await unwrapGiftWrap(bob.signer, overTheWire(wrap));

    expect(opened.sender).toBe(alice.pubkey);
    expect(opened.kind).toBe(1_000);
    expect(opened.payload).toEqual({ body: "hi" });
    expect(opened.rumor.pubkey).toBe(alice.pubkey);
    expect(opened.rumor).not.toHaveProperty("sig");
  });

  test("hides the sender and payload from anyone observing the outer event", async () => {
    const alice = identity();
    const bob = identity();

    const wrap = await createGiftWrap(alice.signer, bob.pubkey, 1_000, { body: "secret-text" }, 1059);

    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).not.toBe(alice.pubkey);
    expect(wrap.tags).toEqual([["p", bob.pubkey]]);
    expect(JSON.stringify(wrap)).not.toContain("secret-text");
    expect(JSON.stringify(wrap)).not.toContain(alice.pubkey);
    expect(verifyEvent(overTheWire(wrap))).toBe(true);
  });

  test("uses a new ephemeral key for each wrap", async () => {
    const alice = identity();
    const bob = identity();
    const first = await createGiftWrap(alice.signer, bob.pubkey, 1, {}, 1059);
    const second = await createGiftWrap(alice.signer, bob.pubkey, 1, {}, 1059);
    expect(first.pubkey).not.toBe(second.pubkey);
  });

  test("backdates the outer timestamp by less than two days", async () => {
    const alice = identity();
    const bob = identity();
    const now = Math.floor(Date.now() / 1000);

    for (let index = 0; index < 5; index += 1) {
      const wrap = await createGiftWrap(alice.signer, bob.pubkey, 1, {}, 1059);
      expect(wrap.created_at).toBeLessThanOrEqual(now + 1);
      expect(wrap.created_at).toBeGreaterThan(now - TWO_DAYS - 1);
    }
  });

  test("falls back to the current time if the random source returns nothing", async () => {
    const alice = identity();
    const bob = identity();
    const original = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((target: Uint8Array | Uint32Array) =>
      target instanceof Uint32Array ? new Uint32Array(0) : original(target)) as typeof crypto.getRandomValues);
    const now = Math.floor(Date.now() / 1000);

    const wrap = await createGiftWrap(alice.signer, bob.pubkey, 1, {}, 1059);

    expect(Math.abs(wrap.created_at - now)).toBeLessThanOrEqual(2);
  });
});

describe("unwrapGiftWrap rejections", () => {
  test("another recipient cannot open the wrap", async () => {
    const alice = identity();
    const bob = identity();
    const eve = identity();
    const wrap = await createGiftWrap(alice.signer, bob.pubkey, 1, { secret: true }, 1059);

    await expect(unwrapGiftWrap(eve.signer, overTheWire(wrap))).rejects.toThrow();
  });

  test("refuses other outer kinds even when correctly signed", async () => {
    const bob = identity();
    const secret = generateSecretKey();
    const event = overTheWire(finalizeEvent({ kind: 4, created_at: 1, tags: [], content: "x" }, secret));

    await expect(unwrapGiftWrap(bob.signer, event)).rejects.toThrow("Invalid gift wrap");
  });

  test("refuses a tampered outer event", async () => {
    const alice = identity();
    const bob = identity();
    const wrap = overTheWire(await createGiftWrap(alice.signer, bob.pubkey, 1, {}, 1059));

    await expect(unwrapGiftWrap(bob.signer, { ...wrap, content: `${wrap.content}A` })).rejects.toThrow("Invalid gift wrap");
    await expect(unwrapGiftWrap(bob.signer, { ...wrap, created_at: wrap.created_at + 1 })).rejects.toThrow("Invalid gift wrap");
    await expect(unwrapGiftWrap(bob.signer, { ...wrap, sig: "00".repeat(64) })).rejects.toThrow("Invalid gift wrap");
  });

  test("refuses a seal that is not valid JSON", async () => {
    const bob = identity();
    await expect(unwrapGiftWrap(bob.signer, wrapSealText("not json", bob.pubkey))).rejects.toThrow(SyntaxError);
  });

  test("refuses a seal of the wrong kind", async () => {
    const alice = identity();
    const bob = identity();
    const seal = sealFrom(alice.secret, bob.pubkey, rumorFrom(alice.pubkey), { kind: 14 });

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(seal), bob.pubkey))).rejects.toThrow("Invalid gift-wrap seal");
  });

  test("refuses a seal carrying tags, which could leak routing data", async () => {
    const alice = identity();
    const bob = identity();
    const seal = sealFrom(alice.secret, bob.pubkey, rumorFrom(alice.pubkey), { tags: [["p", bob.pubkey]] });

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(seal), bob.pubkey))).rejects.toThrow("Invalid gift-wrap seal");
  });

  test("refuses a seal whose signature does not verify", async () => {
    const alice = identity();
    const bob = identity();
    const seal = overTheWire(sealFrom(alice.secret, bob.pubkey, rumorFrom(alice.pubkey)));
    const forged = { ...seal, sig: "11".repeat(64) };

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(forged), bob.pubkey))).rejects.toThrow("Invalid gift-wrap seal");
  });

  test("refuses a seal re-attributed to a victim's pubkey", async () => {
    const alice = identity();
    const bob = identity();
    const mallory = identity();
    const seal = overTheWire(sealFrom(mallory.secret, bob.pubkey, rumorFrom(alice.pubkey)));
    const forged = { ...seal, pubkey: alice.pubkey };

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(forged), bob.pubkey))).rejects.toThrow("Invalid gift-wrap seal");
  });

  test("a sender cannot put words in someone else's mouth: seal signer must author the rumor", async () => {
    const alice = identity();
    const bob = identity();
    const mallory = identity();
    const seal = sealFrom(mallory.secret, bob.pubkey, rumorFrom(alice.pubkey));

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(seal), bob.pubkey))).rejects.toThrow("Invalid gift-wrap rumor");
  });

  test("refuses a rumor with tags", async () => {
    const alice = identity();
    const bob = identity();
    const seal = sealFrom(alice.secret, bob.pubkey, rumorFrom(alice.pubkey, { tags: [["e", "x"]] }));

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(seal), bob.pubkey))).rejects.toThrow("Invalid gift-wrap rumor");
  });

  test("refuses a rumor whose id does not hash its content", async () => {
    const alice = identity();
    const bob = identity();
    const rumor = { ...rumorFrom(alice.pubkey), content: JSON.stringify({ edited: true }) };
    const seal = sealFrom(alice.secret, bob.pubkey, rumor);

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(seal), bob.pubkey))).rejects.toThrow("Invalid gift-wrap rumor");
  });

  test("refuses a rumor whose content is not JSON", async () => {
    const alice = identity();
    const bob = identity();
    const seal = sealFrom(alice.secret, bob.pubkey, rumorFrom(alice.pubkey, { content: "plain" }));

    await expect(unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(seal), bob.pubkey))).rejects.toThrow(SyntaxError);
  });

  test("accepts a correctly built wrap from the helpers, proving the rejections above are specific", async () => {
    const alice = identity();
    const bob = identity();
    const seal = sealFrom(alice.secret, bob.pubkey, rumorFrom(alice.pubkey));

    const opened = await unwrapGiftWrap(bob.signer, wrapSealText(JSON.stringify(seal), bob.pubkey, 21059));

    expect(opened.sender).toBe(alice.pubkey);
    expect(opened.payload).toEqual({ hello: "world" });
  });

  test("works with a BrowserNostrSigner recipient and stops after destroy", async () => {
    const alice: Nip44Signer = identity().signer;
    const bob = new BrowserNostrSigner(generateSecretKey());
    const wrap = overTheWire(await createGiftWrap(alice, await bob.getPublicKey(), 1, { ok: 1 }, 1059));

    await expect(unwrapGiftWrap(bob, wrap)).resolves.toMatchObject({ payload: { ok: 1 } });
    bob.destroy();
    await expect(unwrapGiftWrap(bob, wrap)).rejects.toThrow("Signer is no longer available");
  });
});
