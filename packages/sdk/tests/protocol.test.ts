import {
  base64ToBytes,
  bytesToBase64,
  createApplicationMessage,
  createCommit,
  defaultCredentialTypes,
  encode,
  getCiphersuiteImpl,
  keyPackageEncoder,
  mlsMessageEncoder,
  nobleCryptoProvider,
  nodeTypes,
  protocolVersions,
  unsafeTestingAuthenticationService,
  wireformats,
  type ClientState,
} from "ts-mls";
import { generateSecretKey, getEventHash, type UnsignedEvent } from "nostr-tools";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CORDN_GROUP_METADATA_EXTENSION_TYPE, encodeCordnGroupMetadata } from "../src/client/cordn-wire.js";
import {
  CHAT_EMOJI_SHORTCUTS,
  addMember,
  chatEnvelopeToCordnEvent,
  createKeyPackage,
  createRoomState,
  decodeLocalKeyPackage,
  decodeState,
  decryptMessage,
  encodeState,
  encodeWelcome,
  encryptMessage,
  groupCreatorPubkey,
  groupId,
  hasValidChatEnvelopeAuth,
  isChatReactionMutation,
  joinWelcome,
  sanitizeChatEnvelopeHostBadge,
  sealGroupPayloadBase64,
  signChatEnvelope,
  unsealGroupPayloadBase64,
  type ChatEnvelope,
} from "../src/client/protocol.js";
import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";
import { isLastResortKeyPackage } from "../src/mls/lastResortKeyPackage.js";

vi.mock("ts-mls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ts-mls")>();
  return { ...actual, createCommit: vi.fn(actual.createCommit) };
});

const textEncoder = new TextEncoder();

async function pair() {
  const hostSigner = new BrowserNostrSigner(generateSecretKey());
  const guestSigner = new BrowserNostrSigner(generateSecretKey());
  const hostPubkey = await hostSigner.getPublicKey();
  const guestPubkey = await guestSigner.getPublicKey();
  const hostKeys = await createKeyPackage(hostPubkey);
  const guestKeys = await createKeyPackage(guestPubkey);
  const initial = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
  const admitted = await addMember(initial, guestKeys.stored.publicBase64);
  const guestState = await joinWelcome(admitted.welcomeBase64, guestKeys.stored);
  return {
    hostSigner, guestSigner, hostPubkey, guestPubkey, hostKeys, guestKeys,
    initial, admitted,
    hostState: admitted.state,
    guestState,
  };
}

function envelope(sender: string, overrides: Partial<ChatEnvelope> = {}): ChatEnvelope {
  return { type: "message", id: "draft", sender, name: "Ada", content: "hello", createdAt: 5_000, ...overrides };
}

/** Send arbitrary application bytes as a malicious or foreign group member could. */
async function sendRaw(state: ClientState, plaintext: Uint8Array | string, aad: string) {
  const suite = await getCiphersuiteImpl("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519", nobleCryptoProvider);
  const result = await createApplicationMessage({
    context: { cipherSuite: suite, authService: unsafeTestingAuthenticationService },
    state,
    message: typeof plaintext === "string" ? textEncoder.encode(plaintext) : plaintext,
    authenticatedData: textEncoder.encode(aad),
  });
  const serialized = bytesToBase64(encode(mlsMessageEncoder, result.message));
  return { state: result.newState, opaqueBase64: await sealGroupPayloadBase64(state, serialized) };
}

function cordnEvent(pubkey: string, overrides: Partial<UnsignedEvent> = {}) {
  const event: UnsignedEvent = { pubkey, kind: 9, created_at: 5, tags: [], content: "hi", ...overrides };
  return { ...event, id: getEventHash(event) };
}

const replaceFirstLeafCredential = (state: ClientState, credential: unknown): ClientState => ({
  ...state,
  ratchetTree: state.ratchetTree.map((node, index) =>
    index === 0 && node ? { ...node, leaf: { ...(node as { leaf: object }).leaf, credential } } : node) as ClientState["ratchetTree"],
});

afterEach(() => {
  vi.mocked(createCommit).mockClear();
});

describe("state and key-package encoding", () => {
  test("state round trips", async () => {
    const { hostState } = await pair();
    const restored = decodeState(encodeState(hostState));

    expect(groupId(restored)).toBe(groupId(hostState));
    expect(encodeState(restored)).toBe(encodeState(hostState));
  });

  test("stored state refuses garbage and trailing bytes", async () => {
    const { hostState } = await pair();
    expect(() => decodeState(bytesToBase64(Uint8Array.of(1, 2)))).toThrow();
    const trailing = new Uint8Array([...base64ToBytes(encodeState(hostState)), 0]);
    expect(() => decodeState(bytesToBase64(trailing))).toThrow("Invalid stored chat state");
  });

  test("key packages expose a matching reference and decode back", async () => {
    const created = await createKeyPackage("aa".repeat(32));
    const decoded = decodeLocalKeyPackage(created.stored);

    expect(created.stored.reference).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesToBase64(encode(keyPackageEncoder, decoded.keyPackage))).toBe(created.stored.publicBase64);
    expect(created.stored).not.toHaveProperty("lastResort");
    expect(isLastResortKeyPackage(created.keyPackage)).toBe(false);
    expect(new TextDecoder().decode((created.keyPackage.leafNode.credential as { identity: Uint8Array }).identity)).toBe("aa".repeat(32));
  });

  test("last-resort packages are flagged both in storage and on the wire", async () => {
    const created = await createKeyPackage("aa".repeat(32), { lastResort: true });

    expect(created.stored.lastResort).toBe(true);
    expect(isLastResortKeyPackage(created.keyPackage)).toBe(true);
  });

  test("a stored key package refuses corrupted parts", async () => {
    const { stored } = await createKeyPackage("aa".repeat(32));
    const trailing = (value: string) => bytesToBase64(new Uint8Array([...base64ToBytes(value), 0]));

    expect(() => decodeLocalKeyPackage({ ...stored, publicBase64: trailing(stored.publicBase64) })).toThrow("Invalid key package");
    expect(() => decodeLocalKeyPackage({ ...stored, privateBase64: trailing(stored.privateBase64) })).toThrow("Invalid private key package");
  });
});

