import { describe, expect, test } from "vitest";
import { parseInviteUrl, type ChatInvite } from "@cahmls/sdk/client";
import { createSameShellChatHref } from "../../src/chat/room-navigation";
import type { StoredRoom } from "@cahmls/sdk/client";

describe("same-shell room navigation", () => {
  test("renders a stored room on the accepted shell without exposing its invite capability", () => {
    const room = {
      id: "stored-room",
      title: "Stored room",
      coordinatorPubkey: "a".repeat(64),
      coordinatorOrigin: "https://coordinator.example:443/api",
      relayUrls: ["wss://one.example", "wss://two.example"],
      inviteToken: "stored-capability",
      coordinatorKeyMode: "ephemeral",
      isHost: false,
      joinRequestSent: true,
      host: {
        name: "Ada",
        pubkey: "f".repeat(64),
        avatar: "https://images.example/ada.png",
      },
    } as unknown as StoredRoom;

    const href = createSameShellChatHref("http://localhost:5173/app", room);

    expect(new URL(href).origin).toBe("http://localhost:5173");
    expect(new URL(href).searchParams.has("i")).toBe(false);
    expect(parseInviteUrl(href)).toEqual({
      groupId: "stored-room",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: ["wss://one.example", "wss://two.example"],
      title: "Stored room",
      coordinatorOrigin: "https://coordinator.example",
      host: {
        name: "Ada",
        pubkey: "f".repeat(64),
        avatar: "https://images.example/ada.png",
      },
      coordinatorKeyMode: "ephemeral",
    });
  });

  test("retains the invite capability when rendering a direct invite on the accepted shell", () => {
    const invite: ChatInvite = {
      groupId: "invited-room",
      title: "Invited room",
      coordinatorPubkey: "b".repeat(64),
      coordinatorOrigin: "http://remote.example:8080",
      relayUrls: ["wss://relay.example"],
      inviteToken: "invite-capability",
      host: {
        name: "Grace",
        pubkey: "e".repeat(64),
      },
      coordinatorKeyMode: "persistent",
    };

    const href = createSameShellChatHref("https://local-shell.example", invite);

    expect(new URL(href).origin).toBe("https://local-shell.example");
    expect(new URL(href).searchParams.get("i")).toBe("invite-capability");
    expect(parseInviteUrl(href)).toEqual(invite);
  });

  test("uses the room member identity as the host for a legacy hosted room", () => {
    const room = {
      id: "legacy-hosted-room",
      title: "Legacy hosted room",
      coordinatorPubkey: "a".repeat(64),
      coordinatorOrigin: "https://coordinator.example",
      relayUrls: [],
      name: "Legacy host",
      avatar: "https://images.example/legacy.png",
      stablePubkey: "b".repeat(64),
      isHost: true,
    } as unknown as StoredRoom;

    expect(parseInviteUrl(createSameShellChatHref("https://shell.example", room))?.host).toEqual({
      name: "Legacy host",
      pubkey: "b".repeat(64),
      avatar: "https://images.example/legacy.png",
    });
  });

  test("does not misattribute a legacy joined room to its coordinator", () => {
    const room = {
      id: "legacy-joined-room",
      title: "Legacy joined room",
      coordinatorPubkey: "c".repeat(64),
      coordinatorOrigin: "https://coordinator.example",
      relayUrls: [],
      name: "Member",
      stablePubkey: "d".repeat(64),
      isHost: false,
    } as unknown as StoredRoom;

    expect(parseInviteUrl(createSameShellChatHref("https://shell.example", room))?.host).toBeUndefined();
  });
});
