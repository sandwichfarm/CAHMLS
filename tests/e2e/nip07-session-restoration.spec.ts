import { expect, installEstablishedInstallation, test, type Locator, type Page } from "./established-installation-fixture";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from "nostr-tools";

import { startMockRelay, type MockRelay } from "./mock-relay";

const mockProfile = {
  display_name: "E2E NIP-07 identity",
  nip05: "e2e-nip07@example.test",
  about: "Profile served by the ephemeral NIP-07 browser regression.",
};

interface Nip07BrowserMockIdentity {
  secretKey: Uint8Array;
  pubkey: string;
  profileEvent: ReturnType<typeof finalizeEvent>;
}

function createNip07BrowserMockIdentity(): Nip07BrowserMockIdentity {
  const secretKey = generateSecretKey();
  return {
    secretKey,
    pubkey: getPublicKey(secretKey),
    profileEvent: finalizeEvent({
      kind: 0,
      created_at: 1_700_000_000,
      tags: [],
      content: JSON.stringify(mockProfile),
    }, secretKey),
  };
}

let relay: MockRelay;

test.beforeAll(async () => {
  relay = await startMockRelay(8877);
});

test.afterAll(async () => {
  await relay.close();
});

async function installNip07BrowserMock(
  page: Page,
  identity: Nip07BrowserMockIdentity,
  restoredSessionInjectionDelayMs = 0,
): Promise<void> {
  const { profileEvent, pubkey, secretKey } = identity;
  await page.exposeFunction(
    "__nip07SignEvent",
    (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, secretKey),
  );
  await page.exposeFunction("__nip07Encrypt", (pubkey: string, plaintext: string) => {
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
    return nip44.v2.encrypt(plaintext, conversationKey);
  });
  await page.exposeFunction("__nip07Decrypt", (pubkey: string, ciphertext: string) => {
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
    return nip44.v2.decrypt(ciphertext, conversationKey);
  });
  await page.addInitScript(({ pubkey, profileEvent, restoredSessionInjectionDelayMs }) => {
    const testWindow = window as typeof window & {
      __nativeWebSocket?: typeof WebSocket;
      __nip07SignEvent?: (event: unknown) => Promise<unknown>;
      __nip07Encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
      __nip07Decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
    };
    testWindow.__nativeWebSocket = window.WebSocket;

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly CONNECTING = MockWebSocket.CONNECTING;
      readonly OPEN = MockWebSocket.OPEN;
      readonly CLOSING = MockWebSocket.CLOSING;
      readonly CLOSED = MockWebSocket.CLOSED;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;

      constructor(url: string) {
        void url;
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(payload: string): void {
        const message = JSON.parse(payload) as unknown;
        if (!Array.isArray(message) || message[0] !== "REQ" || typeof message[1] !== "string") return;

        const subscriptionId = message[1];
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify(["EVENT", subscriptionId, profileEvent]) } as MessageEvent<string>);
          this.onmessage?.({ data: JSON.stringify(["EOSE", subscriptionId]) } as MessageEvent<string>);
        });
      }

      close(): void {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ message: "" } as unknown as CloseEvent);
      }
    }

    const RoutedWebSocket = new Proxy(testWindow.__nativeWebSocket, {
      construct(Target, args) {
        const target = String(args[0] ?? "");
        if (target.startsWith("wss://purplepag.es") || target.startsWith("wss://relay.damus.io")) {
          return new MockWebSocket(target);
        }
        return Reflect.construct(Target, args);
      },
    });

    const installNip07 = () => Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        getPublicKey: async () => pubkey,
        signEvent: async (event: unknown) => {
          if (!testWindow.__nip07SignEvent) throw new Error("NIP-07 signing test bridge is unavailable");
          return testWindow.__nip07SignEvent(event);
        },
        nip44: {
          encrypt: async (recipientPubkey: string, plaintext: string) => {
            if (!testWindow.__nip07Encrypt) throw new Error("NIP-44 encryption test bridge is unavailable");
            return testWindow.__nip07Encrypt(recipientPubkey, plaintext);
          },
          decrypt: async (senderPubkey: string, ciphertext: string) => {
            if (!testWindow.__nip07Decrypt) throw new Error("NIP-44 decryption test bridge is unavailable");
            return testWindow.__nip07Decrypt(senderPubkey, ciphertext);
          },
        },
      },
    });
    if (localStorage.getItem("cordn:v1:nip07-session") && restoredSessionInjectionDelayMs > 0) {
      window.setTimeout(installNip07, restoredSessionInjectionDelayMs);
    } else {
      installNip07();
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: RoutedWebSocket });
  }, { pubkey, profileEvent, restoredSessionInjectionDelayMs });
}

