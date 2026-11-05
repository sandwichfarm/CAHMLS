import { Buffer } from "node:buffer";
import { expect, test, type Locator, type Page } from "./established-installation-fixture";
import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

const previousCoordinatorPubkey = "a".repeat(64);
const currentTestTitle = "Recovered local host session";

function createStoredRoomPrivateFixture(): {
  anonymousSecretKey: string;
  keyPackagePrivateBase64: string;
} {
  return {
    anonymousSecretKey: bytesToHex(generateSecretKey()),
    keyPackagePrivateBase64: Buffer.from(generateSecretKey()).toString("base64"),
  };
}

async function openCoordinatorSettings(page: Page, edit = false): Promise<Locator> {
  const topbar = page.locator(".host-topbar");
  const settingsTrigger = topbar.getByRole("button", { name: "Settings", exact: true });
  if (!(await settingsTrigger.isVisible())) {
    const guidedSettingsTrigger = page.getByRole("button", { name: "Review settings", exact: true });
    if (await guidedSettingsTrigger.isVisible()) {
      await guidedSettingsTrigger.click();
      const settings = page.getByTestId("coordinator-settings");
      await expect(settings).toBeVisible();
      if (edit) await settings.getByRole("button", { name: "Edit settings" }).click();
      return settings;
    }
    const toolsTrigger = topbar.getByRole("button", { name: "Open host tools" });
    if (await toolsTrigger.isVisible()) await toolsTrigger.click();
  }
  await settingsTrigger.click();
  const settings = page.getByTestId("coordinator-settings");
  await expect(settings).toBeVisible();
  if (edit) await settings.getByRole("button", { name: "Edit settings" }).click();
  return settings;
}

async function closeCoordinatorSettings(settings: Locator): Promise<void> {
  const done = settings.getByRole("button", { name: "Done editing" });
  if (await done.isVisible()) await done.click();
  await settings.getByRole("button", { name: "Close coordinator settings" }).last().click();
  await expect(settings).toBeHidden();
}

async function enablePersistence(page: Page, passphrase: string): Promise<void> {
  const settings = await openCoordinatorSettings(page, true);
  await settings.getByRole("button", { name: "Enable persistence" }).click();
  await settings.getByPlaceholder("passphrase", { exact: true }).fill(passphrase);
  await settings.getByPlaceholder("confirm passphrase").fill(passphrase);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(settings.getByText("Saved on this device")).toBeVisible();
  await closeCoordinatorSettings(settings);
}

async function readCurrentCoordinatorPubkey(page: Page): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const settings = await openCoordinatorSettings(page);
  await settings.getByRole("button", { name: "Copy coordinator public key" }).click();
  const pubkey = await page.evaluate(() => navigator.clipboard.readText());
  await closeCoordinatorSettings(settings);
  expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  return pubkey;
}

async function seedStoredRoom(
  page: Page,
  input: {
    coordinatorPubkey: string;
    roomId: string;
    title: string;
    name: string;
    isHost: boolean;
    coordinatorKeyMode?: "ephemeral" | "persistent";
    messages?: Array<Record<string, unknown>>;
  },
): Promise<void> {
  const privateFixture = createStoredRoomPrivateFixture();
  await page.evaluate(({ coordinatorPubkey, roomId, title, name, isHost, coordinatorKeyMode, messages, privateFixture }) => {
    const room = {
      version: 1,
      id: roomId,
      title,
      coordinatorPubkey,
      coordinatorOrigin: window.location.origin,
      relayUrls: ["ws://127.0.0.1:1"],
      name,
      stablePubkey: "b".repeat(64),
      host: { name, pubkey: "d".repeat(64) },
      isHost,
      stateBase64: "",
      keyPackage: {
        reference: `${name}-ref`,
        publicBase64: "public",
        privateBase64: privateFixture.keyPackagePrivateBase64,
      },
      anonymousSecretKey: privateFixture.anonymousSecretKey,
      lastCursor: 0,
      messages: messages ?? [],
      pending: [],
      coordinatorKeyMode: coordinatorKeyMode ?? "ephemeral",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    localStorage.setItem(
      `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(roomId)}`,
      JSON.stringify(room),
    );
    window.dispatchEvent(new CustomEvent("cordn:rooms-changed", {
      detail: { roomId, coordinatorPubkey },
    }));
  }, { ...input, privateFixture });
}

async function openRoomActions(page: Page, roomTitle: string): Promise<Locator> {
  const navigation = page.getByTestId("workspace-navigation");
  await expect(navigation.getByRole("button", { name: "More room actions" })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "More room actions" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu", { name: `Room actions for ${roomTitle}` });
  await expect(menu).toBeVisible();
  return menu;
}

async function expectEmbeddedChatFillsHostPane(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-testid="host-chat"]');
    const route = pane?.querySelector<HTMLElement>('[data-testid="chat-route"]');
    const cached = route?.querySelector<HTMLElement>('[data-testid="cached-room-view"]');
    if (!pane || !route || !cached) return false;
    const paneBounds = pane.getBoundingClientRect();
    const routeBounds = route.getBoundingClientRect();
    const cachedBounds = cached.getBoundingClientRect();
    const aligned = (bounds: DOMRect) => (
      Math.abs(bounds.left - paneBounds.left) <= 1
      && Math.abs(bounds.right - paneBounds.right) <= 1
    );
    return aligned(routeBounds) && aligned(cachedBounds);
  })).toBe(true);
}