describe("room creation", () => {
  test("a room without metadata has no Cordn metadata extension", async () => {
    const keys = await createKeyPackage("aa".repeat(32));
    const state = await createRoomState(keys.keyPackage, keys.privateKeyPackage);

    expect(state.groupContext.extensions.some((extension) => extension.extensionType === CORDN_GROUP_METADATA_EXTENSION_TYPE)).toBe(false);
    expect(groupId(state)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("metadata travels in the authenticated group context and reaches joiners", async () => {
    const hostKeys = await createKeyPackage("aa".repeat(32));
    const guestKeys = await createKeyPackage("bb".repeat(32));
    const metadata = { name: "Room", adminPubkeys: ["aa".repeat(32)] };
    const state = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage, metadata);
    const added = await addMember(state, guestKeys.stored.publicBase64);
    const joined = await joinWelcome(added.welcomeBase64, guestKeys.stored);

    const extension = joined.groupContext.extensions.find((entry) => entry.extensionType === CORDN_GROUP_METADATA_EXTENSION_TYPE);
    expect(extension?.extensionData).toEqual(encodeCordnGroupMetadata(metadata));
  });

  test("group ids are unique", async () => {
    const keys = await createKeyPackage("aa".repeat(32));
    const first = await createRoomState(keys.keyPackage, keys.privateKeyPackage);
    const second = await createRoomState(keys.keyPackage, keys.privateKeyPackage);
    expect(groupId(first)).not.toBe(groupId(second));
  });
});

describe("groupCreatorPubkey", () => {
  test("reads the first leaf, for the host and for joiners alike", async () => {
    const { hostState, guestState, hostPubkey } = await pair();
    expect(groupCreatorPubkey(hostState)).toBe(hostPubkey);
    expect(groupCreatorPubkey(guestState)).toBe(hostPubkey);
  });

  test("returns null when the tree has no members", async () => {
    const { hostState } = await pair();
    expect(groupCreatorPubkey({ ...hostState, ratchetTree: [undefined] as ClientState["ratchetTree"] })).toBeNull();
  });

  test("returns null for an identity that is not a Nostr pubkey", async () => {
    const keys = await createKeyPackage("not-a-nostr-key");
    const state = await createRoomState(keys.keyPackage, keys.privateKeyPackage);
    expect(groupCreatorPubkey(state)).toBeNull();
  });

  test.each<[string, unknown]>([
    ["x509", { credentialType: defaultCredentialTypes.x509, certificates: [] }],
    ["custom", { credentialType: 0xf0f0, data: new Uint8Array(1) }],
    ["basic without identity", { credentialType: defaultCredentialTypes.basic }],
  ])("returns null for a %s credential", async (_label, credential) => {
    const { hostState } = await pair();
    expect(groupCreatorPubkey(replaceFirstLeafCredential(hostState, credential))).toBeNull();
  });
});

describe("joining and admitting", () => {
  test("a joiner shares the group and can open the payload seal", async () => {
    const { hostState, guestState } = await pair();
    expect(groupId(guestState)).toBe(groupId(hostState));

    const sealed = await sealGroupPayloadBase64(hostState, bytesToBase64(Uint8Array.of(9)));
    await expect(unsealGroupPayloadBase64(guestState, sealed)).resolves.toBe(bytesToBase64(Uint8Array.of(9)));
  });

  test("a welcome cannot be opened with someone else's key package", async () => {
    const { admitted } = await pair();
    const stranger = await createKeyPackage("cc".repeat(32));
    await expect(joinWelcome(admitted.welcomeBase64, stranger.stored)).rejects.toThrow();
  });

  test("garbage or another MLS message type is not a welcome", async () => {
    const { guestKeys, admitted } = await pair();

    await expect(joinWelcome(bytesToBase64(Uint8Array.of(1, 2)), guestKeys.stored)).rejects.toThrow();
    const trailing = bytesToBase64(new Uint8Array([...base64ToBytes(admitted.welcomeBase64), 0]));
    await expect(joinWelcome(trailing, guestKeys.stored)).rejects.toThrow("Invalid welcome");

    const keyPackageMessage = bytesToBase64(encode(mlsMessageEncoder, {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_key_package,
      keyPackage: guestKeys.keyPackage,
    }));
    await expect(joinWelcome(keyPackageMessage, guestKeys.stored)).rejects.toThrow("Invite did not contain an MLS welcome");
  });

  test("addMember refuses an invalid key package", async () => {
    const { hostState, guestKeys } = await pair();
    const trailing = bytesToBase64(new Uint8Array([...base64ToBytes(guestKeys.stored.publicBase64), 0]));
    await expect(addMember(hostState, trailing)).rejects.toThrow("Invalid member key package");
  });

  test("addMember refuses a member who is already in the group", async () => {
    const { hostState, guestKeys } = await pair();
    await expect(addMember(hostState, guestKeys.stored.publicBase64)).rejects.toThrow();
  });

  test("addMember fails clearly when the MLS library produces no welcome", async () => {
    const { hostState } = await pair();
    const newcomer = await createKeyPackage("cc".repeat(32));
    vi.mocked(createCommit).mockResolvedValueOnce({ commit: {}, newState: hostState } as never);

    await expect(addMember(hostState, newcomer.stored.publicBase64)).rejects.toThrow("Coordinator could not make an invite welcome");
  });

  test("encodeWelcome produces bytes joinWelcome accepts", async () => {
    const hostKeys = await createKeyPackage("aa".repeat(32));
    const guestKeys = await createKeyPackage("bb".repeat(32));
    const state = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const commit = await (await import("ts-mls")).createCommit({
      context: {
        cipherSuite: await getCiphersuiteImpl("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519", nobleCryptoProvider),
        authService: unsafeTestingAuthenticationService,
      },
      state,
      ratchetTreeExtension: true,
      extraProposals: [{ proposalType: 1, add: { keyPackage: guestKeys.keyPackage } }],
    });

    const joined = await joinWelcome(encodeWelcome(commit.welcome!.welcome), guestKeys.stored);
    expect(groupId(joined)).toBe(groupId(state));
  });
});

describe("message encryption and decryption", () => {
  test("delivers the Cordn event with its canonical id", async () => {
    const { guestState, hostState, guestPubkey } = await pair();
    const sent = envelope(guestPubkey, { avatar: "https://images.example/a.png" });

    const { opaqueBase64 } = await encryptMessage(guestState, sent);
    const received = await decryptMessage(hostState, opaqueBase64);

    expect(received.envelope).toMatchObject({
      type: "message",
      sender: guestPubkey,
      name: "Ada",
      avatar: "https://images.example/a.png",
      content: "hello",
      createdAt: 5_000,
      auth: { sig: "cordn" },
    });
    expect(received.envelope!.id).toBe(getEventHash(chatEnvelopeToCordnEvent(sent)));
    expect(received.envelope!.auth!.id).toBe(received.envelope!.id);
  });

  test("an unnamed sender gets a shortened pubkey, and no avatar key", async () => {
    const { guestState, hostState, guestPubkey } = await pair();
    const { opaqueBase64 } = await encryptMessage(guestState, envelope(guestPubkey, { name: "   " }));

    const received = await decryptMessage(hostState, opaqueBase64);

    expect(received.envelope!.name).toBe(`${guestPubkey.slice(0, 8)}…`);
    expect(received.envelope).not.toHaveProperty("avatar");
  });

  test("a ciphertext never contains the plaintext", async () => {
    const { guestState, guestPubkey } = await pair();
    const { opaqueBase64 } = await encryptMessage(guestState, envelope(guestPubkey, { content: "visible-text" }));
    expect(new TextDecoder().decode(base64ToBytes(opaqueBase64))).not.toContain("visible-text");
  });

  test("a replayed message cannot be read twice", async () => {
    const { guestState, hostState, guestPubkey } = await pair();
    const { opaqueBase64 } = await encryptMessage(guestState, envelope(guestPubkey));
    const first = await decryptMessage(hostState, opaqueBase64);

    await expect(decryptMessage(first.state, opaqueBase64)).rejects.toThrow();
  });

  test("rejects a flipped byte and a too-short payload", async () => {
    const { guestState, hostState, guestPubkey } = await pair();
    const { opaqueBase64 } = await encryptMessage(guestState, envelope(guestPubkey));
    const tampered = base64ToBytes(opaqueBase64);
    tampered[tampered.length - 1]! ^= 1;

    await expect(decryptMessage(hostState, bytesToBase64(tampered))).rejects.toThrow();
    await expect(decryptMessage(hostState, bytesToBase64(Uint8Array.of(1)))).rejects.toThrow("too short");
  });

  test("a different room cannot read the message", async () => {
    const { guestState, guestPubkey } = await pair();
    const { hostState: otherHost } = await pair();
    const { opaqueBase64 } = await encryptMessage(guestState, envelope(guestPubkey));

    await expect(decryptMessage(otherHost, opaqueBase64)).rejects.toThrow();
  });

  test("a commit advances the receiver without producing an envelope", async () => {
    const { hostState, guestState } = await pair();
    const newcomer = await createKeyPackage("cc".repeat(32));
    const added = await addMember(hostState, newcomer.stored.publicBase64);

    const received = await decryptMessage(guestState, added.commitBase64);

    expect(received.envelope).toBeUndefined();
    expect(received.state.groupContext.epoch).toBe(guestState.groupContext.epoch + 1n);
    expect(groupId(await joinWelcome(added.welcomeBase64, newcomer.stored))).toBe(groupId(received.state));
  });

  test("a sealed payload that is not an exact MLS message is refused", async () => {
    const { hostState } = await pair();
    const sealed = await sealGroupPayloadBase64(hostState, bytesToBase64(Uint8Array.of(0, 1)));
    await expect(decryptMessage(hostState, sealed)).rejects.toThrow();
  });

  test("a sealed Welcome is refused rather than processed as a group message", async () => {
    const { hostState, admitted } = await pair();
    const sealed = await sealGroupPayloadBase64(hostState, admitted.welcomeBase64);
    await expect(decryptMessage(hostState, sealed)).rejects.toThrow("Invalid MLS message");
  });

  describe("malformed Cordn events from a group member", () => {
    test("requires the authenticated sender", async () => {
      const { guestState, hostState, guestPubkey } = await pair();
      const { opaqueBase64 } = await sendRaw(guestState, JSON.stringify(cordnEvent(guestPubkey)), "");

      await expect(decryptMessage(hostState, opaqueBase64)).rejects.toThrow("no authenticated sender");
    });

    test("requires the event author to match the authenticated data", async () => {
      const { guestState, hostState, guestPubkey, hostPubkey } = await pair();
      const { opaqueBase64 } = await sendRaw(guestState, JSON.stringify(cordnEvent(hostPubkey)), guestPubkey);

      await expect(decryptMessage(hostState, opaqueBase64)).rejects.toThrow("does not match MLS authenticated data");
    });

    test("refuses non-JSON application data", async () => {
      const { guestState, hostState, guestPubkey } = await pair();
      const { opaqueBase64 } = await sendRaw(guestState, "not json", guestPubkey);

      await expect(decryptMessage(hostState, opaqueBase64)).rejects.toThrow(SyntaxError);
    });

    test.each<[string, (pubkey: string) => unknown]>([
      ["null", () => null],
      ["an array", () => []],
      ["a string", () => "event"],
      ["a signed event, which would leak a deniable message's signature", (pk) => ({ ...cordnEvent(pk), sig: "00" })],
      ["a missing id", (pk) => ({ ...cordnEvent(pk), id: undefined })],
      ["a non-string pubkey", (pk) => ({ ...cordnEvent(pk), pubkey: 5 })],
      ["a non-string content", (pk) => ({ ...cordnEvent(pk), content: 5 })],
      ["a non-number timestamp", (pk) => ({ ...cordnEvent(pk), created_at: "5" })],
      ["a non-number kind", (pk) => ({ ...cordnEvent(pk), kind: "9" })],
      ["non-array tags", (pk) => ({ ...cordnEvent(pk), tags: {} })],
    ])("refuses %s", async (_label, build) => {
      const { guestState, hostState, guestPubkey } = await pair();
      const { opaqueBase64 } = await sendRaw(guestState, JSON.stringify(build(guestPubkey)), guestPubkey);

      await expect(decryptMessage(hostState, opaqueBase64)).rejects.toThrow("Invalid Cordn message envelope");
    });

    test("refuses an event whose id does not match its contents", async () => {
      const { guestState, hostState, guestPubkey } = await pair();
      const edited = { ...cordnEvent(guestPubkey), content: "edited after hashing" };
      const { opaqueBase64 } = await sendRaw(guestState, JSON.stringify(edited), guestPubkey);

      await expect(decryptMessage(hostState, opaqueBase64)).rejects.toThrow("id mismatch");
    });

    // Pinned upstream CliSession sends kind 9 with `tags: []`, and decoding fills
    // in a display name, so the proof must use the original tags.
    test("a genuine upstream message with no tags stays authenticated", async () => {
      const { guestState, hostState, guestPubkey } = await pair();
      const { opaqueBase64 } = await sendRaw(guestState, JSON.stringify(cordnEvent(guestPubkey)), guestPubkey);

      const received = await decryptMessage(hostState, opaqueBase64);

      expect(hasValidChatEnvelopeAuth(received.envelope!)).toBe(true);
    });

    test("ignores unsupported event kinds while still advancing the ratchet", async () => {
      const { guestState, hostState, guestPubkey } = await pair();
      const { opaqueBase64 } = await sendRaw(guestState, JSON.stringify(cordnEvent(guestPubkey, { kind: 1 })), guestPubkey);

      const received = await decryptMessage(hostState, opaqueBase64);

      expect(received.envelope).toBeUndefined();
      expect(received.state).not.toBe(hostState);
      await expect(decryptMessage(received.state, opaqueBase64)).rejects.toThrow();
    });
  });

  describe("reactions over the wire", () => {
    const target = "ee".repeat(32);

    async function receiveEvent(overrides: Partial<UnsignedEvent>) {
      const { guestState, hostState, guestPubkey } = await pair();
      const { opaqueBase64 } = await sendRaw(guestState, JSON.stringify(cordnEvent(guestPubkey, { kind: 7, ...overrides })), guestPubkey);
      return decryptMessage(hostState, opaqueBase64);
    }

    test("a canonical NIP-25 reaction becomes an authenticated mutation", async () => {
      const received = await receiveEvent({ content: "👍", tags: [["name", "Ada"], ["e", "msg", "", target], ["p", target], ["k", "9"], ["cahmls-active", "0"]] });

      expect(received.envelope!.content).toBe("Reacted 👍");
      expect(received.envelope!.reaction).toEqual({ targetMessageId: "msg", targetPubkey: target, targetKind: 9, emoji: "👍", active: false });
      expect(hasValidChatEnvelopeAuth(received.envelope!)).toBe(true);
    });

    // A rebuilt event only reproduces CAHMLS's own tag layout, so foreign events
    // must verify against the tags they arrived with.
    test.each<[string, string[][]]>([
      ["no name tag", [["e", "msg"]]],
      ["an extra tag", [["name", "Ada"], ["e", "msg"], ["client", "cordn"]]],
      ["reordered tags", [["e", "msg"], ["name", "Ada"]]],
    ])("a genuine foreign reaction with %s stays authenticated", async (_label, tags) => {
      const received = await receiveEvent({ content: "👍", tags });
      expect(hasValidChatEnvelopeAuth(received.envelope!)).toBe(true);
    });

    test("a foreign proof rejects presentation that its original tags do not state", async () => {
      const received = await receiveEvent({ kind: 9, content: "hello", tags: [["client", "cordn"], ["name", "Ada"]] });
      const envelope = received.envelope!;
      expect(envelope.auth?.tags).toBeDefined();
      expect(hasValidChatEnvelopeAuth(envelope)).toBe(true);

      for (const field of ["name", "avatar", "badgeLabel", "badgeEmoji"] as const) {
        expect(hasValidChatEnvelopeAuth({ ...envelope, [field]: "edited" })).toBe(false);
      }
      expect(hasValidChatEnvelopeAuth({ ...envelope, content: "edited" })).toBe(false);
      expect(hasValidChatEnvelopeAuth({ ...envelope, auth: { ...envelope.auth!, tags: [] } })).toBe(false);
    });

    test("a foreign proof rejects tags that no longer decode to a chat event", async () => {
      const received = await receiveEvent({ content: "👍", tags: [["client", "cordn"], ["e", "msg"]] });
      const envelope = received.envelope!;
      const event = chatEnvelopeToCordnEvent(envelope);
      const tags = [["client", "cordn"]];
      const id = getEventHash({ ...event, tags });

      expect(hasValidChatEnvelopeAuth({ ...envelope, id, auth: { id, sig: "cordn", tags } })).toBe(false);
    });

    test("an event CAHMLS can rebuild carries no redundant tags", async () => {
      const { hostState, guestState, hostPubkey } = await pair();
      const { opaqueBase64 } = await encryptMessage(hostState, envelope(hostPubkey));

      const received = await decryptMessage(guestState, opaqueBase64);

      expect(received.envelope!.auth).not.toHaveProperty("tags");
    });

    test("an upstream reaction without the CAHMLS flag counts as active", async () => {
      const received = await receiveEvent({ content: "🎉", tags: [["e", "msg"]] });

      expect(received.envelope!.reaction).toEqual({ targetMessageId: "msg", emoji: "🎉", active: true });
    });

    test.each<[string, Partial<UnsignedEvent>]>([
      ["no target", { content: "👍", tags: [] }],
      ["an emoji outside the shared set", { content: "💣", tags: [["e", "msg"]] }],
    ])("ignores a reaction with %s", async (_label, overrides) => {
      const received = await receiveEvent(overrides);
      expect(received.envelope).toBeUndefined();
    });

    test("a reaction with a non-numeric target kind loses its authentication, so rooms will not apply it", async () => {
      const received = await receiveEvent({ content: "👍", tags: [["e", "msg", "", target], ["p", target], ["k", "abc"]] });

      expect(received.envelope!.reaction?.targetKind).toBeNaN();
      expect(received.envelope).not.toHaveProperty("auth");
      expect(hasValidChatEnvelopeAuth(received.envelope!)).toBe(false);
    });

    test("a reaction round trips through encryptMessage", async () => {
      const { guestState, hostState, guestPubkey, hostPubkey } = await pair();
      const reaction = { targetMessageId: "msg", targetPubkey: hostPubkey, targetKind: 9, emoji: "❤️" as const, active: true };
      const { opaqueBase64 } = await encryptMessage(guestState, envelope(guestPubkey, { content: "Reacted ❤️", reaction }));

      const received = await decryptMessage(hostState, opaqueBase64);

      expect(received.envelope!.reaction).toEqual(reaction);
      expect(hasValidChatEnvelopeAuth(received.envelope!)).toBe(true);
    });
  });

  describe("host badge authority", () => {
    test("a badge from the host survives; the same badge from a member does not", async () => {
      const { hostState, guestState, hostPubkey, guestPubkey } = await pair();
      const options = { expectedHostPubkey: hostPubkey };

      const fromHost = await encryptMessage(hostState, envelope(hostPubkey, { badgeLabel: "host", badgeEmoji: "★" }));
      const atGuest = await decryptMessage(guestState, fromHost.opaqueBase64, options);
      expect(atGuest.envelope).toMatchObject({ badgeLabel: "host", badgeEmoji: "★" });

      const fromGuest = await encryptMessage(atGuest.state, envelope(guestPubkey, { badgeLabel: "host", badgeEmoji: "★" }));
      const atHost = await decryptMessage(fromHost.state, fromGuest.opaqueBase64, options);
      expect(atHost.envelope).not.toHaveProperty("badgeLabel");
      expect(atHost.envelope).not.toHaveProperty("badgeEmoji");
    });

    test("no badge survives when the host is unknown", async () => {
      const { hostState, guestState, hostPubkey } = await pair();
      const { opaqueBase64 } = await encryptMessage(hostState, envelope(hostPubkey, { badgeLabel: "host" }));

      const received = await decryptMessage(guestState, opaqueBase64);

      expect(received.envelope).not.toHaveProperty("badgeLabel");
    });

    test.each<[string, unknown]>([
      ["a non-basic credential", { credentialType: defaultCredentialTypes.x509, certificates: [] }],
      ["an unknown credential type", { credentialType: 0xf000, data: new Uint8Array() }],
    ])("rejects a sender whose member has %s", async (_label, credential) => {
      const { hostState, guestState, guestPubkey } = await pair();
      const { opaqueBase64 } = await encryptMessage(guestState, envelope(guestPubkey));
      const decoder = new TextDecoder();
      const ratchetTree = hostState.ratchetTree.map((node) => {
        if (node?.nodeType !== nodeTypes.leaf) return node;
        const leafCredential = node.leaf.credential as { identity?: Uint8Array };
        if (!leafCredential.identity || decoder.decode(leafCredential.identity) !== guestPubkey) return node;
        return { ...node, leaf: { ...node.leaf, credential } };
      }) as typeof hostState.ratchetTree;

      await expect(decryptMessage({ ...hostState, ratchetTree }, opaqueBase64)).rejects.toThrow("MLS credential");
    });

    test("rejects a message from an earlier epoch whose sender has since left", async () => {
      const { hostState } = await pair();
      const leaverPubkey = "c".repeat(64);
      const leaverKeys = await createKeyPackage(leaverPubkey);
      const admitted = await addMember(hostState, leaverKeys.stored.publicBase64);
      const leaverState = await joinWelcome(admitted.welcomeBase64, leaverKeys.stored);
      const sent = await encryptMessage(leaverState, envelope(leaverPubkey));
      const framed = await unsealGroupPayloadBase64(leaverState, sent.opaqueBase64);

      const suite = await getCiphersuiteImpl("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519", nobleCryptoProvider);
      const leaverIndex = admitted.state.ratchetTree.findIndex((node) => node?.nodeType === nodeTypes.leaf
        && new TextDecoder().decode((node.leaf.credential as { identity: Uint8Array }).identity) === leaverPubkey);
      const removal = await createCommit({
        context: { cipherSuite: suite, authService: unsafeTestingAuthenticationService },
        state: admitted.state,
        extraProposals: [{ proposalType: 3, remove: { removed: leaverIndex / 2 } }],
      });
      const resealed = await sealGroupPayloadBase64(removal.newState, framed);

      await expect(decryptMessage(removal.newState, resealed)).rejects.toThrow("MLS credential");
    });

    test("a member cannot claim to be another member by writing the host's key in aad and event", async () => {
      const { hostState, guestState, hostPubkey } = await pair();
      const spoofed = await encryptMessage(guestState, envelope(hostPubkey, { name: "Host", badgeLabel: "host" }));

      await expect(decryptMessage(hostState, spoofed.opaqueBase64, { expectedHostPubkey: hostPubkey })).rejects.toThrow();
    });
  });

  describe("encryptMessage presentation safety", () => {
    test("an unsigned draft keeps its fields", async () => {
      const { hostState, guestState, hostPubkey } = await pair();
      const { opaqueBase64 } = await encryptMessage(hostState, envelope(hostPubkey, { badgeLabel: "host" }));
      const received = await decryptMessage(guestState, opaqueBase64, { expectedHostPubkey: hostPubkey });
      expect(received.envelope!.badgeLabel).toBe("host");
    });

    test("a correctly signed envelope keeps its badge", async () => {
      const { hostState, guestState, hostPubkey, hostSigner } = await pair();
      const signed = await signChatEnvelope(envelope(hostPubkey, { badgeLabel: "host", badgeEmoji: "★" }), hostSigner);

      const { opaqueBase64 } = await encryptMessage(hostState, signed);
      const received = await decryptMessage(guestState, opaqueBase64, { expectedHostPubkey: hostPubkey });

      expect(received.envelope).toMatchObject({ id: signed.id, badgeLabel: "host", badgeEmoji: "★" });
    });

    test("a badge edited after signing is dropped before serialization", async () => {
      const { hostState, guestState, hostPubkey, hostSigner } = await pair();
      const signed = await signChatEnvelope(envelope(hostPubkey, { badgeLabel: "host", badgeEmoji: "★" }), hostSigner);

      const { opaqueBase64 } = await encryptMessage(hostState, { ...signed, badgeLabel: "admin" });
      const received = await decryptMessage(guestState, opaqueBase64, { expectedHostPubkey: hostPubkey });

      expect(received.envelope).toMatchObject({ content: "hello" });
      expect(received.envelope).not.toHaveProperty("badgeLabel");
      expect(received.envelope).not.toHaveProperty("badgeEmoji");
    });

    test("a valid signature over a stale id is also treated as forged", async () => {
      const { hostState, guestState, hostPubkey, hostSigner } = await pair();
      const signed = await signChatEnvelope(envelope(hostPubkey, { badgeLabel: "host" }), hostSigner);
      // Re-signed with the old id still in place: the proof verifies but no longer names this event.
      const staleId = "11".repeat(32);
      const reSigned = await hostSigner.signEvent({
        kind: 24_242,
        created_at: 5,
        tags: [["d", staleId]],
        content: JSON.stringify({
          type: "message", id: staleId, sender: hostPubkey, name: "Ada", avatar: null,
          badgeLabel: "host", badgeEmoji: null, content: "hello", createdAt: 5_000, reaction: null,
        }),
      });
      const stale: ChatEnvelope = { ...signed, id: staleId, auth: { id: reSigned.id, sig: reSigned.sig } };
      expect(hasValidChatEnvelopeAuth(stale)).toBe(true);

      const { opaqueBase64 } = await encryptMessage(hostState, stale);
      const received = await decryptMessage(guestState, opaqueBase64, { expectedHostPubkey: hostPubkey });

      expect(received.envelope).not.toHaveProperty("badgeLabel");
    });
  });
});

describe("signChatEnvelope", () => {
  test("binds the canonical Cordn id and proves every field", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());
    const pubkey = await signer.getPublicKey();
    const draft = envelope(pubkey, { id: "client-chosen", avatar: "https://a.example/x.png", badgeLabel: "b", badgeEmoji: "e" });

    const signed = await signChatEnvelope(draft, signer);

    expect(signed.id).toBe(getEventHash(chatEnvelopeToCordnEvent(draft)));
    expect(hasValidChatEnvelopeAuth(signed)).toBe(true);
    for (const forged of [
      { ...signed, name: "Other" },
      { ...signed, avatar: "https://evil.example/x.png" },
      { ...signed, badgeLabel: "admin" },
      { ...signed, badgeEmoji: "!" },
      { ...signed, content: "changed" },
      { ...signed, createdAt: signed.createdAt + 1 },
      { ...signed, id: "22".repeat(32) },
      { ...signed, auth: { ...signed.auth!, sig: "00".repeat(64) } },
    ]) {
      expect(hasValidChatEnvelopeAuth(forged)).toBe(false);
    }
  });

  test("refuses a signer whose key is not the sender's", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());
    await expect(signChatEnvelope(envelope("aa".repeat(32)), signer)).rejects.toThrow("invalid message signature");
  });

  test("refuses a signer returning an invalid signature for the right key", async () => {
    const real = new BrowserNostrSigner(generateSecretKey());
    const pubkey = await real.getPublicKey();
    const broken = {
      getPublicKey: () => real.getPublicKey(),
      signEvent: async (template: Parameters<typeof real.signEvent>[0]) => ({
        ...JSON.parse(JSON.stringify(await real.signEvent(template))) as object,
        sig: "00".repeat(64),
      }),
    };

    await expect(signChatEnvelope(envelope(pubkey), broken as never)).rejects.toThrow("invalid message signature");
  });

  test("a destroyed signer cannot sign", async () => {
    const signer = new BrowserNostrSigner(generateSecretKey());
    const pubkey = await signer.getPublicKey();
    signer.destroy();
    await expect(signChatEnvelope(envelope(pubkey), signer)).rejects.toThrow("Signer is no longer available");
  });
});

