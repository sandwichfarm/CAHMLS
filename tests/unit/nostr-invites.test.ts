import { beforeEach, describe, expect, test } from "vitest";
import { generateSecretKey } from "nostr-tools";

import {
  createGiftWrap,
  createLocalNip44Signer,
  unwrapGiftWrap,
} from "@cahmls/sdk/client";
import {
  inviteEligibilityError,
  NostrSocialStore,
  shouldAcceptInvite,
} from "../../src/invites/nostr-social.svelte";
import {
  INVITATION_RESOLUTION_STORAGE_KEY,
  NotificationCenterStore,
} from "../../src/notifications/notification-center.svelte";

describe("private Nostr presence and invites", () => {
  beforeEach(() => localStorage.clear());

  test("round-trips a gift-wrapped invite without exposing its sender or payload", async () => {
    const sender = createLocalNip44Signer(generateSecretKey());
    const recipient = createLocalNip44Signer(generateSecretKey());
    const recipientPubkey = await recipient.getPublicKey();
    const senderPubkey = await sender.getPublicKey();

    const wrapped = await createGiftWrap(sender, recipientPubkey, 24134, {
      type: "cordn-room-invite",
      inviteUrl: "https://cordn.test/chat/secret",
    }, 1059);

    expect(wrapped.pubkey).not.toBe(senderPubkey);
    expect(wrapped.content).not.toContain("cordn-room-invite");
    expect(wrapped.content).not.toContain("/chat/secret");
    expect(wrapped.tags).toEqual([["p", recipientPubkey]]);

    const opened = await unwrapGiftWrap(recipient, wrapped);
    expect(opened.sender).toBe(senderPubkey);
    expect(opened.kind).toBe(24134);
    expect(opened.payload).toEqual({
      type: "cordn-room-invite",
      inviteUrl: "https://cordn.test/chat/secret",
    });
  });

  test("enforces mutual-online egress and followed-sender ingress", () => {
    const now = 10_000;
    expect(inviteEligibilityError("mutual", ["mutual"], [{ pubkey: "mutual", expiresAt: now + 1 }], now)).toBeNull();
    expect(inviteEligibilityError("stranger", ["mutual"], [], now)).toMatch(/mutual follows/);
    expect(inviteEligibilityError("mutual", ["mutual"], [{ pubkey: "mutual", expiresAt: now }], now)).toMatch(/not currently online/);

    expect(shouldAcceptInvite("followed", ["followed"])).toBe(true);
    expect(shouldAcceptInvite("stranger", ["followed"])).toBe(false);
  });

  test("resolves an invite before removing its live capability and persists no URL", () => {
    const social = new NostrSocialStore();
    social.incomingInvites = [{
      id: "handled-invite",
      from: "followed",
      fromName: "Alice",
      fromAvatar: "avatar",
      inviteUrl: "https://cordn.test/chat/room-secret-token",
      roomTitle: "Private room",
      createdAt: Date.now(),
    }];

    social.dismissInvite("handled-invite");

    expect(social.incomingInvites).toEqual([]);
    const persisted = localStorage.getItem(INVITATION_RESOLUTION_STORAGE_KEY) ?? "";
    expect(persisted).toContain("handled-invite");
    expect(persisted).not.toContain("room-secret-token");
    expect(new NotificationCenterStore().isInvitationResolved("handled-invite")).toBe(true);
  });

  test("suppresses replay of a trusted invite already resolved inside retention", async () => {
    const social = new NostrSocialStore();
    const internals = social as unknown as {
      socialGraphRefreshedAt: number;
      profiles: Map<string, unknown>;
      receiveInvite(sender: string, value: unknown): Promise<void>;
    };
    social.following = ["followed"];
    internals.socialGraphRefreshedAt = Date.now();
    internals.profiles.set("followed", { name: "Alice" });
    social.incomingInvites = [{
      id: "replayed-invite",
      from: "followed",
      fromName: "Alice",
      fromAvatar: "avatar",
      inviteUrl: "https://cordn.test/chat/another-secret",
      roomTitle: "Private room",
      createdAt: Date.now(),
    }];
    social.dismissInvite("replayed-invite");

    await internals.receiveInvite("followed", {
      type: "cordn-room-invite",
      id: "replayed-invite",
      inviteUrl: "https://cordn.test/chat/another-secret",
      roomTitle: "Private room",
      createdAt: Date.now(),
    });

    expect(social.incomingInvites).toEqual([]);
  });
});