test("moves a foreign host record into collapsed history after reload", async ({ page }) => {
  const roomId = "same-id-current-and-previous-local-room";
  const passphrase = "stale-local-session-passphrase";
  await page.goto("/");
  await expect(page.getByTestId("operator-shell")).toBeVisible();

  // Persist the current coordinator so the reload used to exercise the legacy
  // route does not turn both composite room identities into stale sessions.
  await enablePersistence(page, passphrase);
  const currentCoordinatorPubkey = await readCurrentCoordinatorPubkey(page);
  expect(currentCoordinatorPubkey).not.toBe(previousCoordinatorPubkey);

  await seedStoredRoom(page, {
    coordinatorPubkey: previousCoordinatorPubkey,
    roomId,
    title: currentTestTitle,
    name: "Original host",
    isHost: true,
  });
  await seedStoredRoom(page, {
    coordinatorPubkey: currentCoordinatorPubkey,
    roomId,
    title: currentTestTitle,
    name: "Current host",
    isHost: true,
    coordinatorKeyMode: "persistent",
  });

  await page.goto("/chats", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("operator-shell")).toHaveCount(0);
  await expect(page.getByTestId("chat-lobby")).toHaveCount(0);

  const unlock = page.getByTestId("coordinator-unlock");
  await expect(unlock).toBeVisible();
  await unlock.getByPlaceholder("passphrase", { exact: true }).fill(passphrase);
  await unlock.getByRole("button", { name: "Unlock coordinator" }).click();
  await expect(unlock).toBeHidden();
  await expect(page.getByTestId("operator-shell")).toBeVisible();

  const currentRoomButton = page.getByRole("button", {
    name: new RegExp(`^Open room ${currentTestTitle}, hosted by `),
  });
  await expect(currentRoomButton).toBeVisible();

  const history = page.getByTestId("sidebar-history");
  await expect(history.getByRole("button", { name: /History 1/ })).toHaveAttribute("aria-expanded", "false");
  await expect(history).not.toContainText(currentTestTitle);
  await history.getByRole("button", { name: /History 1/ }).click();
  await expect(history).toContainText(currentTestTitle);
  await expect(history).toContainText("Coordinator key rotated");
  await expect(page.getByRole("button", { name: `Open previous local session ${currentTestTitle}, hosted by Original host` })).toHaveCount(0);

  await expect.poll(() => page.evaluate(({ currentCoordinatorPubkey, previousCoordinatorPubkey, roomId }) => {
    const roomKey = (coordinatorPubkey: string) => (
      `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(roomId)}`
    );
    return {
      current: JSON.parse(localStorage.getItem(roomKey(currentCoordinatorPubkey)) ?? "null"),
      previous: JSON.parse(localStorage.getItem(roomKey(previousCoordinatorPubkey)) ?? "null"),
    };
  }, { currentCoordinatorPubkey, previousCoordinatorPubkey, roomId })).toEqual({
    current: expect.objectContaining({
      id: roomId,
      coordinatorPubkey: currentCoordinatorPubkey,
      isHost: true,
    }),
    previous: expect.objectContaining({
      id: roomId,
      coordinatorPubkey: previousCoordinatorPubkey,
      isHost: true,
    }),
  });
  await expect(page.getByRole("button", {
    name: new RegExp(`^Open room ${currentTestTitle}, hosted by `),
  })).toBeVisible();
});