describe("hasValidChatEnvelopeAuth", () => {
  const sender = "aa".repeat(32);

  test("an envelope with no proof is not authenticated", () => {
    expect(hasValidChatEnvelopeAuth(envelope(sender))).toBe(false);
  });

  test.each(["short", "zz".repeat(32), ""])("refuses a non-pubkey sender (%s)", (bad) => {
    expect(hasValidChatEnvelopeAuth(envelope(bad, { auth: { id: "x", sig: "cordn" } }))).toBe(false);
  });

  test("refuses a malformed reaction even with a matching id", () => {
    const base = envelope(sender, { reaction: { targetMessageId: "", emoji: "👍", active: true } });
    const id = getEventHash(chatEnvelopeToCordnEvent(base));
    expect(hasValidChatEnvelopeAuth({ ...base, id, auth: { id, sig: "cordn" } })).toBe(false);
  });

  test("the cordn proof requires the id, proof id and content hash to agree", () => {
    const base = envelope(sender);
    const id = getEventHash(chatEnvelopeToCordnEvent(base));

    expect(hasValidChatEnvelopeAuth({ ...base, id, auth: { id, sig: "cordn" } })).toBe(true);
    expect(hasValidChatEnvelopeAuth({ ...base, id, auth: { id: "other", sig: "cordn" } })).toBe(false);
    expect(hasValidChatEnvelopeAuth({ ...base, id: "other", auth: { id: "other", sig: "cordn" } })).toBe(false);
    expect(hasValidChatEnvelopeAuth({ ...base, id, content: "changed", auth: { id, sig: "cordn" } })).toBe(false);
  });

  test("answers false instead of throwing on data nostr-tools cannot serialize", () => {
    // The sender regex accepts upper case, but event hashing does not. This
    // runs over persisted room history, so a throw would stop the room loading.
    const upper = "AA".repeat(32);
    expect(hasValidChatEnvelopeAuth(envelope(upper, { id: "x", auth: { id: "x", sig: "cordn" } }))).toBe(false);
    expect(hasValidChatEnvelopeAuth(envelope(upper, { auth: { id: "x", sig: "00".repeat(64) } }))).toBe(false);
    expect(hasValidChatEnvelopeAuth(envelope(sender, { id: "x", createdAt: Number.NaN, auth: { id: "x", sig: "cordn" } }))).toBe(false);
  });

  test("malformed signature material is simply invalid", () => {
    expect(hasValidChatEnvelopeAuth(envelope(sender, { auth: { id: "x", sig: "not-hex" } }))).toBe(false);
  });
});

