import { expect, test, type Locator, type Page } from "./established-installation-fixture";
import type { NostrPool } from "applesauce-signers";
import { NostrConnectProvider, PrivateKeySigner } from "applesauce-signers/signers";
import { SimplePool, type Filter, type NostrEvent } from "nostr-tools";
import { Observable } from "rxjs";

import { startMockRelay, type MockRelay } from "./mock-relay";

const identityStorageKey = "cordn:v1:anonymous-identity";
const roomStoragePrefix = "cordn-adhoc-chat-room:";
const identitySummaryPattern = /^[0-9a-f]{8}…[0-9a-f]{6}$/;

interface BrowserIdentityProbe {
  identitySurfaceObserved: boolean;
  observer?: MutationObserver;
}

interface TestRoom {
  coordinatorPubkey: string;
  id: string;
  title: string;
  stablePubkey: string;
  hostName: string;
}

interface NostrConnectPool {
  adapter: NostrPool;
  destroy: () => void;
}

let relay: MockRelay;

test.beforeAll(async () => {
  relay = await startMockRelay(8891);
});

test.afterAll(async () => {
  await relay.close();
});

function shortDeviceKey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
}

function storedRoom(room: TestRoom): Record<string, unknown> {
  return {
    version: 1,
    id: room.id,
    title: room.title,
    coordinatorPubkey: room.coordinatorPubkey,
    coordinatorOrigin: "https://coordinator.example.test",
    relayUrls: ["ws://127.0.0.1:1"],
    name: "Local participant",
    stablePubkey: room.stablePubkey,
    isHost: false,
    stateBase64: "",
    keyPackage: { reference: "", publicBase64: "", privateBase64: "" },
    lastCursor: 0,
    messages: [],
    pending: [],
    host: { name: room.hostName, pubkey: room.stablePubkey },
    joinRequestSent: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

async function openProfileMenu(page: Page): Promise<Locator> {
  const profile = page.getByTestId("user-profile");
  const menu = page.getByRole("dialog", { name: "User profile" });
  if (await menu.isVisible()) return menu;
  const trigger = profile.getByRole("button", { name: /^Open profile for / });
  const roomBrowser = page.getByRole("button", { name: "Open room browser" });
  if (await roomBrowser.isVisible() && await roomBrowser.getAttribute("aria-expanded") === "false") {
    await roomBrowser.click();
  }
  if (!(await trigger.isVisible())) {
    const toolsTrigger = page.getByRole("button", { name: "Open host tools" });
    if (await toolsTrigger.isVisible()) {
      await toolsTrigger.click();
    } else {
      if (await roomBrowser.isVisible()) await roomBrowser.click();
    }
  }
  await trigger.click();
  await expect(menu).toBeVisible();
  return menu;
}

function identitySummary(menu: Locator): Locator {
  return menu.getByText(identitySummaryPattern, { exact: true });
}

async function closeProfileMenu(page: Page, menu: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      insideViewport: bounds.left >= -1 && bounds.right <= window.innerWidth + 1,
      ownContentFits: element.scrollWidth <= element.clientWidth + 1,
    };
  })).toEqual({
    insideViewport: true,
    ownContentFits: true,
  });
}

async function installFastProfileRelays(page: Page, nip07Pubkey?: string): Promise<void> {
  await page.addInitScript(({ extensionPubkey }) => {
    const testWindow = window as typeof window & {
      __nativeWebSocket?: typeof WebSocket;
    };
    testWindow.__nativeWebSocket = window.WebSocket;

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

      constructor(url: string) {
        void url;
        queueMicrotask(() => {
          this.readyState = ProfileRelayWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(payload: string): void {
        const message = JSON.parse(payload) as unknown;
        if (!Array.isArray(message) || message[0] !== "REQ" || typeof message[1] !== "string") return;
        const subscriptionId = message[1];
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify(["EOSE", subscriptionId]) } as MessageEvent<string>);
        });
      }

      close(): void {
        if (this.readyState === ProfileRelayWebSocket.CLOSED) return;
        this.readyState = ProfileRelayWebSocket.CLOSED;
        this.onclose?.({ message: "" } as unknown as CloseEvent);
      }
    }

    const RoutedWebSocket = new Proxy(testWindow.__nativeWebSocket, {
      construct(Target, args) {
        const target = String(args[0] ?? "");
        if (target.startsWith("wss://purplepag.es") || target.startsWith("wss://relay.damus.io")) {
          return new ProfileRelayWebSocket(target);
        }
        return Reflect.construct(Target, args);
      },
    });

    Object.defineProperty(window, "WebSocket", { configurable: true, value: RoutedWebSocket });
    if (extensionPubkey) {
      Object.defineProperty(window, "nostr", {
        configurable: true,
        value: {
          getPublicKey: async () => extensionPubkey,
          signEvent: async (event: unknown) => event,
          nip44: {
            encrypt: async (_pubkey: string, plaintext: string) => plaintext,
            decrypt: async (_pubkey: string, ciphertext: string) => ciphertext,
          },
        },
      });
    }
  }, { extensionPubkey: nip07Pubkey ?? "" });
}

