import { expect, type Page } from "./established-installation-fixture";
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, type Event as NostrEvent } from "nostr-tools";

interface TestNip07Identity {
  secretKey: Uint8Array;
  pubkey: string;
}

export interface ControllableNip07 {
  pubkey: string;
  rejectNextSignature: () => void;
  replaceIdentity: () => string;
  signedContactList: (targets: string[]) => NostrEvent;
}

/** Relay test output deliberately excludes URLs, request ids, and event material. */
export interface SocialRelaySubscriptionSnapshot {
  state: "open" | "closed";
  kinds: number[];
  authors: string[];
}

/** A page-lifetime NIP-07 bridge. Generated key material never enters the page's DOM or storage. */
export async function installControllableNip07(page: Page): Promise<ControllableNip07> {
  const secretKey = generateSecretKey();
  let identity: TestNip07Identity = { secretKey, pubkey: getPublicKey(secretKey) };
  let rejectNextSignature = false;
  await page.exposeFunction("__phase24Nip07Bridge", (operation: string, peerOrEvent: unknown, plaintext?: string) => {
    if (operation === "getPublicKey") return identity.pubkey;
    if (operation === "sign") {
      if (rejectNextSignature) {
        rejectNextSignature = false;
        throw new Error("Test signer rejected this envelope");
      }
      return finalizeEvent(peerOrEvent as Parameters<typeof finalizeEvent>[0], identity.secretKey);
    }
    const peer = String(peerOrEvent);
    const key = nip44.v2.utils.getConversationKey(identity.secretKey, peer);
    if (operation === "encrypt") return nip44.v2.encrypt(String(plaintext), key);
    if (operation === "decrypt") return nip44.v2.decrypt(String(plaintext), key);
    throw new Error("Unsupported NIP-07 bridge operation");
  });
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __phase24Nip07Bridge?: (operation: string, peerOrEvent: unknown, plaintext?: string) => Promise<unknown>;
    };
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        getPublicKey: async () => testWindow.__phase24Nip07Bridge?.("getPublicKey", ""),
        signEvent: async (event: unknown) => testWindow.__phase24Nip07Bridge?.("sign", event),
        nip44: {
          encrypt: async (peer: string, plaintext: string) => testWindow.__phase24Nip07Bridge?.("encrypt", peer, plaintext),
          decrypt: async (peer: string, ciphertext: string) => testWindow.__phase24Nip07Bridge?.("decrypt", peer, ciphertext),
        },
      },
    });
  });
  return {
    get pubkey() { return identity.pubkey; },
    rejectNextSignature: () => { rejectNextSignature = true; },
    replaceIdentity: () => {
      const nextSecret = generateSecretKey();
      identity = { secretKey: nextSecret, pubkey: getPublicKey(nextSecret) };
      return identity.pubkey;
    },
    signedContactList: (targets) => finalizeEvent({
      kind: 3,
      created_at: Math.floor(Date.now() / 1_000),
      tags: targets.map((target) => ["p", target]),
      content: "",
    }, identity.secretKey),
  };
}

/** Routes only the public profile relays and leaves coordinator transport untouched. */
export async function installSocialRelayControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __phase24SocialSockets?: Array<{
        closed: boolean;
        requests: Array<{
          id: string;
          closed: boolean;
          filters: Array<{ authors?: string[]; kinds?: number[] }>;
        }>;
        onmessage: ((event: MessageEvent<string>) => void) | null;
      }>;
      __phase24SocialEmit?: (event: unknown) => void;
      __phase24NativeWebSocket?: typeof WebSocket;
    };
    testWindow.__phase24NativeWebSocket = window.WebSocket;
    testWindow.__phase24SocialSockets = [];
    const matches = (event: { kind?: number; pubkey?: string }, filter: { authors?: string[]; kinds?: number[] }) =>
      (!filter.kinds || filter.kinds.includes(event.kind ?? -1))
      && (!filter.authors || filter.authors.includes(event.pubkey ?? ""));

    class ProfileRelayWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = ProfileRelayWebSocket.CONNECTING;
      readonly OPEN = ProfileRelayWebSocket.OPEN;
      readonly CLOSING = ProfileRelayWebSocket.CLOSING;
      readonly CLOSED = ProfileRelayWebSocket.CLOSED;
      readyState = ProfileRelayWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      readonly record = {
        closed: false,
        requests: [] as Array<{
          id: string;
          closed: boolean;
          filters: Array<{ authors?: string[]; kinds?: number[] }>;
        }>,
        onmessage: null as ((event: MessageEvent<string>) => void) | null,
      };
      constructor(_url: string) {
        void _url;
        testWindow.__phase24SocialSockets?.push(this.record);
        queueMicrotask(() => { this.readyState = ProfileRelayWebSocket.OPEN; this.onopen?.(new Event("open")); });
      }
      send(payload: string): void {
        const message = JSON.parse(payload) as unknown[];
        if (typeof message[1] !== "string") return;
        const id = message[1];
        if (message[0] === "CLOSE") {
          for (const request of this.record.requests) {
            if (request.id === id) request.closed = true;
          }
          return;
        }
        if (message[0] !== "REQ") return;
        const filters = message.slice(2).filter((value): value is { authors?: string[]; kinds?: number[] } => typeof value === "object" && value !== null);
        this.record.requests.push({ id, closed: false, filters });
        this.record.onmessage = this.onmessage;
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(["EOSE", id]) } as MessageEvent<string>));
      }
      close(): void {
        this.record.closed = true;
        for (const request of this.record.requests) request.closed = true;
        this.readyState = ProfileRelayWebSocket.CLOSED;
        this.onclose?.({} as CloseEvent);
      }
    }
    testWindow.__phase24SocialEmit = (event) => {
      for (const socket of testWindow.__phase24SocialSockets ?? []) {
        for (const request of socket.requests) {
          if (request.filters.some((filter) => matches(event as { kind?: number; pubkey?: string }, filter))) {
            socket.onmessage?.({ data: JSON.stringify(["EVENT", request.id, event]) } as MessageEvent<string>);
          }
        }
      }
    };
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: new Proxy(testWindow.__phase24NativeWebSocket, {
        construct(Target, args) {
          const url = String(args[0] ?? "");
          if (url.startsWith("wss://purplepag.es") || url.startsWith("wss://relay.damus.io")) return new ProfileRelayWebSocket(url);
          return Reflect.construct(Target, args);
        },
      }),
    });
  });
}

