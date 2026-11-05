import { describe, expect, test } from "vitest";
import { nip19 } from "nostr-tools";
import {
  CORDN_DEFAULT_COORDINATOR_PUBKEY,
  createInviteUrl,
  parseInviteMessage,
  parseInviteUrl,
} from "@cahmls/sdk/client";
import { createSameShellAutoJoinHref } from "../../src/chat/room-navigation";

describe("Feature: self-contained chat invitations", () => {
  test("Scenario: the one current-origin invite link uses the canonical Cordn shape", () => {
    const url = new URL(createInviteUrl("https://cahmls.example", {
      groupId: "group-α",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: ["wss://one.example", "wss://two.example"],
      title: "Friday plans",
      coordinatorName: "Madeira relay",
      inviteToken: "cahmls-only-admission-token",
    }));

    expect(url.origin).toBe("https://cahmls.example");
    expect(url.pathname).toBe("/chat/group-%CE%B1");
    expect(url.searchParams.get("c")).toMatch(/^nprofile1/);
    expect(JSON.parse(Buffer.from(url.searchParams.get("m")!, "base64url").toString())).toMatchObject({
      name: "Friday plans",
    });
    expect(url.searchParams.get("i")).toBe("cahmls-only-admission-token");
    expect(parseInviteUrl(url.toString())).toMatchObject({
      groupId: "group-α",
      coordinatorPubkey: "a".repeat(64),
      title: "Friday plans",
      coordinatorName: "Madeira relay",
    });
  });

  test("Scenario: a complete invite message becomes a canonical current-shell auto-join target", () => {
    const shared = createInviteUrl("https://sender.example", {
      groupId: "night-shift",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: ["wss://relay.example"],
      title: "Night shift",
      coordinatorName: "Madeira node",
      inviteToken: "private-capability",
      host: { name: "Mara", pubkey: "b".repeat(64), avatar: "https://images.example/mara.png" },
    });

    const invite = parseInviteMessage(`  ${shared}\n`);
    expect(invite).toMatchObject({
      groupId: "night-shift",
      title: "Night shift",
      coordinatorName: "Madeira node",
      host: { name: "Mara" },
    });
    const destination = new URL(createSameShellAutoJoinHref("https://current.example", invite!));
    expect(destination.origin).toBe("https://current.example");
    expect(destination.pathname).toBe("/chat/night-shift");
    expect(destination.searchParams.get("autojoin")).toBe("1");
    expect(destination.searchParams.get("i")).toBe("private-capability");
  });

  test.each([
    "See https://cordn.example/chat/group later",
    "https://cordn.example/chat/group trailing",
    "not-an-invite",
    "",
  ])("Scenario: non-invite-only message content remains plain text (%s)", (content) => {
    expect(parseInviteMessage(content)).toBeNull();
  });

  test("Scenario: a public Cordn invite never advertises the browser-only local relay", () => {
    const url = new URL(createInviteUrl("http://localhost:5173", {
      groupId: "portable-room",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: [
        "ws://localhost:4870",
        "ws://relay.insecure.example",
        "wss://relay.contextvm.org",
      ],
      title: "Portable room",
    }));
    const coordinator = nip19.decode(url.searchParams.get("c")!);

    expect(coordinator.type).toBe("nprofile");
    if (coordinator.type !== "nprofile") throw new Error("Expected nprofile coordinator");
    expect(coordinator.data.relays).toEqual(["wss://relay.contextvm.org"]);
    expect(parseInviteUrl(url.toString())?.relayUrls).toEqual(["wss://relay.contextvm.org"]);
  });

  test("Scenario: a canonical Cordn link from another web host retains its room name and target", () => {
    const coordinatorPubkey = "b".repeat(64);
    const metadata = Buffer.from(JSON.stringify({ name: "Across the web", icon: "https://example.com/icon.png" }))
      .toString("base64url");
    const coordinator = nip19.nprofileEncode({
      pubkey: coordinatorPubkey,
      relays: ["wss://relay.contextvm.org"],
    });

    expect(parseInviteUrl(
      `https://some-cordn-host.example/chat/foreign-room/?c=${coordinator}&m=${metadata}`,
    )).toEqual({
      groupId: "foreign-room",
      coordinatorPubkey,
      relayUrls: ["wss://relay.contextvm.org"],
      title: "Across the web",
      coordinatorOrigin: "https://some-cordn-host.example",
    });
  });

  test.each([
    ["raw hex", "c".repeat(64)],
    ["npub", nip19.npubEncode("c".repeat(64))],
  ])("Scenario: a canonical Cordn link accepts a %s coordinator", (_label, coordinator) => {
    expect(parseInviteUrl(`https://cordn.example/chat/portable?c=${coordinator}`)).toMatchObject({
      groupId: "portable",
      coordinatorPubkey: "c".repeat(64),
      relayUrls: [],
    });
  });

  test("Scenario: a short canonical Cordn link targets the public default coordinator", () => {
    expect(parseInviteUrl("https://cordn.net/chat/public-room")).toMatchObject({
      groupId: "public-room",
      coordinatorPubkey: CORDN_DEFAULT_COORDINATOR_PUBKEY,
      relayUrls: [],
    });
  });

  test("Scenario: damaged cosmetic metadata does not invalidate a Cordn invite", () => {
    const coordinator = nip19.nprofileEncode({ pubkey: "d".repeat(64), relays: [] });
    expect(parseInviteUrl(`https://cordn.example/chat/still-valid?c=${coordinator}&m=%%%`)).toMatchObject({
      groupId: "still-valid",
      coordinatorPubkey: "d".repeat(64),
      title: undefined,
    });
  });

  test("Scenario: a guest follows a copied link and learns the exact coordinator and relay", () => {
    const url = createInviteUrl("http://localhost:4173/", {
      groupId: "group-α",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: ["wss://one.example", "wss://two.example"],
      title: "Friday plans",
      coordinatorOrigin: "https://ADHOC.example:443/coordinator/path",
      host: {
        name: "Ada",
        pubkey: "f".repeat(64),
        avatar: "https://images.example/ada.png",
      },
      coordinatorKeyMode: "ephemeral",
    });

    expect(new URL(url).origin).toBe("http://localhost:4173");

    expect(parseInviteUrl(url)).toEqual({
      groupId: "group-α",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: ["wss://one.example", "wss://two.example"],
      title: "Friday plans",
      coordinatorOrigin: "https://adhoc.example",
      host: {
        name: "Ada",
        pubkey: "f".repeat(64),
        avatar: "https://images.example/ada.png",
      },
      coordinatorKeyMode: "ephemeral",
    });
  });

  test("Scenario: invalid coordinator key lifecycle metadata is ignored", () => {
    const url = new URL(createInviteUrl("https://adhoc.example", {
      groupId: "lifecycle-room",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: [],
      coordinatorKeyMode: "persistent",
    }));
    const metadata = JSON.parse(Buffer.from(url.searchParams.get("m")!, "base64url").toString("utf8")) as Record<string, unknown>;
    metadata.coordinatorKeyMode = "sometimes";
    url.searchParams.set("m", Buffer.from(JSON.stringify(metadata)).toString("base64url"));

    expect(parseInviteUrl(url.toString())).toEqual({
      groupId: "lifecycle-room",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: [],
      title: "Chat",
      coordinatorOrigin: "https://adhoc.example",
    });
  });

  test("Scenario: a malformed invite never silently routes a guest to another coordinator", () => {
    expect(parseInviteUrl("https://adhoc.example/chat/group-1?c=not-a-profile")).toBeNull();
  });

  test("Scenario: an older invite without coordinator metadata uses the link origin", () => {
    const url = new URL(createInviteUrl("https://legacy.example:443", {
      groupId: "legacy-room",
      coordinatorPubkey: "c".repeat(64),
      relayUrls: ["wss://relay.example"],
      title: "Legacy room",
    }));
    url.searchParams.set("m", Buffer.from(JSON.stringify({ title: "Legacy room" })).toString("base64url"));

    expect(parseInviteUrl(url.toString())).toMatchObject({
      coordinatorOrigin: "https://legacy.example",
    });
    expect(parseInviteUrl(url.toString())?.host).toBeUndefined();
  });

  test.each([
    "data:image/svg+xml;base64,PHN2Zy8+",
    "blob:https://adhoc.example/avatar",
    `https://images.example/${"x".repeat(2_100)}`,
  ])("Scenario: unsafe avatar metadata is never embedded in an invite (%s)", (avatar) => {
    const url = createInviteUrl("https://adhoc.example", {
      groupId: "safe-avatar-room",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: [],
      host: {
        name: "Ada",
        pubkey: "b".repeat(64),
        avatar,
      },
    });

    expect(parseInviteUrl(url)?.host).toEqual({
      name: "Ada",
      pubkey: "b".repeat(64),
    });
    expect(decodeMetadata(url)).not.toContain(avatar);
  });

  test("Scenario: malformed optional host metadata does not invalidate an otherwise valid invite", () => {
    const url = new URL(createInviteUrl("https://adhoc.example", {
      groupId: "old-room",
      coordinatorPubkey: "c".repeat(64),
      relayUrls: [],
      title: "Old room",
    }));
    url.searchParams.set("m", Buffer.from(JSON.stringify({
      title: "Old room",
      coordinatorOrigin: "https://adhoc.example",
      host: { name: "Ada", pubkey: "not-a-pubkey" },
    })).toString("base64url"));

    expect(parseInviteUrl(url.toString())).toEqual({
      groupId: "old-room",
      coordinatorPubkey: "c".repeat(64),
      relayUrls: [],
      title: "Old room",
      coordinatorOrigin: "https://adhoc.example",
    });
  });

  test("Scenario: a malformed avatar is ignored while valid host identity remains", () => {
    const url = new URL(createInviteUrl("https://adhoc.example", {
      groupId: "safe-room",
      coordinatorPubkey: "c".repeat(64),
      relayUrls: [],
    }));
    url.searchParams.set("m", Buffer.from(JSON.stringify({
      title: "Safe room",
      coordinatorOrigin: "https://adhoc.example",
      host: { name: "Ada", pubkey: "d".repeat(64), avatar: "javascript:alert(1)" },
    })).toString("base64url"));

    expect(parseInviteUrl(url.toString())?.host).toEqual({
      name: "Ada",
      pubkey: "d".repeat(64),
    });
  });

  test("Scenario: invite origins reject non-web protocols", () => {
    expect(() => createInviteUrl("file:///tmp/shell", {
      groupId: "group-1",
      coordinatorPubkey: "d".repeat(64),
      relayUrls: [],
    })).toThrow(/http or https/);

    expect(() => createInviteUrl("https://shell.example", {
      groupId: "group-1",
      coordinatorPubkey: "d".repeat(64),
      relayUrls: [],
      coordinatorOrigin: "ws://coordinator.example",
    })).toThrow(/http or https/);
  });

  test("Scenario: a rotated invite carries its admission capability through the URL", () => {
    const url = createInviteUrl("https://adhoc.example", {
      groupId: "group-1",
      coordinatorPubkey: "b".repeat(64),
      relayUrls: ["wss://relay.example"],
      title: "Rotated room",
      inviteToken: "fresh-capability",
    });

    expect(new URL(url).searchParams.get("i")).toBe("fresh-capability");
    expect(parseInviteUrl(url)?.inviteToken).toBe("fresh-capability");
  });
});

function decodeMetadata(inviteUrl: string): string {
  const encoded = new URL(inviteUrl).searchParams.get("m");
  if (!encoded) throw new Error("Invite metadata is missing");
  return Buffer.from(encoded, "base64url").toString("utf8");
}