function createNostrConnectPool(): NostrConnectPool {
  const pool = new SimplePool();
  return {
    adapter: {
      subscription: (relays, filters) => new Observable<NostrEvent>((subscriber) => {
        let closed = 0;
        const subscriptions = (filters as Filter[]).map((filter) => pool.subscribeMany(relays, filter, {
          onevent: (event) => subscriber.next(event),
          onclose: () => {
            closed += 1;
            if (closed === filters.length) subscriber.complete();
          },
        }));
        return () => subscriptions.forEach((subscription) => subscription.close());
      }),
      publish: async (relays, event) => {
        await Promise.any(pool.publish(relays, event as NostrEvent));
      },
    },
    destroy: () => pool.destroy(),
  };
}

test("requires explicit recovery without flashing or replacing a malformed local identity", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("user-profile").locator(".user-trigger")).toBeVisible();

  const malformedIdentity = JSON.stringify({ version: 1, secretKeyHex: "not-a-valid-local-identity" });
  const coordinatorPubkey = "a".repeat(64);
  const legacyRoomPubkey = "b".repeat(64);
  const legacyRoom = storedRoom({
    coordinatorPubkey,
    id: "malformed-recovery-room",
    title: "Malformed recovery room",
    stablePubkey: legacyRoomPubkey,
    hostName: "Legacy host",
  });

  await page.addInitScript(({ identityKey, malformedRaw, roomKey, roomRaw }) => {
    localStorage.setItem(identityKey, malformedRaw);
    localStorage.setItem(roomKey, JSON.stringify(roomRaw));
    const probe = window as typeof window & BrowserIdentityProbe;
    probe.identitySurfaceObserved = false;
    const captureIdentitySurface = () => {
      if (document.querySelector('[data-testid="user-profile"] .user-trigger')) {
        probe.identitySurfaceObserved = true;
      }
    };
    probe.observer = new MutationObserver(captureIdentitySurface);
    probe.observer.observe(document, { childList: true, subtree: true });
    captureIdentitySurface();
  }, {
    identityKey: identityStorageKey,
    malformedRaw: malformedIdentity,
    roomKey: `${roomStoragePrefix}malformed-recovery-room`,
    roomRaw: legacyRoom,
  });

  await page.reload();
  const recovery = page.getByTestId("identity-rotation-dialog");
  await expect(recovery.getByRole("heading", { name: "Recover local identity" })).toBeVisible();
  await expect(page.getByTestId("user-profile").locator(".user-trigger")).toHaveCount(0);
  expect(await page.evaluate(() => (
    window as typeof window & BrowserIdentityProbe
  ).identitySurfaceObserved)).toBe(false);
  expect(await page.evaluate(({ identityKey, expectedRaw }) => (
    localStorage.getItem(identityKey) === expectedRaw
  ), { identityKey: identityStorageKey, expectedRaw: malformedIdentity })).toBe(true);

  await recovery.getByRole("button", { name: "Create new identity" }).click();
  await expect(recovery).toBeHidden();
  await expect(page.getByTestId("user-profile").locator(".user-trigger")).toBeVisible();
  expect(await page.evaluate(({ identityKey, previousRaw }) => {
    const raw = localStorage.getItem(identityKey);
    try {
      const record = JSON.parse(raw ?? "null") as { version?: unknown; secretKeyHex?: unknown } | null;
      return raw !== previousRaw
        && record?.version === 1
        && typeof record.secretKeyHex === "string"
        && /^[0-9a-f]{64}$/.test(record.secretKeyHex);
    } catch {
      return false;
    }
  }, { identityKey: identityStorageKey, previousRaw: malformedIdentity })).toBe(true);

  const menu = await openProfileMenu(page);
  const summary = await identitySummary(menu).textContent();
  expect(summary).not.toBe(shortDeviceKey(coordinatorPubkey));
  expect(summary).not.toBe(shortDeviceKey(legacyRoomPubkey));
});