describe("sanitizeChatEnvelopeHostBadge", () => {
  async function signedAs(overrides: Partial<ChatEnvelope> = {}) {
    const signer = new BrowserNostrSigner(generateSecretKey());
    const pubkey = await signer.getPublicKey();
    return { pubkey, signed: await signChatEnvelope(envelope(pubkey, overrides), signer) };
  }

  test("returns the same object when there is nothing to change", async () => {
    const plain = envelope("aa".repeat(32));
    expect(sanitizeChatEnvelopeHostBadge(plain)).toBe(plain);

    const { signed } = await signedAs();
    expect(sanitizeChatEnvelopeHostBadge(signed)).toBe(signed);
  });

  test("keeps the signed badge of the host, comparing keys case-insensitively", async () => {
    const { signed, pubkey } = await signedAs({ badgeLabel: "host", badgeEmoji: "★" });
    expect(sanitizeChatEnvelopeHostBadge(signed, pubkey.toUpperCase())).toBe(signed);
  });

  test("strips the badge and the proof that covered it for anyone else", async () => {
    const { signed } = await signedAs({ badgeLabel: "host", badgeEmoji: "★" });

    const sanitized = sanitizeChatEnvelopeHostBadge(signed, "cc".repeat(32));

    expect(sanitized).not.toHaveProperty("badgeLabel");
    expect(sanitized).not.toHaveProperty("badgeEmoji");
    expect(sanitized).not.toHaveProperty("auth");
    expect(sanitized.content).toBe("hello");
    expect(signed.badgeLabel).toBe("host");
  });

  test("strips the badge when no host is known, or when only an emoji is present", async () => {
    const { signed } = await signedAs({ badgeEmoji: "★" });
    expect(sanitizeChatEnvelopeHostBadge(signed)).not.toHaveProperty("badgeEmoji");
  });

  test("an unsigned badge claiming to be the host is stripped", () => {
    const host = "aa".repeat(32);
    const sanitized = sanitizeChatEnvelopeHostBadge(envelope(host, { badgeLabel: "host" }), host);
    expect(sanitized).not.toHaveProperty("badgeLabel");
  });

  test("an invalid proof is removed even when there is no badge", async () => {
    const { signed } = await signedAs();
    const forged = { ...signed, content: "changed" };

    const sanitized = sanitizeChatEnvelopeHostBadge(forged);

    expect(sanitized).not.toHaveProperty("auth");
    expect(sanitized.content).toBe("changed");
  });

  test("a forged host badge with an invalid proof loses both", async () => {
    const { signed, pubkey } = await signedAs({ badgeLabel: "host" });
    const sanitized = sanitizeChatEnvelopeHostBadge({ ...signed, badgeLabel: "admin" }, pubkey);

    expect(sanitized).not.toHaveProperty("badgeLabel");
    expect(sanitized).not.toHaveProperty("auth");
  });

  test("does not throw on persisted history with an upper-case sender", () => {
    const upper = envelope("AA".repeat(32), { id: "x", auth: { id: "x", sig: "cordn" } });
    expect(sanitizeChatEnvelopeHostBadge(upper)).not.toHaveProperty("auth");
  });
});