test("keeps a stale remote room readable without granting a mismatched signer session", async ({ page }) => {
  const remoteCoordinatorPubkey = "c".repeat(64);
  const roomId = "stale-remote-room";
  const title = "Remote archive";
  const cachedMessage = "Cached before the remote coordinator went away";

  await page.goto("/");
  await seedStoredRoom(page, {
    coordinatorPubkey: remoteCoordinatorPubkey,
    roomId,
    title,
    name: "Remote host",
    isHost: false,
    messages: [{
      type: "message",
      id: "cached-remote-message",
      sender: "d".repeat(64),
      name: "Remote host",
      content: cachedMessage,
      createdAt: Date.now() - 1_000,
    }],
  });

  await page.goto("/chats", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  await expect(page.getByTestId("chat-lobby")).toHaveCount(0);

  await expect(page.getByTestId(`coordinator-card-status-${remoteCoordinatorPubkey}`)).toHaveAttribute("data-state", "offline", { timeout: 15_000 });
  await page.getByTestId("invite-panel").locator(
    `[data-testid="coordinator-card"][data-coordinator-pubkey="${remoteCoordinatorPubkey}"]`,
  ).focus();
  const remoteRoom = page.getByRole("button", {
    name: new RegExp(`^Open room ${title}, hosted by `),
  });
  await expect(remoteRoom).toBeVisible();
  await remoteRoom.click();

  await expect(page).toHaveURL(/\/$/);
  const cachedView = page.getByTestId("cached-room-view");
  await expect(cachedView).toBeVisible();
  await expect(cachedView.getByText(cachedMessage, { exact: true })).toBeVisible();
  await expectEmbeddedChatFillsHostPane(page);
  await expect(page.getByTestId("room-connection-offline-message")).toHaveCount(0);
  await expect(page.getByTestId("chat-composer").getByRole("textbox")).toBeDisabled();
  await expect(page.getByTestId("chat-composer-status")).toContainText("Reconnect your signer to sync this room and send messages.");
  const roomActions = await openRoomActions(page, title);
  await expect(roomActions.getByRole("menuitem", { name: `Leave room ${title}` })).toBeVisible();
  await expect(roomActions.getByRole("menuitem", { name: `Delete room ${title}` })).toHaveCount(0);
});

test("keeps a marker-persisted identity in recovery after a pre-retirement reload", async ({ page }) => {
  await page.addInitScript(() => {
    const coordinatorPubkey = "a".repeat(64);
    localStorage.setItem("cordn:v1:anonymous-identity", JSON.stringify({
      version: 1,
      secretKeyHex: `${"0".repeat(63)}1`,
    }));
    localStorage.setItem("cordn:v1:anonymous-identity-recovery", JSON.stringify({ version: 1 }));
    localStorage.setItem(`cordn-adhoc-chat-room:v2:${coordinatorPubkey}:pre-boundary-room`, JSON.stringify({
      version: 1,
      id: "pre-boundary-room",
      title: "Pre-boundary room",
      coordinatorPubkey,
      relayUrls: ["wss://relay.example"],
      name: "River",
      stablePubkey: "b".repeat(64),
      identityOwner: "anonymous",
      isHost: false,
      stateBase64: "still-private-before-retirement",
      keyPackage: { reference: "private-reference", publicBase64: "public", privateBase64: "private" },
      lastCursor: 0,
      messages: [],
      pending: [],
      inviteToken: "private-invite",
    }));
  });
  await page.goto("/");

  const recovery = page.getByTestId("identity-rotation-dialog");
  await expect(recovery.getByRole("heading", { name: "Recover local identity" })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Create new identity" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(recovery).toBeVisible();
  await expect(page.getByTestId("user-profile").locator(".user-trigger")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const room = JSON.parse(localStorage.getItem(`cordn-adhoc-chat-room:v2:${"a".repeat(64)}:pre-boundary-room`) ?? "null") as { stateBase64?: string; inviteToken?: string } | null;
    return room?.stateBase64 === "still-private-before-retirement" && room.inviteToken === "private-invite";
  })).toBe(true);
});