async function openCoordinatorSettings(page: Page): Promise<Locator> {
  const topbar = page.locator(".host-topbar");
  const settingsTrigger = topbar.getByRole("button", { name: "Settings", exact: true });
  if (!(await settingsTrigger.isVisible())) {
    const guidedSettingsTrigger = page.getByRole("button", { name: "Review settings", exact: true });
    if (await guidedSettingsTrigger.isVisible()) {
      await guidedSettingsTrigger.click();
      const settings = page.getByTestId("coordinator-settings");
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "Edit settings" }).click();
      return settings;
    }
    const toolsTrigger = topbar.getByRole("button", { name: "Open host tools" });
    if (await toolsTrigger.isVisible()) await toolsTrigger.click();
  }
  await settingsTrigger.click();
  const settings = page.getByTestId("coordinator-settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Edit settings" }).click();
  return settings;
}

async function configureMockRelay(page: Page): Promise<void> {
  const settings = await openCoordinatorSettings(page);
  const removeDefaultRelay = settings.getByLabel(/Remove wss:\/\/relay\.contextvm\.org/);
  if (await removeDefaultRelay.isVisible()) await removeDefaultRelay.click();
  await settings.getByPlaceholder("wss://relay.example").fill(relay.url);
  await settings.getByRole("button", { name: "Add" }).click();
  await expect(settings.getByText(relay.url)).toBeVisible();
  await settings.getByRole("button", { name: "Done editing" }).click();
  await settings.getByRole("button", { name: "Close coordinator settings" }).last().click();
  await expect(settings).toBeHidden();
}

async function createRoom(page: Page, title: string): Promise<string> {
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const dialog = page.getByTestId("create-room-dialog");
  await dialog.getByPlaceholder("Friday plans").fill(title);
  await dialog.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(dialog).toBeHidden();
  const invite = await page.getByTestId("invite-link").textContent();
  expect(invite).toBeTruthy();
  return invite!;
}

async function observeIdentityChooser(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __identityChooserObserved?: boolean;
      __identityChooserObserver?: MutationObserver;
    };
    const check = () => {
      if (document.body?.textContent?.includes("Choose a name, then join the encrypted room.")) {
        testWindow.__identityChooserObserved = true;
      }
    };
    testWindow.__identityChooserObserved = false;
    testWindow.__identityChooserObserver?.disconnect();
    testWindow.__identityChooserObserver = new MutationObserver(check);
    testWindow.__identityChooserObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    check();
  });
}

async function expectIdentityChooserNeverObserved(page: Page): Promise<void> {
  expect(await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __identityChooserObserved?: boolean;
      __identityChooserObserver?: MutationObserver;
    };
    testWindow.__identityChooserObserver?.disconnect();
    return testWindow.__identityChooserObserved ?? false;
  })).toBe(false);
}