describe("chatEnvelopeToCordnEvent (wire format pin)", () => {
  const sender = "aa".repeat(32);

  test("a message is kind 9 with trimmed presentation tags in a stable order", () => {
    expect(chatEnvelopeToCordnEvent(envelope(sender, {
      name: " Ada ",
      avatar: " https://a.example/x.png ",
      badgeLabel: " host ",
      badgeEmoji: " ★ ",
      createdAt: 5_999,
    }))).toEqual({
      pubkey: sender,
      content: "hello",
      created_at: 5,
      kind: 9,
      tags: [
        ["name", "Ada"],
        ["avatar", "https://a.example/x.png"],
        ["cahmls-badge-label", "host"],
        ["cahmls-badge-emoji", "★"],
      ],
    });
  });

  test("blank presentation fields produce no tags", () => {
    expect(chatEnvelopeToCordnEvent(envelope(sender, { name: " ", avatar: " ", badgeLabel: " ", badgeEmoji: " " })).tags).toEqual([]);
  });

  test("a legacy reaction is kind 7 with only the e tag and the emoji as content", () => {
    expect(chatEnvelopeToCordnEvent(envelope(sender, {
      name: "",
      content: "ignored",
      reaction: { targetMessageId: "msg", emoji: "👍", active: false },
    }))).toMatchObject({
      kind: 7,
      content: "👍",
      tags: [["e", "msg"], ["cahmls-active", "0"]],
    });
  });

  test("a canonical reaction carries the NIP-25 e, p and k tags, with kind 0 preserved", () => {
    const target = "bb".repeat(32);
    expect(chatEnvelopeToCordnEvent(envelope(sender, {
      name: "",
      reaction: { targetMessageId: "msg", targetPubkey: target, targetKind: 0, emoji: "🎉", active: true },
    })).tags).toEqual([
      ["e", "msg", "", target],
      ["p", target],
      ["k", "0"],
      ["cahmls-active", "1"],
    ]);
  });
});