test("renders one room per composite identity while verified v2 and legacy aliases reconcile", async ({ page }) => {
  const coordinatorA = "a".repeat(64);
  const coordinatorB = "b".repeat(64);
  const legacyRoomPubkey = "c".repeat(64);
  const canonicalRoomPubkeyA = "d".repeat(64);
  const canonicalRoomPubkeyB = "e".repeat(64);
  const roomId = "shared-room-id";

  await page.goto("/");
  const originalMenu = await openProfileMenu(page);
  const originalIdentitySummary = await identitySummary(originalMenu).textContent();
  await closeProfileMenu(page, originalMenu);

  await page.evaluate(({ prefix, roomId, coordinatorA, coordinatorB, roomA, roomB, legacy }) => {
    localStorage.setItem(
      `${prefix}v2:${encodeURIComponent(coordinatorA)}:${encodeURIComponent(roomId)}`,
      JSON.stringify(roomA),
    );
    localStorage.setItem(
      `${prefix}v2:${encodeURIComponent(coordinatorB)}:${encodeURIComponent(roomId)}`,
      JSON.stringify(roomB),
    );
    localStorage.setItem(`${prefix}${roomId}`, JSON.stringify(legacy));
  }, {
    prefix: roomStoragePrefix,
    roomId,
    coordinatorA,
    coordinatorB,
    roomA: storedRoom({
      coordinatorPubkey: coordinatorA,
      id: roomId,
      title: "North canonical room",
      stablePubkey: canonicalRoomPubkeyA,
      hostName: "North host",
    }),
    roomB: storedRoom({
      coordinatorPubkey: coordinatorB,
      id: roomId,
      title: "South canonical room",
      stablePubkey: canonicalRoomPubkeyB,
      hostName: "South host",
    }),
    legacy: storedRoom({
      coordinatorPubkey: coordinatorA,
      id: roomId,
      title: "Legacy alias must not render",
      stablePubkey: legacyRoomPubkey,
      hostName: "Legacy host",
    }),
  });

  await page.reload();
  const restoredMenu = await openProfileMenu(page);
  const restoredIdentitySummary = await identitySummary(restoredMenu).textContent();
  expect(restoredIdentitySummary).toBe(originalIdentitySummary);
  for (const unrelatedPubkey of [coordinatorA, coordinatorB, legacyRoomPubkey, canonicalRoomPubkeyA, canonicalRoomPubkeyB]) {
    expect(restoredIdentitySummary).not.toBe(shortDeviceKey(unrelatedPubkey));
  }
  await closeProfileMenu(page, restoredMenu);

  const coordinatorALabel = `Coordinator ${coordinatorA.slice(0, 6)}…${coordinatorA.slice(-4)}`;
  const coordinatorBLabel = `Coordinator ${coordinatorB.slice(0, 6)}…${coordinatorB.slice(-4)}`;
  const coordinatorCards = page.getByTestId("coordinator-card");
  await expect(coordinatorCards.filter({ hasText: coordinatorALabel })).toHaveCount(1);
  await expect(coordinatorCards.filter({ hasText: coordinatorBLabel })).toHaveCount(1);
  await coordinatorCards.filter({ hasText: coordinatorALabel }).focus();
  await expect(page.getByRole("button", { name: /^Open room North canonical room, hosted by North host/ })).toHaveCount(1);
  await expect(page.getByText("Legacy alias must not render", { exact: true })).toHaveCount(0);
  await coordinatorCards.filter({ hasText: coordinatorBLabel }).focus();
  await expect(page.getByRole("button", { name: /^Open room South canonical room, hosted by South host/ })).toHaveCount(1);
  await expect(page.getByText("Legacy alias must not render", { exact: true })).toHaveCount(0);

  expect(await page.evaluate(({ prefix, roomId, coordinatorA, coordinatorB }) => ({
    legacyRemoved: localStorage.getItem(`${prefix}${roomId}`) === null,
    coordinatorAPresent: localStorage.getItem(`${prefix}v2:${encodeURIComponent(coordinatorA)}:${encodeURIComponent(roomId)}`) !== null,
    coordinatorBPresent: localStorage.getItem(`${prefix}v2:${encodeURIComponent(coordinatorB)}:${encodeURIComponent(roomId)}`) !== null,
  }), { prefix: roomStoragePrefix, roomId, coordinatorA, coordinatorB })).toEqual({
    legacyRemoved: true,
    coordinatorAPresent: true,
    coordinatorBPresent: true,
  });
});

