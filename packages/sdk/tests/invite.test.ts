import { nip19 } from "nostr-tools";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CORDN_DEFAULT_COORDINATOR_PUBKEY,
  CORDN_DEFAULT_RELAY_URLS,
  createInviteUrl,
  normalizeRoomHostIdentity,
  parseInviteMessage,
  parseInviteUrl,
  type ChatInvite,
} from "../src/client/invite.js";

const COORDINATOR = "ab".repeat(32);
const HOST_PK = "cd".repeat(32);
const ORIGIN = "https://app.example";

const baseInvite: ChatInvite = {
  groupId: "group",
  coordinatorPubkey: COORDINATOR,
  relayUrls: ["wss://relay.example"],
  title: "Room",
};

function encodeMeta(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function urlWith(params: Record<string, string>, path = "/chat/group"): string {
  return `${ORIGIN}${path}?${new URLSearchParams(params)}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeRoomHostIdentity", () => {
  test.each<[string, unknown]>([
    ["null", null],
    ["a string", "host"],
    ["a number", 7],
    ["no name", { pubkey: HOST_PK }],
    ["a blank name", { name: "   ", pubkey: HOST_PK }],
    ["a non-string name", { name: 7, pubkey: HOST_PK }],
    ["an overlong name", { name: "x".repeat(97), pubkey: HOST_PK }],
    ["no pubkey", { name: "Ada" }],
    ["a non-string pubkey", { name: "Ada", pubkey: 1 }],
    ["a short pubkey", { name: "Ada", pubkey: "abcd" }],
    ["a non-hex pubkey", { name: "Ada", pubkey: "zz".repeat(32) }],
  ])("drops %s", (_label, value) => {
    expect(normalizeRoomHostIdentity(value)).toBeUndefined();
  });

  test("trims fields and keeps the longest allowed name", () => {
    expect(normalizeRoomHostIdentity({ name: `  ${"x".repeat(96)} `, pubkey: ` ${HOST_PK} ` }))
      .toEqual({ name: "x".repeat(96), pubkey: HOST_PK });
  });

  test("copies only the known fields", () => {
    expect(normalizeRoomHostIdentity({ name: "Ada", pubkey: HOST_PK, nsec: "leak", role: "admin" }))
      .toEqual({ name: "Ada", pubkey: HOST_PK });
  });

  test.each([
    ["http", "http://images.example/a.png"],
    ["https", "https://images.example/a.png"],
  ])("keeps a share-safe %s avatar", (_label, avatar) => {
    expect(normalizeRoomHostIdentity({ name: "Ada", pubkey: HOST_PK, avatar })?.avatar).toBe(avatar);
  });

  test.each<[string, unknown]>([
    ["javascript", "javascript:alert(1)"],
    ["data", "data:image/png;base64,AAAA"],
    ["a local blob", "blob:https://app.example/1"],
    ["embedded username", "https://user@images.example/a.png"],
    ["embedded password", "https://user:secret@images.example/a.png"],
    ["unparseable", "not a url"],
    ["blank", "   "],
    ["overlong", `https://images.example/${"a".repeat(2_048)}`],
    ["non-string", 5],
  ])("removes an unsafe avatar (%s) but keeps the host", (_label, avatar) => {
    expect(normalizeRoomHostIdentity({ name: "Ada", pubkey: HOST_PK, avatar })).toEqual({ name: "Ada", pubkey: HOST_PK });
  });
});