describe("isChatReactionMutation", () => {
  const legacy = { targetMessageId: "msg", emoji: "👍", active: true };
  const canonical = { ...legacy, targetPubkey: "bb".repeat(32), targetKind: 9 };

  test("the shared emoji set is what the validator accepts", () => {
    for (const emoji of CHAT_EMOJI_SHORTCUTS) {
      expect(isChatReactionMutation({ ...legacy, emoji })).toBe(true);
    }
  });

  test.each<[string, unknown]>([
    ["legacy", legacy],
    ["canonical", canonical],
    ["upper-case target key", { ...canonical, targetPubkey: "BB".repeat(32) }],
    ["kind zero", { ...canonical, targetKind: 0 }],
    ["inactive", { ...legacy, active: false }],
  ])("accepts %s", (_label, value) => {
    expect(isChatReactionMutation(value)).toBe(true);
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a string", "reaction"],
    ["an array", []],
    ["an empty object", {}],
    ["an unknown extra key", { ...legacy, extra: 1 }],
    ["an unknown extra key on canonical", { ...canonical, extra: 1 }],
    ["only one canonical key", { ...legacy, targetKind: 9 }],
    ["wrong keys of legacy length", { a: 1, b: 2, c: 3 }],
    ["legacy length, last key wrong", { active: true, emoji: "👍", zzz: "x" }],
    ["legacy length, middle key wrong", { active: true, xyz: "👍", targetMessageId: "x" }],
    ["wrong keys of canonical length", { a: 1, b: 2, c: 3, d: 4, e: 5 }],
    ["canonical length, second key wrong", { active: true, bad: "👍", targetKind: 9, targetMessageId: "x", targetPubkey: "bb" }],
    ["canonical length, third key wrong", { active: true, emoji: "👍", extra: 9, targetMessageId: "x", targetPubkey: "bb" }],
    ["canonical length, fourth key wrong", { active: true, emoji: "👍", targetKind: 9, targetZzz: "x", targetPubkey: "bb" }],
    ["canonical length, last key wrong", { active: true, emoji: "👍", targetKind: 9, targetMessageId: "x", zzz: "bb" }],
    ["a non-string target", { ...legacy, targetMessageId: 5 }],
    ["a blank target", { ...legacy, targetMessageId: "   " }],
    ["a short target key", { ...canonical, targetPubkey: "bb" }],
    ["a string kind", { ...canonical, targetKind: "9" }],
    ["a fractional kind", { ...canonical, targetKind: 1.5 }],
    ["a NaN kind", { ...canonical, targetKind: Number.NaN }],
    ["a negative kind", { ...canonical, targetKind: -1 }],
    ["an unsafe kind", { ...canonical, targetKind: 2 ** 53 }],
    ["a non-string emoji", { ...legacy, emoji: 1 }],
    ["an emoji outside the set", { ...legacy, emoji: "👎" }],
    ["a non-boolean active", { ...legacy, active: "true" }],
  ])("refuses %s", (_label, value) => {
    expect(isChatReactionMutation(value)).toBe(false);
  });
});