/** Route configured public relays to a local test relay without changing invite hints. */
export async function installMockPublicRelayRoute(page: Page, relayUrl: string): Promise<void> {
  await page.addInitScript((mockRelayUrl) => {
    const testWindow = window as typeof window & { __phase24NativePublicRelayWebSocket?: typeof WebSocket };
    testWindow.__phase24NativePublicRelayWebSocket ??= window.WebSocket;
    const publicRelayHosts = new Set([
      "wss://relay2.contextvm.org",
      "wss://bucket.coracle.social",
      "wss://nos.lol",
    ]);
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: new Proxy(testWindow.__phase24NativePublicRelayWebSocket, {
        construct(Target, args) {
          const url = String(args[0] ?? "");
          return Reflect.construct(Target, publicRelayHosts.has(url) ? [mockRelayUrl, ...args.slice(1)] : args);
        },
      }),
    });
  }, relayUrl);
}

export async function emitSocialContactEvent(page: Page, event: NostrEvent): Promise<void> {
  await page.evaluate((signed) => {
    (window as typeof window & { __phase24SocialEmit?: (event: unknown) => void }).__phase24SocialEmit?.(signed);
  }, event);
}

/**
 * Return one sanitized entry for every REQ. The request id and relay remain
 * private, but keeping their ledger entries separate prevents duplicate live
 * subscriptions from being hidden by a matching filter.
 */
export async function socialRelaySubscriptions(page: Page): Promise<SocialRelaySubscriptionSnapshot[]> {
  return page.evaluate(() => {
    type RelayRecord = {
      closed: boolean;
      requests: Array<{
        closed: boolean;
        filters: Array<{ authors?: string[]; kinds?: number[] }>;
      }>;
    };
    const testWindow = window as typeof window & { __phase24SocialSockets?: RelayRecord[] };
    return (testWindow.__phase24SocialSockets ?? []).flatMap((socket) => socket.requests.map((request) => ({
      state: socket.closed || request.closed ? "closed" as const : "open" as const,
      kinds: [...new Set(request.filters.flatMap((filter) => filter.kinds ?? []))].sort((left, right) => left - right),
      authors: [...new Set(request.filters.flatMap((filter) => filter.authors ?? []))].sort(),
    })));
  });
}

interface StoredMessageView {
  id: string;
  recipientPubkeys?: string[];
  auth?: unknown;
  content?: string;
}

interface StoredRoomView {
  id: string;
  coordinatorPubkey: string;
  stablePubkey: string;
  messages: StoredMessageView[];
}

/**
 * Keep browser-only inspection on the recipient side.  Tests deliberately
 * never inspect a relay event's ciphertext as if it were decrypted content.
 */
export async function storedRoom(page: Page, title: string): Promise<StoredRoomView | null> {
  return page.evaluate((expectedTitle) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      try {
        const room = JSON.parse(localStorage.getItem(key) ?? "null") as (StoredRoomView & { title?: string }) | null;
        if (room?.title === expectedTitle) return room;
      } catch {
        // A malformed unrelated entry must not make the browser helper fail.
      }
    }
    return null;
  }, title);
}

export async function waitForStoredMessage(
  page: Page,
  roomTitle: string,
  predicate: (message: StoredMessageView) => boolean,
): Promise<StoredMessageView> {
  await expect.poll(async () => ((await storedRoom(page, roomTitle))?.messages ?? []).some(predicate), {
    timeout: 20_000,
  }).toBe(true);
  const room = await storedRoom(page, roomTitle);
  const message = room?.messages.find(predicate);
  if (!message) throw new Error("Expected recipient-side message was not persisted");
  return message;
}

export async function roomIdentity(page: Page, title: string): Promise<Pick<StoredRoomView, "id" | "coordinatorPubkey" | "stablePubkey">> {
  await expect.poll(async () => await storedRoom(page, title), { timeout: 20_000 }).not.toBeNull();
  const room = await storedRoom(page, title);
  if (!room) throw new Error("Expected room was not persisted");
  return { id: room.id, coordinatorPubkey: room.coordinatorPubkey, stablePubkey: room.stablePubkey };
}