describe("createInviteUrl", () => {
  test("builds the canonical Cordn shape", () => {
    const url = new URL(createInviteUrl(ORIGIN, baseInvite));

    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/chat/group");
    expect([...url.searchParams.keys()]).toEqual(["c", "m"]);
    const decoded = nip19.decode(url.searchParams.get("c")!);
    expect(decoded).toEqual({ type: "nprofile", data: { pubkey: COORDINATOR, relays: ["wss://relay.example"] } });
  });

  test("uses only the origin of the shell URL", () => {
    expect(createInviteUrl(`${ORIGIN}/some/path?x=1`, baseInvite).startsWith(`${ORIGIN}/chat/group?`)).toBe(true);
  });

  test.each(["ftp://app.example", "javascript:alert(1)", "not a url"])("refuses shell origin %s", (origin) => {
    expect(() => createInviteUrl(origin, baseInvite)).toThrow(TypeError);
  });

  test("refuses a non-http coordinator origin", () => {
    expect(() => createInviteUrl(ORIGIN, { ...baseInvite, coordinatorOrigin: "ftp://x.example" }))
      .toThrow("Chat invite origins must use http or https");
  });

  test("never advertises the browser-only local relay or unusable relays", () => {
    const url = new URL(createInviteUrl(ORIGIN, {
      ...baseInvite,
      relayUrls: ["ws://localhost:4870", "wss://localhost:1", "ws://relay.plain", "wss://relay.example"],
    }));
    const decoded = nip19.decode(url.searchParams.get("c")!);
    expect(decoded).toMatchObject({ data: { relays: ["wss://relay.example"] } });
  });

  test("falls back to a default room name, and trims a provided one", () => {
    expect(parseInviteUrl(createInviteUrl(ORIGIN, { ...baseInvite, title: undefined }))?.title).toBe("Chat");
    expect(parseInviteUrl(createInviteUrl(ORIGIN, { ...baseInvite, title: "   " }))?.title).toBe("Chat");
    expect(parseInviteUrl(createInviteUrl(ORIGIN, { ...baseInvite, title: " Room " }))?.title).toBe("Room");
  });

  test("the metadata stores the room label under `name` for canonical clients", () => {
    const url = new URL(createInviteUrl(ORIGIN, baseInvite));
    const raw = url.searchParams.get("m")!.replace(/-/g, "+").replace(/_/g, "/");
    expect(JSON.parse(atob(raw))).toEqual({ name: "Room", coordinatorOrigin: ORIGIN });
  });

  test("omits invalid optional presentation data from the link", () => {
    const url = createInviteUrl(ORIGIN, {
      ...baseInvite,
      coordinatorName: "   ",
      host: { name: "", pubkey: "nope" },
      coordinatorKeyMode: "forever" as never,
    });
    const parsed = parseInviteUrl(url)!;

    expect(parsed).not.toHaveProperty("coordinatorName");
    expect(parsed).not.toHaveProperty("host");
    expect(parsed).not.toHaveProperty("coordinatorKeyMode");
    expect(parsed).not.toHaveProperty("inviteToken");
  });

  test("round trips everything, including non-ASCII text and awkward group ids", () => {
    const invite: ChatInvite = {
      groupId: "group/α b",
      coordinatorPubkey: COORDINATOR,
      relayUrls: ["wss://relay.example"],
      title: "Night shift 🌙",
      coordinatorOrigin: "https://coord.example",
      coordinatorName: "Madeira node",
      inviteToken: "secret token+1",
      host: { name: "Märä", pubkey: HOST_PK, avatar: "https://images.example/a.png" },
      coordinatorKeyMode: "persistent",
    };
    const url = createInviteUrl(ORIGIN, invite);

    expect(parseInviteUrl(url)).toEqual(invite);
    expect(new URL(url).searchParams.get("m")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("accepts the ephemeral key mode", () => {
    expect(parseInviteUrl(createInviteUrl(ORIGIN, { ...baseInvite, coordinatorKeyMode: "ephemeral" }))?.coordinatorKeyMode).toBe("ephemeral");
  });
});

describe("parseInviteUrl", () => {
  test("rejects unparseable input", () => {
    vi.stubGlobal("location", undefined);
    expect(parseInviteUrl("not a url")).toBeNull();
  });

  test("resolves a path against the current origin in a browser", () => {
    vi.stubGlobal("location", { origin: ORIGIN });
    expect(parseInviteUrl("/chat/group")).toMatchObject({ groupId: "group", coordinatorOrigin: ORIGIN });
  });

  test("cannot resolve a path outside a browser", () => {
    vi.stubGlobal("location", undefined);
    expect(parseInviteUrl("/chat/group")).toBeNull();
  });

  test.each([
    ["other path", `${ORIGIN}/room/group`],
    ["nested path", `${ORIGIN}/chat/group/extra`],
    ["missing group", `${ORIGIN}/chat/`],
    ["blank group", `${ORIGIN}/chat/%20`],
    ["broken percent-encoding", `${ORIGIN}/chat/%E0%A4%A`],
    ["ftp shell", "ftp://app.example/chat/group"],
    ["file shell", "file:///chat/group"],
    ["javascript", "javascript:/chat/group"],
  ])("rejects %s", (_label, value) => {
    expect(parseInviteUrl(value)).toBeNull();
  });

  test("tolerates a trailing slash and surrounding whitespace", () => {
    expect(parseInviteUrl(`  ${ORIGIN}/chat/group/ `)?.groupId).toBe("group");
  });

  test("a link without a coordinator means the default Cordn coordinator", () => {
    const expected = { coordinatorPubkey: CORDN_DEFAULT_COORDINATOR_PUBKEY, relayUrls: [] };
    expect(parseInviteUrl(urlWith({}))).toMatchObject(expected);
    expect(parseInviteUrl(urlWith({ c: "   " }))).toMatchObject(expected);
    expect(CORDN_DEFAULT_RELAY_URLS.length).toBeGreaterThan(0);
  });

  describe("coordinator parameter", () => {
    test("accepts hex and lowercases it", () => {
      expect(parseInviteUrl(urlWith({ c: COORDINATOR.toUpperCase() }))).toMatchObject({ coordinatorPubkey: COORDINATOR, relayUrls: [] });
    });

    test("accepts an npub", () => {
      expect(parseInviteUrl(urlWith({ c: nip19.npubEncode(COORDINATOR) }))).toMatchObject({ coordinatorPubkey: COORDINATOR, relayUrls: [] });
    });

    test("accepts an nprofile without relay hints", () => {
      const c = nip19.nprofileEncode({ pubkey: COORDINATOR });
      expect(parseInviteUrl(urlWith({ c }))).toMatchObject({ coordinatorPubkey: COORDINATOR, relayUrls: [] });
    });

    test("keeps only usable, unique relay hints from an nprofile", () => {
      const c = nip19.nprofileEncode({
        pubkey: COORDINATOR,
        relays: ["wss://a.example", " wss://a.example ", "ws://b.example", "https://c.example", "not a url"],
      });
      expect(parseInviteUrl(urlWith({ c }))?.relayUrls).toEqual(["wss://a.example", "ws://b.example"]);
    });

    test.each([
      ["garbage", "npub1notreal"],
      ["short hex", "abcd"],
      ["an nsec, which must never be treated as a coordinator", nip19.nsecEncode(new Uint8Array(32).fill(7))],
      ["an naddr", nip19.naddrEncode({ identifier: "x", pubkey: COORDINATOR, kind: 30_000 })],
      ["an note", nip19.noteEncode(COORDINATOR)],
    ])("a present but invalid value never falls back to another host: %s", (_label, c) => {
      expect(parseInviteUrl(urlWith({ c }))).toBeNull();
    });
  });

  describe("metadata", () => {
    const meta = (value: unknown) => parseInviteUrl(urlWith({ c: COORDINATOR, m: encodeMeta(value) }));

    test.each<[string, string]>([
      ["blank", "   "],
      ["not base64", "%%%%"],
      ["not JSON", btoa("not json")],
      ["JSON null", encodeMeta(null)],
      ["a JSON number", encodeMeta(5)],
      ["a JSON array", encodeMeta(["x"])],
    ])("damaged cosmetic metadata does not sink the invite: %s", (_label, m) => {
      const parsed = parseInviteUrl(urlWith({ c: COORDINATOR, m }));
      expect(parsed).toMatchObject({ groupId: "group", coordinatorPubkey: COORDINATOR, coordinatorOrigin: ORIGIN });
      expect(parsed?.title).toBeUndefined();
    });

    test("prefers the legacy title field, then name", () => {
      expect(meta({ title: " Old ", name: "New" })?.title).toBe("Old");
      expect(meta({ name: " New " })?.title).toBe("New");
    });

    test("ignores blank or non-string titles", () => {
      expect(meta({ name: "   " })?.title).toBeUndefined();
      expect(meta({ name: 5 })?.title).toBeUndefined();
      expect(meta({ title: 5, name: "Fallback" })?.title).toBe("Fallback");
    });

    test("normalizes a coordinator origin down to its origin", () => {
      expect(meta({ coordinatorOrigin: "https://coord.example/some/path" })?.coordinatorOrigin).toBe("https://coord.example");
    });

    test.each<[string, unknown]>([
      ["a non-http scheme", "javascript:alert(1)"],
      ["an unparseable value", "not a url"],
      ["a number", 5],
      ["null", null],
    ])("a coordinator origin of %s rejects the whole invite", (_label, coordinatorOrigin) => {
      expect(meta({ coordinatorOrigin })).toBeNull();
    });

    test("drops invalid host, key mode and coordinator name without rejecting", () => {
      const parsed = meta({
        name: "Room",
        host: { name: "Ada", pubkey: "short" },
        coordinatorKeyMode: "other",
        coordinatorName: 5,
      });
      expect(parsed?.title).toBe("Room");
      expect(parsed).not.toHaveProperty("host");
      expect(parsed).not.toHaveProperty("coordinatorKeyMode");
      expect(parsed).not.toHaveProperty("coordinatorName");
    });

    test("measures the coordinator name in characters, not UTF-16 units", () => {
      expect(meta({ coordinatorName: "🌙".repeat(96) })?.coordinatorName).toBe("🌙".repeat(96));
      expect(meta({ coordinatorName: "🌙".repeat(97) })).not.toHaveProperty("coordinatorName");
      expect(meta({ coordinatorName: "  " })).not.toHaveProperty("coordinatorName");
    });
  });

  test("trims the invite token and drops a blank one", () => {
    expect(parseInviteUrl(urlWith({ c: COORDINATOR, i: " token " }))?.inviteToken).toBe("token");
    expect(parseInviteUrl(urlWith({ c: COORDINATOR, i: "   " }))).not.toHaveProperty("inviteToken");
  });

  test("trims the group id after decoding", () => {
    expect(parseInviteUrl(`${ORIGIN}/chat/%20group%20`)?.groupId).toBe("group");
  });
});

describe("parseInviteMessage", () => {
  const link = createInviteUrl(ORIGIN, baseInvite);

  test("recognizes a message that is entirely one invite link", () => {
    expect(parseInviteMessage(`\n  ${link}  \n`)).toMatchObject({ groupId: "group", title: "Room" });
  });

  test.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["text around the link", `join ${link}`],
    ["two links", `${link} ${link}`],
    ["a non-invite URL", `${ORIGIN}/elsewhere`],
    ["plain words", "hello"],
  ])("leaves %s as plain text", (_label, value) => {
    expect(parseInviteMessage(value)).toBeNull();
  });

  test.each(["/chat/hello", "chat/hello", "/chat/hello?i=x"])(
    "ordinary text that merely resolves against the page origin is not an invite: %s",
    (value) => {
      // jsdom supplies location.origin, as a real browser would. Treating this
      // text as an invite would render a join card for the default coordinator.
      expect(location.origin).toBeTruthy();
      expect(parseInviteMessage(value)).toBeNull();
    },
  );
});