test("uses preservation-safe rotation copy and contains identity presentation at desktop and narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  const assertPresentation = async () => {
    const menu = await openProfileMenu(page);
    const summary = identitySummary(menu);
    await expect(summary).toHaveText(identitySummaryPattern);
    await expectNoHorizontalOverflow(menu);
    await expectNoHorizontalOverflow(summary);

    await menu.getByRole("button", { name: "Rotate identity…" }).click();
    const dialog = page.getByTestId("identity-rotation-dialog");
    await expect(dialog.getByRole("heading", { name: "Rotate local identity?" })).toBeVisible();
    await expect(dialog).toContainText("This does not delete coordinator-hosted room data for other participants.");
    const copy = await dialog.locator(".dialog-body").innerText();
    expect(copy).not.toMatch(/cached[^.]{0,80}(delete|remove)|(delete|remove)[^.]{0,80}cached/i);
    await expectNoHorizontalOverflow(dialog);
    await expectNoHorizontalOverflow(dialog.locator(".dialog-body"));
    await dialog.getByRole("button", { name: "Keep current identity" }).click();
    await expect(dialog).toBeHidden();
    await closeProfileMenu(page, menu);
  };

  await assertPresentation();
  await page.setViewportSize({ width: 320, height: 568 });
  await assertPresentation();
});

test("keeps the NIP-07 session selected without exposing anonymous rotation", async ({ page }) => {
  const nip07Pubkey = "7".repeat(64);
  await installFastProfileRelays(page, nip07Pubkey);
  await page.goto("/");
  await page.evaluate((identityKey) => {
    (window as typeof window & { __identityBeforeAuthentication?: string | null })
      .__identityBeforeAuthentication = localStorage.getItem(identityKey);
  }, identityStorageKey);

  const anonymousMenu = await openProfileMenu(page);
  await anonymousMenu.getByRole("button", { name: /NIP-07 browser signer/ }).click();
  await expect(anonymousMenu).toBeHidden();
  await expect(page.getByTestId("user-profile")).toContainText("NIP-07");

  const authenticatedMenu = await openProfileMenu(page);
  await expect(authenticatedMenu.getByRole("button", { name: "Rotate identity…" })).toHaveCount(0);
  await expect(authenticatedMenu.getByRole("button", { name: "Disconnect" })).toBeVisible();
  expect(await page.evaluate((identityKey) => ({
    identityUnchanged: localStorage.getItem(identityKey) === (
      window as typeof window & { __identityBeforeAuthentication?: string | null }
    ).__identityBeforeAuthentication,
    nip07SessionSelected: localStorage.getItem("cordn:v1:nip07-session") === JSON.stringify({ version: 1, method: "nip07" }),
  }), identityStorageKey)).toEqual({
    identityUnchanged: true,
    nip07SessionSelected: true,
  });
});

test("keeps the NIP-46 session selected without exposing anonymous rotation", async ({ page }) => {
  await installFastProfileRelays(page);
  const connection = createNostrConnectPool();
  const provider = new NostrConnectProvider({
    relays: [relay.url],
    upstream: new PrivateKeySigner(),
    pool: connection.adapter,
  });
  await provider.start();

  try {
    const bunkerUri = await provider.getBunkerURI();
    await page.goto("/");
    await page.evaluate((identityKey) => {
      (window as typeof window & { __identityBeforeAuthentication?: string | null })
        .__identityBeforeAuthentication = localStorage.getItem(identityKey);
    }, identityStorageKey);

    const anonymousMenu = await openProfileMenu(page);
    await anonymousMenu.getByText("Use a bunker URI instead", { exact: true }).click();
    await anonymousMenu.getByLabel("NIP-46 bunker URI").fill(bunkerUri);
    await anonymousMenu.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(anonymousMenu).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("user-profile")).toContainText("NIP-46");

    const authenticatedMenu = await openProfileMenu(page);
    await expect(authenticatedMenu.getByRole("button", { name: "Rotate identity…" })).toHaveCount(0);
    await expect(authenticatedMenu.getByRole("button", { name: "Disconnect" })).toBeVisible();
    expect(provider.connected).toBe(true);
    expect(await page.evaluate((identityKey) => ({
      identityUnchanged: localStorage.getItem(identityKey) === (
        window as typeof window & { __identityBeforeAuthentication?: string | null }
      ).__identityBeforeAuthentication,
      nip07SessionAbsent: localStorage.getItem("cordn:v1:nip07-session") === null,
    }), identityStorageKey)).toEqual({
      identityUnchanged: true,
      nip07SessionAbsent: true,
    });
  } finally {
    await provider.stop();
    connection.destroy();
  }
});
