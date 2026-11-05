import { generateSecretKey } from "nostr-tools";
import { describe, expect, test } from "vitest";
import { BrowserNostrSigner } from "../../src/crypto/browser-nostr-signer";
import {
  addMember,
  createKeyPackage,
  createRoomState,
  chatEnvelopeToCordnEvent,
  decryptMessage,
  encryptMessage,
  groupCreatorPubkey,
  groupId,
  hasValidChatEnvelopeAuth,
  joinWelcome,
  normalizeRecipientPubkeys,
  signChatEnvelope,
} from "../../src/chat/protocol";

describe("Feature: encrypted ad-hoc chat", () => {
  test("Scenario: an admitted invitee exchanges an MLS-encrypted chat message with the host", async () => {
    const hostSigner = new BrowserNostrSigner(generateSecretKey());
    const guestSigner = new BrowserNostrSigner(generateSecretKey());
    const hostKeyPackage = await createKeyPackage(await hostSigner.getPublicKey());
    const guestKeyPackage = await createKeyPackage(await guestSigner.getPublicKey());
    const hostInitialState = await createRoomState(hostKeyPackage.keyPackage, hostKeyPackage.privateKeyPackage);

    const admitted = await addMember(hostInitialState, guestKeyPackage.stored.publicBase64);
    const guestState = await joinWelcome(admitted.welcomeBase64, guestKeyPackage.stored);
    expect(groupId(guestState)).toBe(groupId(admitted.state));
    expect(groupCreatorPubkey(guestState)).toBe(await hostSigner.getPublicKey());

    const outbound = await encryptMessage(guestState, {
      type: "message",
      id: "message-1",
      sender: await guestSigner.getPublicKey(),
      name: "River",
      badgeLabel: "host",
      badgeEmoji: "★",
      content: "Hello from the invite link",
      createdAt: 1,
    });
    const received = await decryptMessage(admitted.state, outbound.opaqueBase64);

    expect(received.envelope).toMatchObject({ name: "River", content: "Hello from the invite link" });
    expect(received.envelope).not.toHaveProperty("badgeLabel");
    expect(received.envelope).not.toHaveProperty("badgeEmoji");

    const signedHostEnvelope = await signChatEnvelope({
      type: "message",
      id: "message-2",
      sender: await hostSigner.getPublicKey(),
      name: "Ada",
      badgeLabel: "captain",
      badgeEmoji: "★",
      content: "Authenticated host message",
      createdAt: 2_000,
    }, hostSigner);
    expect(hasValidChatEnvelopeAuth(signedHostEnvelope)).toBe(true);
    const hostOutbound = await encryptMessage(received.state, signedHostEnvelope);
    const guestReceived = await decryptMessage(outbound.state, hostOutbound.opaqueBase64, {
      expectedHostPubkey: await hostSigner.getPublicKey(),
    });

    expect(guestReceived.envelope).toMatchObject({
      badgeLabel: "captain",
      badgeEmoji: "★",
    });

    const forgedPresentation = {
      ...signedHostEnvelope,
      badgeLabel: "administrator",
    };
    const forgedOutbound = await encryptMessage(hostOutbound.state, forgedPresentation);
    const forgedReceived = await decryptMessage(guestReceived.state, forgedOutbound.opaqueBase64, {
      expectedHostPubkey: await hostSigner.getPublicKey(),
    });
    expect(forgedReceived.envelope).toMatchObject({ content: "Authenticated host message" });
    // The forged local role presentation is removed before serialization;
    // the resulting canonical Cordn event is still authenticated by MLS AAD.
    expect(hasValidChatEnvelopeAuth(forgedReceived.envelope!)).toBe(true);
    expect(forgedReceived.envelope).not.toHaveProperty("badgeLabel");
    expect(forgedReceived.envelope).not.toHaveProperty("badgeEmoji");

    const signedGuestEnvelope = await signChatEnvelope({
      type: "message",
      id: "message-3",
      sender: await guestSigner.getPublicKey(),
      name: "River",
      badgeLabel: "host",
      badgeEmoji: "!",
      content: "Signed by a member, not the host",
      createdAt: 3_000,
    }, guestSigner);
    const signedGuestOutbound = await encryptMessage(forgedReceived.state, signedGuestEnvelope);
    const hostReceivedGuest = await decryptMessage(forgedOutbound.state, signedGuestOutbound.opaqueBase64, {
      expectedHostPubkey: await hostSigner.getPublicKey(),
    });

    expect(hostReceivedGuest.envelope).toMatchObject({ content: "Signed by a member, not the host" });
    expect(hostReceivedGuest.envelope).not.toHaveProperty("auth");
    expect(hostReceivedGuest.envelope).not.toHaveProperty("badgeLabel");
    expect(hostReceivedGuest.envelope).not.toHaveProperty("badgeEmoji");

    const ordinarySignedGuestEnvelope = await signChatEnvelope({
      type: "message",
      id: "message-4",
      sender: await guestSigner.getPublicKey(),
      name: "River",
      avatar: "https://images.example/river.png",
      content: "An authenticated ordinary message",
      createdAt: 4_000,
    }, guestSigner);
    const ordinarySignedGuestOutbound = await encryptMessage(signedGuestOutbound.state, ordinarySignedGuestEnvelope);
    const hostReceivedOrdinaryGuest = await decryptMessage(hostReceivedGuest.state, ordinarySignedGuestOutbound.opaqueBase64, {
      expectedHostPubkey: await hostSigner.getPublicKey(),
    });

    expect(hostReceivedOrdinaryGuest.envelope).toMatchObject({
      name: "River",
      avatar: "https://images.example/river.png",
      content: "An authenticated ordinary message",
    });
    expect(hasValidChatEnvelopeAuth(hostReceivedOrdinaryGuest.envelope!)).toBe(true);
  });

  test("Scenario: signed reaction mutations survive MLS while forged fields fail authentication", async () => {
    const hostSigner = new BrowserNostrSigner(generateSecretKey());
    const guestSigner = new BrowserNostrSigner(generateSecretKey());
    const hostKey = await createKeyPackage(await hostSigner.getPublicKey());
    const guestKey = await createKeyPackage(await guestSigner.getPublicKey());
    const hostState = await createRoomState(hostKey.keyPackage, hostKey.privateKeyPackage);
    const admitted = await addMember(hostState, guestKey.stored.publicBase64);
    const guestState = await joinWelcome(admitted.welcomeBase64, guestKey.stored);

    const signedReaction = await signChatEnvelope({
      type: "message",
      id: "reaction-1",
      sender: await guestSigner.getPublicKey(),
      name: "River",
      content: "Reacted 👍",
      createdAt: 5_000,
      reaction: {
        targetMessageId: "message-1",
        targetPubkey: await hostSigner.getPublicKey(),
        targetKind: 9,
        emoji: "👍",
        active: true,
      },
    }, guestSigner);
    expect(hasValidChatEnvelopeAuth(signedReaction)).toBe(true);
    expect(chatEnvelopeToCordnEvent(signedReaction).tags).toEqual(expect.arrayContaining([
      ["e", "message-1", "", await hostSigner.getPublicKey()],
      ["p", await hostSigner.getPublicKey()],
      ["k", "9"],
    ]));
    const encrypted = await encryptMessage(guestState, signedReaction);
    const received = await decryptMessage(admitted.state, encrypted.opaqueBase64);
    expect(received.envelope?.reaction).toEqual({
      targetMessageId: "message-1",
      targetPubkey: await hostSigner.getPublicKey(),
      targetKind: 9,
      emoji: "👍",
      active: true,
    });

    for (const forged of [
      { ...signedReaction, reaction: { ...signedReaction.reaction!, targetMessageId: "other-message" } },
      { ...signedReaction, reaction: { ...signedReaction.reaction!, targetPubkey: await guestSigner.getPublicKey() } },
      { ...signedReaction, reaction: { ...signedReaction.reaction!, targetKind: 1 } },
      { ...signedReaction, reaction: { ...signedReaction.reaction!, emoji: "👎" } },
      { ...signedReaction, reaction: { ...signedReaction.reaction!, active: false } },
      { ...signedReaction, sender: await hostSigner.getPublicKey() },
      { ...signedReaction, createdAt: signedReaction.createdAt + 1 },
    ]) {
      expect(hasValidChatEnvelopeAuth(forged as typeof signedReaction)).toBe(false);
    }
  });

  test("Scenario: signed recipient metadata is canonical, authenticated, and survives MLS", async () => {
    const hostSigner = new BrowserNostrSigner(generateSecretKey());
    const guestSigner = new BrowserNostrSigner(generateSecretKey());
    const hostKey = await createKeyPackage(await hostSigner.getPublicKey());
    const guestKey = await createKeyPackage(await guestSigner.getPublicKey());
    const hostState = await createRoomState(hostKey.keyPackage, hostKey.privateKeyPackage);
    const admitted = await addMember(hostState, guestKey.stored.publicBase64);
    const guestState = await joinWelcome(admitted.welcomeBase64, guestKey.stored);
    const hostPubkey = await hostSigner.getPublicKey();
    const guestPubkey = await guestSigner.getPublicKey();

    expect(normalizeRecipientPubkeys([
      hostPubkey.toUpperCase(), guestPubkey, hostPubkey, "not-a-pubkey", 42,
    ])).toEqual([hostPubkey, guestPubkey]);
    expect(normalizeRecipientPubkeys([])).toEqual([]);
    expect(normalizeRecipientPubkeys(hostPubkey)).toEqual([]);

    const signed = await signChatEnvelope({
      type: "message",
      id: "recipient-metadata",
      sender: guestPubkey,
      name: "River",
      content: "@Ada, can you see this?",
      createdAt: 6_000,
      recipientPubkeys: [hostPubkey.toUpperCase(), guestPubkey, hostPubkey],
    }, guestSigner);

    expect(signed.recipientPubkeys).toEqual([hostPubkey, guestPubkey]);
    expect(chatEnvelopeToCordnEvent(signed).tags).toEqual(expect.arrayContaining([
      ["p", hostPubkey], ["p", guestPubkey],
    ]));
    expect(hasValidChatEnvelopeAuth(signed)).toBe(true);
    expect(hasValidChatEnvelopeAuth({
      ...signed,
      recipientPubkeys: [guestPubkey, hostPubkey],
    })).toBe(false);

    const encrypted = await encryptMessage(guestState, signed);
    const received = await decryptMessage(admitted.state, encrypted.opaqueBase64);
    expect(received.envelope).toMatchObject({ recipientPubkeys: [hostPubkey, guestPubkey] });
    expect(hasValidChatEnvelopeAuth(received.envelope!)).toBe(true);

    const signedReaction = await signChatEnvelope({
      type: "message",
      id: "recipient-reaction",
      sender: guestPubkey,
      name: "River",
      content: "Reacted 👍",
      createdAt: 7_000,
      recipientPubkeys: [hostPubkey],
      reaction: {
        targetMessageId: "recipient-metadata",
        targetPubkey: hostPubkey,
        targetKind: 9,
        emoji: "👍",
        active: true,
      },
    }, guestSigner);
    expect(signedReaction).not.toHaveProperty("recipientPubkeys");
    expect(chatEnvelopeToCordnEvent(signedReaction).tags).toEqual(expect.arrayContaining([
      ["e", "recipient-metadata", "", hostPubkey], ["p", hostPubkey], ["k", "9"],
    ]));
  });
});