async function navigateWithinShell(page: Page, href: string): Promise<void> {
  await page.evaluate((nextHref) => {
    const target = new URL(nextHref, window.location.origin);
    window.history.pushState({}, "", `${target.pathname}${target.search}${target.hash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, href);
}

function autojoinInvitePath(): string {
  const coordinator = nip19.nprofileEncode({ pubkey: "a".repeat(64), relays: [] });
  const metadata = Buffer.from(JSON.stringify({
    title: "Restored signer invite",
    coordinatorOrigin: "http://127.0.0.1:4173",
  })).toString("base64url");
  return `/chat/restored-signer-room?c=${encodeURIComponent(coordinator)}&m=${encodeURIComponent(metadata)}&autojoin=1`;
}

test("keeps the unified root shell while an established anonymous identity opens a legacy invite", async ({ page }) => {
  await page.goto("/");
  const initialIdentity = await page.evaluate(() => {
    const profile = document.querySelector('[data-testid="user-profile"]');
    const record = JSON.parse(localStorage.getItem("cordn:v1:anonymous-identity") ?? "null") as { version?: unknown; secretKeyHex?: unknown } | null;
    return {
      identityVersion: record?.version,
      hasCredential: typeof record?.secretKeyHex === "string",
      avatar: profile?.querySelector("img")?.getAttribute("src"),
    };
  });
  expect(initialIdentity.hasCredential).toBe(true);
  expect(initialIdentity.avatar).toBeTruthy();
  await page.reload();
  const restoredIdentity = await page.evaluate(() => {
    const profile = document.querySelector('[data-testid="user-profile"]');
    const record = JSON.parse(localStorage.getItem("cordn:v1:anonymous-identity") ?? "null") as { version?: unknown; secretKeyHex?: unknown } | null;
    return {
      identityVersion: record?.version,
      hasCredential: typeof record?.secretKeyHex === "string",
      avatar: profile?.querySelector("img")?.getAttribute("src"),
    };
  });
  expect(restoredIdentity).toEqual(initialIdentity);
  await observeIdentityChooser(page);

  await navigateWithinShell(page, autojoinInvitePath());

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  await expect(page.getByTestId("workspace-navigation")).toHaveCount(1);
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.getByTestId("chat-route")).toBeVisible();
  await expect(page.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await page.waitForTimeout(500);
  await expectIdentityChooserNeverObserved(page);
});

test("rotates a zero-membership local identity only after the approved confirmation", async ({ page }) => {
  await page.goto("/");
  const profile = page.getByTestId("user-profile");
  const original = await profile.locator("img").getAttribute("src");

  await profile.getByRole("button", { name: /^Open profile for / }).click();
  const menu = page.getByRole("dialog", { name: "User profile" });
  await expect(menu.getByText("device-local and persist in this browser", { exact: false })).toBeVisible();
  await menu.getByRole("button", { name: "Rotate identity…" }).click();

  const dialog = page.getByTestId("identity-rotation-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Rotate local identity?" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "No local room memberships" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep current identity" })).toBeFocused();
  await dialog.getByRole("button", { name: "Rotate identity" }).click();

  await expect(dialog).toBeHidden();
  await expect(profile.locator("img")).not.toHaveAttribute("src", original ?? "");
  await expect(page.getByText("Identity rotated. Previous channels were moved to History.")).toBeAttached();
});

test("restores NIP-07 before a legacy invite is consumed in the unified root shell", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const mockIdentity = createNip07BrowserMockIdentity();
  await installNip07BrowserMock(page, mockIdentity, 75);
  await page.goto("/");

  const profile = page.getByTestId("user-profile");
  await profile.getByRole("button", { name: /^Open profile for / }).click();
  const signInMenu = page.getByRole("dialog", { name: "User profile" });
  await signInMenu.getByRole("button", { name: /NIP-07 browser signer/ }).click();
  await expect(signInMenu).toBeHidden();
  await expect(profile).toContainText(mockProfile.display_name);
  await expect(profile).toContainText("NIP-07");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cordn:v1:nip07-session"))).toBe(
    JSON.stringify({ version: 1, method: "nip07" }),
  );

  await page.reload();

  await expect(profile).toContainText(mockProfile.display_name);
  await expect(profile).toContainText("NIP-07");
  await profile.getByRole("button", { name: /^Open profile for / }).click();
  const restoredMenu = page.getByRole("dialog", { name: "User profile" });
  await expect(restoredMenu).toContainText(mockProfile.nip05);
  await expect(restoredMenu).toContainText(mockProfile.about);
  await expect(restoredMenu.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(restoredMenu.getByRole("button", { name: /NIP-07 browser signer/ })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(restoredMenu).toBeHidden();

  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await installEstablishedInstallation(host);
  await host.goto("/");
  await configureMockRelay(host);
  await host.getByRole("button", { name: "Start", exact: true }).click();
  await expect(host.getByRole("button", { name: "Create room", exact: true })).toBeVisible({ timeout: 35_000 });
  await expect(host.getByTestId("status-badge")).toBeHidden();
  const roomTitle = "NIP-07 restored signer room";
  const invite = await createRoom(host, roomTitle);

  await observeIdentityChooser(page);
  await navigateWithinShell(page, invite);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  await expect(page.getByTestId("workspace-navigation")).toHaveCount(1);
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.getByTestId("chat-route")).toBeVisible();
  await expect(page.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });
  await expect.poll(() => page.evaluate((title) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      try {
        const room = JSON.parse(localStorage.getItem(key) ?? "null") as {
          title?: string;
          stablePubkey?: string;
          isHost?: boolean;
        } | null;
        if (room?.title === title && room.isHost === false) return room.stablePubkey ?? "";
      } catch {
        // Ignore unrelated or malformed browser storage entries.
      }
    }
    return "";
  }, roomTitle), { timeout: 35_000 }).toBe(mockIdentity.pubkey);
  await expectIdentityChooserNeverObserved(page);

  await hostContext.close();
});
