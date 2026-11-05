import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { expect, installEstablishedInstallation, test } from "./established-installation-fixture";
import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

import { startMockRelay, type MockRelay } from "../../packages/sdk/tests/support/mock-relay";

// User-visible workspace, coordinator, room, and invite behavior.

let relay: MockRelay;

function createStoredRoomPrivateFixture(): {
  anonymousSecretKey: string;
  keyPackagePrivateBase64: string;
} {
  return {
    anonymousSecretKey: bytesToHex(generateSecretKey()),
    keyPackagePrivateBase64: Buffer.from(generateSecretKey()).toString("base64"),
  };
}

test.beforeAll(async () => {
  relay = await startMockRelay();
});

test.afterAll(async () => {
  await relay.close();
});

async function configureMockRelay(page: import("@playwright/test").Page): Promise<void> {
  const settings = await openCoordinatorSettings(page, true);
  if (await settings.getByText(relay.url).isVisible()) {
    await closeCoordinatorSettings(settings);
    return;
  }

  const removeDefaultRelay = settings.getByLabel(/Remove wss:\/\/relay\.contextvm\.org/);
  if (await removeDefaultRelay.isVisible()) {
    await removeDefaultRelay.click();
  }

  await settings.getByPlaceholder("wss://relay.example").fill(relay.url);
  await settings.getByRole("button", { name: "Add" }).click();
  await expect(settings.getByText(relay.url)).toBeVisible();
  await closeCoordinatorSettings(settings);
}

async function openCoordinatorSettings(
  page: import("@playwright/test").Page,
  edit = false,
): Promise<import("@playwright/test").Locator> {
  const anonymousChoice = page.getByRole("button", { name: /Continue anonymously/ });
  if (await anonymousChoice.isVisible()) await anonymousChoice.click();
  const saveCoordinatorName = page.getByRole("button", { name: "Save and continue" });
  if (await saveCoordinatorName.isVisible()) await saveCoordinatorName.click();
  let settingsTrigger = page.getByRole("button", { name: /^Settings for / }).first();
  if (!(await settingsTrigger.isVisible())) {
    const guidedSettingsTrigger = page.getByRole("button", { name: "Review settings", exact: true });
    if (await guidedSettingsTrigger.isVisible()) {
      await guidedSettingsTrigger.click();
      const settings = page.getByTestId("coordinator-settings");
      await expect(settings).toBeVisible();
      if (edit) await settings.getByRole("button", { name: "Edit settings" }).click();
      return settings;
    }
    const railTrigger = page.getByRole("button", { name: "Open room browser" });
    if (await railTrigger.isVisible()) await railTrigger.click();
    settingsTrigger = page.getByRole("button", { name: /^Settings for / }).first();
  }
  await settingsTrigger.click();
  const settings = page.getByTestId("coordinator-settings");
  await expect(settings).toBeVisible();
  if (edit) await settings.getByRole("button", { name: "Edit settings" }).click();
  return settings;
}

async function closeCoordinatorSettings(settings: import("@playwright/test").Locator): Promise<void> {
  const done = settings.getByRole("button", { name: "Done editing" });
  if (await done.isVisible()) await done.click();
  await settings.getByRole("button", { name: "Close coordinator settings" }).last().click();
  await expect(settings).toBeHidden();
}

async function startCoordinator(page: import("@playwright/test").Page): Promise<void> {
  const start = page.getByRole("button", { name: "Start", exact: true });
  if (!(await start.isVisible())) {
    const railTrigger = page.getByRole("button", { name: "Open room browser" });
    if (await railTrigger.isVisible()) await railTrigger.click();
  }
  await start.click();
}

async function stopCoordinator(page: import("@playwright/test").Page): Promise<void> {
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  if (!(await stop.isVisible())) {
    await page.getByRole("button", { name: "Open room browser" }).click();
  }
  await stop.click();
}

async function expectGuidedCoordinatorOnline(page: import("@playwright/test").Page): Promise<void> {
  const guidedState = page.getByTestId("coordinator-empty-content");
  await expect(guidedState).toContainText("Coordinator online", { timeout: 15_000 });
  await expect(guidedState).toContainText("Ready for your first room");
  const createRoom = page.getByRole("button", { name: "Create room", exact: true });
  await expect(createRoom).toBeVisible();
  const layout = await guidedState.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hostBounds = element.parentElement?.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      alignContent: styles.alignContent,
      centerOffsetX: hostBounds
        ? Math.abs((bounds.left + bounds.width / 2) - (hostBounds.left + hostBounds.width / 2))
        : Number.POSITIVE_INFINITY,
      heightDelta: hostBounds ? Math.abs(bounds.height - hostBounds.height) : Number.POSITIVE_INFINITY,
      widthDelta: hostBounds ? Math.abs(bounds.width - hostBounds.width) : Number.POSITIVE_INFINITY,
    };
  });
  expect(layout.alignContent).toBe("center");
  expect(layout.centerOffsetX).toBeLessThan(2);
  expect(layout.heightDelta).toBeLessThan(2);
  expect(layout.widthDelta).toBeLessThan(2);
  const createRoomBounds = await createRoom.boundingBox();
  expect(createRoomBounds?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(320);
  await expect(page.getByTestId("status-badge")).toBeHidden();
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open management interface" })).toHaveCount(0);
  await expect(page.getByText("Notification settings", { exact: true })).toBeVisible();
}

async function openManagement(page: import("@playwright/test").Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Open management interface" });
  await trigger.click();
  await expect(page.getByTestId("management-interface")).toBeVisible();
}

async function closeManagement(page: import("@playwright/test").Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Close management interface" });
  await trigger.click();
  await expect(page.getByTestId("management-interface")).toBeHidden();
}

async function pageExitIsGuarded(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function expectNoDocumentOverflow(
  page: import("@playwright/test").Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
  }))).toEqual({
    clientWidth: viewport.width,
    scrollWidth: viewport.width,
    clientHeight: viewport.height,
    scrollHeight: viewport.height,
    bodyWidth: viewport.width,
    bodyHeight: viewport.height,
  });
}

async function expectInsideViewport(locator: import("@playwright/test").Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0
      && bounds.top >= 0
      && bounds.right <= window.innerWidth
      && bounds.bottom <= window.innerHeight;
  })).toBe(true);
}

async function expectStartupFillsHostPane(page: import("@playwright/test").Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-testid="host-chat"]');
    const stage = pane?.querySelector<HTMLElement>(".startup-stage");
    const field = stage?.querySelector<HTMLElement>('[data-testid="startup-ascii-field"]');
    const bed = field?.querySelector<HTMLElement>(".ascii-bed .ascii-texture");
    if (!pane || !stage || !field || !bed) return false;

    const paneBounds = pane.getBoundingClientRect();
    const stageBounds = stage.getBoundingClientRect();
    const fieldBounds = field.getBoundingClientRect();
    const aligned = (left: DOMRect, right: DOMRect) => (
      Math.abs(left.left - right.left) <= 1
      && Math.abs(left.top - right.top) <= 1
      && Math.abs(left.width - right.width) <= 1
      && Math.abs(left.height - right.height) <= 1
      && Math.abs(left.right - right.right) <= 1
    );
    const paneStyle = getComputedStyle(pane);
    const stageStyle = getComputedStyle(stage);
    const fieldStyle = getComputedStyle(field);
    const firstLine = bed.textContent?.split("\n", 1)[0] ?? "";
    const textNode = bed.firstChild;
    const firstLineRange = document.createRange();
    if (!textNode || firstLine.length === 0) return false;
    firstLineRange.setStart(textNode, 0);
    firstLineRange.setEnd(textNode, firstLine.length);
    const visibleTextureWidth = firstLineRange.getBoundingClientRect().width;
    return aligned(paneBounds, stageBounds)
      && aligned(paneBounds, fieldBounds)
      && visibleTextureWidth >= fieldBounds.width * 1.08
      && bed.scrollHeight >= fieldBounds.height
      && paneStyle.position === "relative"
      && stageStyle.position === "absolute"
      && fieldStyle.position === "absolute";
  })).toBe(true);
}

async function expectShellControlsUsable(page: import("@playwright/test").Page): Promise<void> {
  const topbar = page.locator(".host-topbar");
  const rail = page.getByTestId("invite-panel");
  await expect(topbar).toBeVisible();
  await expect(rail).toBeVisible();
  await expect(topbar).not.toHaveAttribute("inert");
  await expect(topbar).not.toHaveAttribute("aria-hidden", "true");
  await expect(rail).not.toHaveAttribute("inert");
  await expect(rail).not.toHaveAttribute("aria-hidden", "true");

  const coordinatorSettings = rail.getByRole("button", { name: /^Settings for / }).first();
  await coordinatorSettings.focus();
  await expect(coordinatorSettings).toBeFocused();
  await coordinatorSettings.click();
  const settings = page.getByTestId("coordinator-settings");
  await expect(settings).toBeVisible();
  await closeCoordinatorSettings(settings);

  await expect(rail.getByTestId("coordinator-runtime-card")).toBeVisible();
}

async function expectStartupMasks(page: import("@playwright/test").Page): Promise<void> {
  const field = page.getByTestId("startup-ascii-field");
  await expect(field).toHaveAttribute("aria-hidden", "true");
  await expect(field).toHaveAttribute("data-visual", "fluid-ripples");
  await expect(field).toHaveCSS("pointer-events", "none");
  await expect(field.locator(".ascii-bed .ascii-texture")).toHaveCount(1);
  await expect(field.locator(".ripple-mask-lines .ripple-contour")).toHaveCount(6);
  await expect(field.locator(".ripple-traces .ripple-contour")).toHaveCount(6);
  await expect(field.locator(".ripple-ascii-layer .ripple-texture")).toHaveCount(1);
  await expect(field.locator("feTurbulence.ripple-noise")).toHaveCount(1);
  await expect(field.locator("feDisplacementMap.ripple-displacement")).toHaveCount(1);
  expect(await field.locator(".ripple-ascii-layer").getAttribute("mask")).toBe("url(#startup-ripple-mask)");
  await expect(field.locator(".ripple-plane")).toHaveAttribute("focusable", "false");
}

async function expectStartupVisualContract(page: import("@playwright/test").Page): Promise<void> {
  const contract = await page.locator(".startup-stage").evaluate((stage) => {
    const panel = stage.querySelector<HTMLElement>(".startup-progress-panel")!;
    const kicker = stage.querySelector<HTMLElement>(".startup-kicker")!;
    const display = stage.querySelector<HTMLElement>("h1")!;
    const label = panel.querySelector<HTMLElement>("header span")!;
    const heading = panel.querySelector<HTMLElement>("header strong")!;
    const body = panel.querySelector<HTMLElement>("footer")!;
    const control = stage.querySelector<HTMLElement>(".startup-stage-actions button")!;
    const track = panel.querySelector<HTMLElement>(".startup-progress-track")!;
    const fill = track.querySelector<HTMLElement>("span")!;
    const style = getComputedStyle(stage);
    const panelStyle = getComputedStyle(panel);
    const trackStyle = getComputedStyle(track);

    return {
      stageBackgroundImage: style.backgroundImage,
      stageBeforeContent: getComputedStyle(stage, "::before").content,
      kicker: { size: getComputedStyle(kicker).fontSize, weight: getComputedStyle(kicker).fontWeight, usesAccent: getComputedStyle(kicker).color === "rgb(124, 245, 157)" },
      display: { size: getComputedStyle(display).fontSize, weight: getComputedStyle(display).fontWeight },
      heading: { size: getComputedStyle(heading).fontSize, weight: getComputedStyle(heading).fontWeight },
      body: { size: getComputedStyle(body).fontSize, weight: getComputedStyle(body).fontWeight },
      label: { size: getComputedStyle(label).fontSize, weight: getComputedStyle(label).fontWeight },
      control: { size: getComputedStyle(control).fontSize, weight: getComputedStyle(control).fontWeight },
      panel: { marginTop: panelStyle.marginTop, paddingTop: panelStyle.paddingTop, paddingRight: panelStyle.paddingRight },
      track: { height: trackStyle.height, marginTop: trackStyle.marginTop, fillBackgroundImage: getComputedStyle(fill).backgroundImage },
    };
  });

  expect(contract).toEqual({
    stageBackgroundImage: "none",
    stageBeforeContent: "none",
    kicker: { size: "12px", weight: "600", usesAccent: false },
    display: { size: "48px", weight: "600" },
    heading: { size: "11.52px", weight: "650" },
    body: { size: "8.64px", weight: "400" },
    label: { size: "7.68px", weight: "700" },
    control: { size: "9.6px", weight: "400" },
    panel: { marginTop: "20px", paddingTop: "12.8px", paddingRight: "14.4px" },
    track: {
      height: "4.46875px",
      marginTop: "11.2px",
      fillBackgroundImage: "linear-gradient(90deg, rgb(76, 174, 103), rgb(124, 245, 157))",
    },
  });
}

async function expectStartupCompactVisualContract(page: import("@playwright/test").Page): Promise<void> {
  const contract = await page.locator(".startup-stage").evaluate((stage) => {
    const panel = stage.querySelector<HTMLElement>(".startup-progress-panel")!;
    const display = stage.querySelector<HTMLElement>("h1")!;
    const footer = panel.querySelector<HTMLElement>("footer")!;
    const stageStyle = getComputedStyle(stage);
    const panelStyle = getComputedStyle(panel);
    const footerStyle = getComputedStyle(footer);

    return {
      stagePadding: stageStyle.paddingTop,
      display: { size: getComputedStyle(display).fontSize, marginTop: getComputedStyle(display).marginTop },
      panel: {
        marginTop: panelStyle.marginTop,
        paddingTop: panelStyle.paddingTop,
        paddingRight: panelStyle.paddingRight,
      },
      footer: { gap: footerStyle.gap, marginTop: footerStyle.marginTop },
    };
  });

  expect(contract).toEqual({
    stagePadding: "8px",
    display: { size: "28px", marginTop: "4px" },
    panel: { marginTop: "10.4px", paddingTop: "11.2px", paddingRight: "12px" },
    footer: { gap: "8.8px", marginTop: "6.4px" },
  });
}

async function expectStartupFieldStatic(field: import("@playwright/test").Locator): Promise<void> {
  await field.page().waitForTimeout(1_000);
  const beforeTransforms = await field.locator(".ascii-bed .ascii-texture, .ripple-plane, .ripple-mask-lines, .ripple-traces, .ripple-texture").evaluateAll((elements) => (
    elements.map((element) => getComputedStyle(element).transform)
  ));
  await field.page().waitForTimeout(650);
  await expect.poll(() => field.locator(".ascii-bed .ascii-texture, .ripple-plane, .ripple-mask-lines, .ripple-traces, .ripple-texture").evaluateAll((elements) => (
    elements.map((element) => getComputedStyle(element).transform)
  ))).toEqual(beforeTransforms);
}

async function openRoomActions(
  page: import("@playwright/test").Page,
  roomTitle: string,
): Promise<import("@playwright/test").Locator> {
  const navigation = page.getByTestId("workspace-navigation");
  await expect(navigation.getByRole("button", { name: "More room actions" })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "More room actions" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu", { name: `Room actions for ${roomTitle}` });
  await expect(menu).toBeVisible();
  return menu;
}

async function expectEmbeddedChatFillsHostPane(page: import("@playwright/test").Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-testid="host-chat"]');
    const route = pane?.querySelector<HTMLElement>('[data-testid="chat-route"]');
    const cached = route?.querySelector<HTMLElement>('[data-testid="cached-room-view"]');
    if (!pane || !route || !cached) return false;
    const paneBounds = pane.getBoundingClientRect();
    const routeBounds = route.getBoundingClientRect();
    const cachedBounds = cached.getBoundingClientRect();
    const aligned = (left: number, right: number) => (
      Math.abs(left - paneBounds.left) <= 1
      && Math.abs(right - paneBounds.right) <= 1
    );
    return aligned(routeBounds.left, routeBounds.right)
      && aligned(cachedBounds.left, cachedBounds.right);
  })).toBe(true);
}

async function enablePersistence(page: import("@playwright/test").Page, passphrase: string): Promise<void> {
  const settings = await openCoordinatorSettings(page, true);
  await settings.getByRole("button", { name: "Enable persistence" }).click();
  await settings.getByPlaceholder("passphrase", { exact: true }).fill(passphrase);
  await settings.getByPlaceholder("confirm passphrase").fill(passphrase);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(settings.getByText("Saved on this device")).toBeVisible();
  await closeCoordinatorSettings(settings);
}

async function readCoordinatorNpub(page: import("@playwright/test").Page): Promise<string> {
  const settings = await openCoordinatorSettings(page);
  const npub = await settings.getByRole("button", { name: "Copy coordinator public key" }).textContent() ?? "";
  await closeCoordinatorSettings(settings);
  return npub;
}

async function customizeHostIdentity(
  page: import("@playwright/test").Page,
  name: string,
  badge: string,
  emoji: string,
): Promise<void> {
  await page.getByTestId("user-profile").getByRole("button").first().click();
  const profile = page.getByRole("dialog", { name: "User profile" });
  await expect(profile).toBeVisible();
  await profile.getByLabel("Display name").fill(name);
  await page.keyboard.press("Escape");
  await expect(profile).toBeHidden();

  const settings = await openCoordinatorSettings(page, true);
  await settings.getByLabel("Badge text").fill(badge);
  await settings.getByRole("button", { name: "Choose badge emoji" }).click();
  await settings.getByRole("button", { name: `Use ${emoji} for badge` }).click();
  await closeCoordinatorSettings(settings);
}

async function createRoom(page: import("@playwright/test").Page, title: string): Promise<void> {
  const createTrigger = page.getByRole("button", { name: "Create room", exact: true });
  const railToggle = page.getByRole("button", { name: "Open room browser" });
  if (!(await createTrigger.isVisible()) && await railToggle.isVisible()) await railToggle.click();
  const availableTrigger = createTrigger
    .or(page.getByRole("button", { name: "New room" }))
    .or(page.getByRole("button", { name: "Create group" }))
    .first();
  await expect(availableTrigger).toBeVisible();
  await availableTrigger.click();
  const dialog = page.getByTestId("create-room-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Friday plans").fill(title);
  await dialog.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("global and per-channel sound controls persist and expose non-default state", async ({ page }) => {
  await installEstablishedInstallation(page);
  await page.goto("/");
  await configureMockRelay(page);
  await startCoordinator(page);
  await createRoom(page, "Preference room");

  const globalSound = page.getByRole("button", { name: "Mute all channel sounds" });
  await expect(globalSound).toBeVisible();
  const headerBounds = await page.locator(".host-topbar").boundingBox();
  const soundBounds = await globalSound.boundingBox();
  expect(headerBounds).not.toBeNull();
  expect(soundBounds).not.toBeNull();
  expect(Math.abs((headerBounds!.x + headerBounds!.width) - (soundBounds!.x + soundBounds!.width))).toBeLessThan(24);
  await globalSound.click();
  await expect(page.getByRole("button", { name: "Enable channel sounds" })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cordn:v1:global-sound"))).toBe("false");

  const card = page.getByTestId("coordinator-card").first();
  const createGroup = card.getByRole("button", { name: "Create group" });
  await expect(createGroup).toHaveText("+");
  await expect(card).not.toContainText("+ Group");
  const createMetrics = await createGroup.evaluate((element) => ({
    fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
    transformBefore: getComputedStyle(element).transform,
    cursor: getComputedStyle(element).cursor,
    rightGap: Math.abs((element.closest("legend")!.getBoundingClientRect().right) - element.getBoundingClientRect().right),
  }));
  expect(createMetrics.fontSize).toBeGreaterThanOrEqual(18);
  expect(createMetrics.cursor).toBe("pointer");
  expect(createMetrics.rightGap).toBeLessThan(12);
  await createGroup.hover();
  await expect.poll(() => createGroup.evaluate((element) => getComputedStyle(element).transform)).not.toBe("none");

  const roomActions = page.getByTestId("host-chat").getByRole("button", { name: "More room actions" });
  await roomActions.click();
  await page.getByLabel("Sound setting for Preference room").selectOption("off");
  await page.getByLabel("Notification setting for Preference room").selectOption("mute");
  const mutedSound = card.locator('[aria-label="Sound muted for this channel"]');
  const mutedNotifications = card.locator('[aria-label="Notifications muted for this channel"]');
  await expect(mutedSound).toBeVisible();
  await expect(mutedNotifications).toBeVisible();
  await expect(mutedSound.locator(".strike")).toHaveCount(1);
  await expect(mutedNotifications.locator(".strike")).toHaveCount(1);
  expect(await card.locator(".channel-row-primary").evaluate((row) => {
    const name = row.querySelector<HTMLElement>(".truncate")!.getBoundingClientRect();
    const indicators = row.querySelector<HTMLElement>(".channel-preference-indicators")!.getBoundingClientRect();
    return indicators.left >= name.right && indicators.left - name.right < 16;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cordn:v1:channel-preferences"))).toContain("mute");

  await page.reload();
  await expect(page.getByRole("button", { name: "Enable channel sounds" })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cordn:v1:channel-preferences"))).toContain("mute");
});

async function navigateWithinShell(page: import("@playwright/test").Page, href: string): Promise<void> {
  await page.evaluate((nextHref) => {
    const target = new URL(nextHref, window.location.origin);
    window.history.pushState({}, "", `${target.pathname}${target.search}${target.hash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, href);
}

async function seedJoinedRoom(
  page: import("@playwright/test").Page,
  title: string,
  coordinatorPubkey = "a".repeat(64),
): Promise<void> {
  const privateFixture = createStoredRoomPrivateFixture();
  await page.evaluate(({ title, coordinatorPubkey, relayUrl, privateFixture }) => {
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const room = {
      version: 1,
      id,
      title,
      coordinatorPubkey,
      coordinatorOrigin: "https://remote.example",
      relayUrls: [relayUrl],
      name: "Reader",
      stablePubkey: "b".repeat(64),
      isHost: false,
      stateBase64: "",
      keyPackage: {
        reference: "ref",
        publicBase64: "public",
        privateBase64: privateFixture.keyPackagePrivateBase64,
      },
      anonymousSecretKey: privateFixture.anonymousSecretKey,
      lastCursor: 0,
      messages: [],
      pending: [],
      joinRequestSent: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const key = `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(id)}`;
    localStorage.setItem(key, JSON.stringify(room));
  }, { title, coordinatorPubkey, relayUrl: relay.url, privateFixture });
}

async function revealFullWorkspaceControls(page: import("@playwright/test").Page): Promise<void> {
  await seedJoinedRoom(page, "Workspace controls fixture", "9".repeat(64));
  await page.reload();
}

test("unread badge lifecycle projects exact room and coordinator counts", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const coordinatorPubkey = "a".repeat(64);
  await seedJoinedRoom(page, "Unread one", coordinatorPubkey);
  await seedJoinedRoom(page, "Unread two", coordinatorPubkey);
  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      const room = JSON.parse(localStorage.getItem(key) ?? "{}");
      room.readState = { version: 1, baselineEstablished: true, lastReadCursor: 0, unreadCount: room.title === "Unread one" ? 100 : 1 };
      localStorage.setItem(key, JSON.stringify(room));
    }
  });
  await page.reload();

  const rail = page.getByTestId("invite-panel");
  await expect(rail.getByRole("button", { name: /Open room Unread one/ })).toBeVisible();
  const unreadBadge = rail.getByLabel("100 unread messages");
  await expect(unreadBadge).toHaveText("99+");
  await expect(rail.getByLabel("101 unread messages for this coordinator")).toHaveText("99+");
  expect(await unreadBadge.evaluate((element) => ({
    tag: element.tagName,
    tabIndex: (element as HTMLElement).tabIndex,
    height: Math.round(element.getBoundingClientRect().height),
  }))).toEqual({ tag: "SPAN", tabIndex: -1, height: 16 });

  const targetRow = rail.locator(".channel-row").filter({ hasText: "Unread one" });
  const targetMenu = targetRow.getByRole("button", { name: "More actions for # Unread one" });
  await expect(page.locator(".channel-row.active")).toHaveCount(0);
  const urlBefore = page.url();
  await targetMenu.focus();
  await targetMenu.click();
  await expect(page).toHaveURL(urlBefore);
  await expect(page.locator(".channel-row.active")).toHaveCount(0);
  await expect(unreadBadge).toHaveText("99+");
  await page.keyboard.press("Escape");
  await expect(targetMenu).toBeFocused();
  await expect(unreadBadge).toHaveText("99+");
  expect(pageErrors).toEqual([]);
});

test("repairs replayed message ids before rendering cached production state", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await seedJoinedRoom(page, "Replay-safe room", "7".repeat(64));
  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      const room = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (room.title !== "Replay-safe room") continue;
      const message = {
        type: "message",
        id: "7a513fe44ec0d9fc66eb5f9e41bfaf1dc11430cb03fad357b034ffaa7101137a",
        sender: "8".repeat(64),
        name: "Replay sender",
        content: "render once",
        createdAt: Date.now(),
        cursor: 4,
      };
      room.messages = [message, { ...message }];
      localStorage.setItem(key, JSON.stringify(room));
    }
  });
  await page.reload();

  await page.getByRole("button", { name: /Open room Replay-safe room/ }).click();
  await expect(page.getByText("render once", { exact: true })).toHaveCount(1);
  expect(pageErrors.filter((message) => message.includes("each_key_duplicate"))).toEqual([]);
});

test("unread zero transition announces once from the page-level owner", async ({ page }) => {
  await page.goto("/");
  const coordinatorPubkey = "c".repeat(64);
  await seedJoinedRoom(page, "Announced room", coordinatorPubkey);
  await page.reload();
  await page.evaluate(({ coordinatorPubkey }) => {
    const roomId = "announced-room";
    window.dispatchEvent(new CustomEvent("cordn:room-unread-changed", {
      detail: { coordinatorPubkey, roomId, previousCount: 0, unreadCount: 1 },
    }));
  }, { coordinatorPubkey });
  const announcement = page.locator('[aria-live="polite"]').filter({ hasText: "New messages in # Announced room" });
  await expect(announcement).toHaveCount(1);
  await page.evaluate(({ coordinatorPubkey }) => {
    window.dispatchEvent(new CustomEvent("cordn:room-unread-changed", {
      detail: { coordinatorPubkey, roomId: "announced-room", previousCount: 1, unreadCount: 2 },
    }));
  }, { coordinatorPubkey });
  await expect(announcement).toHaveCount(1);
});

test("long room navigation stays operable and contained", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const coordinatorPubkey = "d".repeat(64);
  for (let index = 0; index < 24; index += 1) {
    await seedJoinedRoom(page, `Room ${String(index).padStart(2, "0")} ${"extremely-long-label-".repeat(3)}`, coordinatorPubkey);
  }
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    if (viewport.width <= 900) await page.getByRole("button", { name: "Open room browser" }).click();
    const rail = page.getByTestId("invite-panel");
    const remoteCard = rail.getByTestId("coordinator-card").filter({ hasText: "Coordinator dddddd" });
    await expect(remoteCard.locator(".channel-row")).toHaveCount(5);
    await remoteCard.getByRole("button", { name: "Show 19 more" }).click();
    await expect(remoteCard.locator(".channel-row")).toHaveCount(24);
    expect(await rail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const firstRow = remoteCard.locator(".channel-row").first();
    const label = firstRow.locator(".truncate");
    const action = firstRow.getByRole("button", { name: /More actions for/ });
    expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await Promise.all([label.boundingBox(), action.boundingBox()]).then(([labelBox, actionBox]) => Boolean(
      labelBox && actionBox && labelBox.x + labelBox.width <= actionBox.x,
    ))).toBe(true);
    await remoteCard.locator(".channel-row").last().scrollIntoViewIfNeeded();
    await expect(remoteCard.locator(".channel-row").last()).toBeVisible();
    await expectNoDocumentOverflow(page, viewport);
  }
});

test("coordinator cards keep stable order and collapse dead groups into history", async ({ page }) => {
  await page.goto("/");
  await seedJoinedRoom(page, "Active first", "b".repeat(64));
  await seedJoinedRoom(page, "Active second", "b".repeat(64));
  await seedJoinedRoom(page, "Rotated room", "c".repeat(64));
  await seedJoinedRoom(page, "Retired room", "d".repeat(64));
  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      const room = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (room.title === "Rotated room") room.isHost = true;
      if (room.title === "Retired room") room.membershipStatus = "retired";
      localStorage.setItem(key, JSON.stringify(room));
    }
  });
  await page.reload();

  const rail = page.getByTestId("invite-panel");
  const cards = rail.getByTestId("coordinator-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("My coordinator");
  const remote = cards.nth(1);
  await expect(remote.locator(".channel-row .truncate")).toHaveText(["Active first", "Active second"]);
  await expect(rail.getByRole("button", { name: "Create group" })).toHaveCount(1);

  const history = rail.getByTestId("sidebar-history");
  await expect(history.getByRole("button", { name: /History/ })).toHaveAttribute("aria-expanded", "false");
  await expect(history.getByText("Rotated room", { exact: true })).toHaveCount(0);
  await history.getByRole("button", { name: /History/ }).click();
  await expect(history).toContainText("Rotated room");
  await expect(history).toContainText("Coordinator key rotated");
  await expect(history).toContainText("Retired room");
  await expect(history).toContainText("Identity retired");

  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      const room = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (room.title === "Active first") room.updatedAt = Date.now() + 100_000;
      localStorage.setItem(key, JSON.stringify(room));
    }
  });
  await page.reload();
  await expect(page.getByTestId("coordinator-card").nth(1).locator(".channel-row .truncate")).toHaveText(["Active first", "Active second"]);

  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      const room = JSON.parse(localStorage.getItem(key) ?? "{}");
      room.membershipStatus = "retired";
      localStorage.setItem(key, JSON.stringify(room));
    }
  });
  await page.reload();
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.getByTestId("sidebar-history").getByRole("button", { name: /History 4/ })).toBeVisible();
});

test("generates copyable identity on first load", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("operator-shell")).toBeVisible();
  await expect(page.getByTestId("user-profile")).toContainText("anon");
  await expect(page.getByTestId("user-profile").locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await expect(page.getByTestId("startup-ascii-field")).toBeVisible();
  await expect(page.getByTestId("guided-start-state")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.getByTestId("coordinator-empty-state")).toBeHidden();
  await expect(page.getByTestId("status-badge")).toBeHidden();
  const settings = await openCoordinatorSettings(page);
  await expect(page.locator(".host-layout")).toHaveCSS("filter", "none");
  await expect(settings.getByRole("button", { name: "Copy coordinator public key" })).toContainText("npub");
  await expect(settings.getByLabel("Toggle announcement")).not.toBeChecked();
  await expect(settings.getByTestId("max-users-input")).toHaveValue("64");
  await closeCoordinatorSettings(settings);
});

test("startup recovery states stay truthful for empty recovery", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);

  await page.getByRole("button", { name: "Start", exact: true }).click();

  const startup = page.getByTestId("startup-progress-panel");
  await expect(startup).toContainText("Restoring rooms");
  await expect(startup).toContainText("No rooms to restore");
  await expect(startup).toContainText("0 of 0 rooms restored");
  await expect(page.getByTestId("host-message-list")).toHaveCount(0);
  await expect(page.getByTestId("status-badge")).toBeHidden();
  await expect(page.getByTestId("coordinator-empty-content")).toContainText("Ready for your first room");
  await expect(page.getByRole("button", { name: "Create room", exact: true })).toBeVisible();
});

test("running coordinator with no local rooms keeps setup quiet while preserving saved chats", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await seedJoinedRoom(page, "Saved elsewhere", "e".repeat(64));
  await page.reload();

  await startCoordinator(page);
  await expectGuidedCoordinatorOnline(page);
  const savedChats = page.getByRole("button", { name: "Open saved chats" });
  await expect(savedChats).toBeVisible();

  await savedChats.click();
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.locator(".channel-row").filter({ hasText: "Saved elsewhere" })).toBeVisible();
});

test("does not render disconnected local chat during recovery", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);

  await page.getByRole("button", { name: "Start", exact: true }).click();

  const startup = page.getByTestId("startup-progress-panel");
  await expect(startup).toContainText("No rooms to restore", { timeout: 20_000 });
  await expect(page.getByTestId("host-message-list")).toHaveCount(0);
  await expect(page.getByText("Local room offline", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/MCP error|relay timeout|wss:\/\//i).filter({ visible: true })).toHaveCount(0);
});

test("startup signal follows retry and exhaustion truth", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await enablePersistence(page, "multi-room-recovery-passphrase");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(page, "Recovery alpha");
  await createRoom(page, "Recovery bravo");
  await expect(page.getByTestId("status-badge")).toHaveText("running");

  const fixture = await page.evaluate(() => {
    const entries: Array<{ key: string; raw: string; room: { coordinatorPubkey: string; id: string; title: string; stablePubkey: string } }> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const room = JSON.parse(raw) as { coordinatorPubkey?: string; id?: string; title?: string; stablePubkey?: string; isHost?: boolean };
      if (!room.isHost || !room.coordinatorPubkey || !room.id || !room.title || !room.stablePubkey) continue;
      entries.push({ key, raw, room: room as { coordinatorPubkey: string; id: string; title: string; stablePubkey: string } });
    }
    entries.sort((left, right) => `${left.room.coordinatorPubkey}:${left.room.id}`.localeCompare(`${right.room.coordinatorPubkey}:${right.room.id}`));
    if (entries.length !== 2) throw new Error(`Expected two hosted rooms, found ${entries.length}`);
    const target = entries[1]!;
    const corrupted = JSON.parse(target.raw) as { stablePubkey: string };
    corrupted.stablePubkey = corrupted.stablePubkey === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    return {
      key: target.key,
      validRaw: target.raw,
      corruptedRaw: JSON.stringify(corrupted),
      roomName: target.room.title,
      forbiddenStablePubkey: corrupted.stablePubkey,
      rooms: entries.map((entry) => ({
        key: entry.key,
        id: entry.room.id,
        title: entry.room.title,
        coordinatorPubkey: entry.room.coordinatorPubkey,
        stablePubkey: entry.room.stablePubkey,
      })),
    };
  });
  expect(new Set(fixture.rooms.map((room) => `${room.coordinatorPubkey}:${room.id}`)).size).toBe(2);
  expect(new Set(fixture.rooms.map((room) => room.coordinatorPubkey)).size).toBe(1);
  expect(new Set(fixture.rooms.map((room) => room.stablePubkey)).size).toBe(1);

  await page.reload();
  await page.getByPlaceholder("passphrase", { exact: true }).fill("multi-room-recovery-passphrase");
  await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();
  const roomsAfterUnlock = await page.evaluate(() => {
    const rooms: Array<{ key: string; id?: string; title?: string; coordinatorPubkey?: string; stablePubkey?: string; isHost?: boolean; membershipStatus?: string }> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:")) continue;
      const raw = localStorage.getItem(key);
      if (raw) rooms.push({ key, ...JSON.parse(raw) });
    }
    return rooms;
  });
  expect(roomsAfterUnlock.map((room) => ({
    id: room.id,
    title: room.title,
    coordinatorPubkey: room.coordinatorPubkey,
    stablePubkey: room.stablePubkey,
    isHost: room.isHost,
    membershipStatus: room.membershipStatus,
  }))).toEqual(expect.arrayContaining(fixture.rooms.map((room) => expect.objectContaining({
    id: room.id,
    title: room.title,
    coordinatorPubkey: room.coordinatorPubkey,
    isHost: true,
  }))));
  await page.evaluate(({ key, corruptedRaw }) => localStorage.setItem(key, corruptedRaw), fixture);
  await page.evaluate(() => {
    type RecoverySnapshot = { state: string; completed: number; total: number; retryActions: number };
    const target = window as unknown as { __recoveryHistory: RecoverySnapshot[] };
    target.__recoveryHistory = [];
    const capture = () => {
      const panel = document.querySelector<HTMLElement>('[data-testid="startup-progress-panel"]');
      if (!panel) return;
      const state = panel.dataset.recoveryState ?? "";
      const completed = Number(panel.dataset.recoveryCompleted ?? "0");
      const total = Number(panel.dataset.recoveryTotal ?? "0");
      const retryActions = Array.from(panel.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "Retry recovery").length;
      const next = { state, completed, total, retryActions };
      const previous = target.__recoveryHistory.at(-1);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) target.__recoveryHistory.push(next);
    };
    new MutationObserver(capture).observe(document.body, { subtree: true, childList: true, attributes: true });
    capture();
  });

  await page.getByRole("button", { name: "Start", exact: true }).click();
  const startup = page.getByTestId("startup-progress-panel");
  await expect(startup).toHaveAttribute("data-recovery-total", "2");
  await expect(startup).toHaveAttribute("data-recovery-state", "retrying");
  await expect(page.getByTestId("startup-ascii-field")).toHaveAttribute("data-motion-state", "retrying");
  expect(await page.getByTestId("startup-ascii-field").locator(".ripple-traces .ripple-contour").first().evaluate((element) => (
    getComputedStyle(element).stroke
  ))).toBe("rgb(124, 245, 157)");
  await expect(page.getByRole("button", { name: "Retry recovery" })).toHaveCount(0);
  await expect(startup).toHaveAttribute("data-recovery-state", "exhausted");
  await expect(page.getByTestId("startup-ascii-field")).toHaveAttribute("data-motion-state", "exhausted");
  await expectStartupFieldStatic(page.getByTestId("startup-ascii-field"));
  await expect(startup).toHaveAttribute("data-recovery-completed", "1");
  await expect(startup).toContainText(`Couldn’t restore # ${fixture.roomName}`);
  await expect(startup).toContainText("Check your connection, then retry recovery.");
  await expect(page.getByRole("button", { name: "Retry recovery" })).toHaveCount(1);
  await expect(page.getByTestId("status-badge")).toHaveText("starting");
  await expect(page.getByTestId("host-message-list")).toHaveCount(0);
  await expect(page.getByTestId("room-connection-panel")).toHaveCount(0);
  await expect(page.getByText("Local room offline", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[placeholder="Message as host"]')).toHaveCount(0);
  const renderedText = await page.locator("body").innerText();
  expect(renderedText).not.toContain(fixture.forbiddenStablePubkey);
  expect(renderedText).not.toMatch(/signer does not match|MCP error|Hosted room recovery failed|wss:\/\//i);

  const automaticHistory = await page.evaluate(() => (
    window as unknown as { __recoveryHistory: Array<{ state: string; completed: number; total: number; retryActions: number }> }
  ).__recoveryHistory.filter((snapshot) => snapshot.total === 2));
  expect(automaticHistory.some((snapshot) => snapshot.state === "retrying" && snapshot.retryActions === 0)).toBe(true);
  expect(automaticHistory.at(-1)).toMatchObject({ state: "exhausted", completed: 1, total: 2 });
  expect(automaticHistory.every((snapshot, index) => index === 0 || snapshot.completed >= automaticHistory[index - 1]!.completed)).toBe(true);

  await page.evaluate(({ key, validRaw }) => localStorage.setItem(key, validRaw), fixture);
  await page.getByRole("button", { name: "Retry recovery" }).click();
  await expect(page.getByTestId("status-badge")).toHaveText("running");
  await expect(page.getByTestId("host-message-list")).toBeVisible();
  await expect(page.getByText("Local room offline", { exact: true })).toHaveCount(0);
  const completedHistory = await page.evaluate(() => (
    window as unknown as { __recoveryHistory: Array<{ state: string; completed: number; total: number }> }
  ).__recoveryHistory.filter((snapshot) => snapshot.total === 2));
  expect(completedHistory.some((snapshot) => snapshot.state === "restoring" && snapshot.completed === 1)).toBe(true);
  expect(completedHistory.some((snapshot) => snapshot.state === "complete" && snapshot.completed === 2)).toBe(true);
});

test("an unrecoverable hosted room can be confirmed, deleted, and removed from the startup queue", async ({ page }) => {
  test.setTimeout(60_000);
  const passphrase = "delete-failed-recovery-passphrase";
  const roomTitle = "Unrecoverable room";
  await page.goto("/");
  await enablePersistence(page, passphrase);
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(page, roomTitle);
  await expect(page.getByTestId("status-badge")).toHaveText("running");

  const fixture = await page.evaluate((expectedTitle) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const stored = JSON.parse(raw) as {
        id?: string;
        title?: string;
        coordinatorPubkey?: string;
        stablePubkey?: string;
        isHost?: boolean;
      };
      if (!stored.isHost || stored.title !== expectedTitle || !stored.id || !stored.coordinatorPubkey || !stored.stablePubkey) continue;
      stored.stablePubkey = stored.stablePubkey === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      return { key, corruptedRaw: JSON.stringify(stored), roomId: stored.id, coordinatorPubkey: stored.coordinatorPubkey };
    }
    throw new Error(`Could not find hosted room ${expectedTitle}`);
  }, roomTitle);

  await page.reload();
  await page.getByPlaceholder("passphrase", { exact: true }).fill(passphrase);
  await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();
  await page.evaluate(({ key, corruptedRaw }) => localStorage.setItem(key, corruptedRaw), fixture);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  const startup = page.getByTestId("startup-progress-panel");
  await expect(startup).toHaveAttribute("data-recovery-state", "exhausted");
  await expect(startup).toContainText(`Couldn’t restore # ${roomTitle}`);
  await expect(page.getByRole("button", { name: "Retry recovery" })).toBeVisible();
  await page.getByRole("button", { name: "Delete failed room" }).click();

  const dialog = page.getByTestId("room-removal-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: `Delete #${roomTitle}?` })).toBeVisible();
  await expect(dialog.getByTestId("room-removal-impact")).toContainText("This cannot be undone.");
  await dialog.getByTestId("confirm-delete-room").click();

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("status-badge")).toBeHidden();
  await expect(page.getByRole("button", { name: "Delete failed room" })).toHaveCount(0);
  await expect(page.getByTestId("coordinator-empty-content")).toContainText("Ready for your first room");
  await expect(page.getByTestId("host-message-list")).toHaveCount(0);
  await expect(page.getByText("Local room offline", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), fixture)).toBeNull();
});

test("browses joined chats from the root shell without starting an unprotected local coordinator", async ({ page }) => {
  await page.goto("/");
  await seedJoinedRoom(page, "Elsewhere lounge");
  await page.reload();

  await expect(page.getByTestId("status-badge")).toHaveText("idle");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  await expect(page.getByTestId("workspace-navigation")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Open room Elsewhere lounge/ })).toBeVisible();
});

test("browses cached chats while a persisted coordinator stays locked", async ({ page }) => {
  await page.goto("/");
  await enablePersistence(page, "chat-only-passphrase");
  await seedJoinedRoom(page, "Locked-out lounge", "c".repeat(64));
  await page.reload();

  await expect(page.getByRole("heading", { name: "Unlock Cordn Ad-Hoc" })).toBeVisible();
  await expect(page.getByTestId("operator-shell")).toHaveCount(0);
  await page.getByRole("button", { name: "Open chats" }).click();
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  await expect(page.getByTestId("workspace-navigation")).toHaveCount(1);
  await page.getByRole("button", { name: /Open room Locked-out lounge/ }).click();
  await expect(page.getByTestId("cached-room-view")).toContainText("Locked-out lounge");
  await expect(page.locator(".presence-control")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 667 });
  await expect.poll(() => page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".workspace-nav");
    const visibleControls = [...(header?.querySelectorAll<HTMLElement>("button, a") ?? [])]
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      });
    return {
      pageFits: document.documentElement.scrollWidth === document.documentElement.clientWidth,
      headerFits: Boolean(header && header.scrollWidth <= header.clientWidth),
      controlsFit: visibleControls.every(Boolean),
    };
  })).toEqual({ pageFits: true, headerFits: true, controlsFit: true });

  await page.getByRole("link", { name: "CAHMLS home" }).click();
  await expect(page.getByRole("heading", { name: "Unlock Cordn Ad-Hoc" })).toBeVisible();
});

test("legacy chat index canonicalizes to the root shell and honors autostart", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  const settings = await openCoordinatorSettings(page, true);
  await settings.getByLabel("Toggle autostart").check();
  await closeCoordinatorSettings(settings);

  await page.setViewportSize({ width: 390, height: 667 });
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  await expect(page.getByTestId("workspace-navigation")).toHaveCount(1);
  await expectGuidedCoordinatorOnline(page);
  await expect(page.getByRole("button", { name: "Create room", exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => ({
      viewport: document.documentElement.clientHeight,
      page: document.documentElement.scrollHeight,
      body: document.body.scrollHeight,
    })))
    .toEqual({ viewport: 667, page: 667, body: 667 });
});

test("offers a NIP-46 nostrconnect QR through the default Coracle relay", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("user-profile").getByRole("button").first().click();
  const profile = page.getByRole("dialog", { name: "User profile" });
  await profile.getByRole("button", { name: /NIP-46 remote signer/ }).click();

  const connection = profile.getByTestId("nip46-qr-connect");
  await expect(connection.getByAltText("QR code for NIP-46 signer connection")).toHaveAttribute("src", /^data:image\/svg\+xml/);
  const uri = await connection.getByRole("link", { name: "Open NIP-46 connection in a signer" }).getAttribute("href");
  expect(uri).toMatch(/^nostrconnect:\/\//);
  expect(new URL(uri ?? "").searchParams.getAll("relay")).toContain("wss://bucket.coracle.social");

  await connection.getByRole("button", { name: "Cancel" }).click();
  await expect(connection).toBeHidden();
});

test("Notification settings keeps permission explicit and persists grouped notification preferences", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { __notificationPermissionRequests?: number };
    state.__notificationPermissionRequests = 0;
    class MockNotification {
      static permission: NotificationPermission = localStorage.getItem("e2e:notification-permission") === "granted" ? "granted" : "default";
      static async requestPermission(): Promise<NotificationPermission> {
        state.__notificationPermissionRequests = (state.__notificationPermissionRequests ?? 0) + 1;
        MockNotification.permission = "granted";
        localStorage.setItem("e2e:notification-permission", "granted");
        return "granted";
      }
      onclick: ((event: Event) => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        void title;
        void options;
      }
      close(): void {}
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: MockNotification });
  });
  await page.goto("/");
  await revealFullWorkspaceControls(page);

  expect(await page.evaluate(() => (window as typeof window & { __notificationPermissionRequests?: number }).__notificationPermissionRequests)).toBe(0);
  await page.getByRole("button", { name: "Notification settings", exact: true }).click();
  const notifications = page.getByRole("dialog", { name: "Notification settings" });
  await expect(notifications).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __notificationPermissionRequests?: number }).__notificationPermissionRequests)).toBe(0);
  await notifications.getByRole("button", { name: "Enable desktop notifications", exact: true }).click();
  expect(await page.evaluate(() => (window as typeof window & { __notificationPermissionRequests?: number }).__notificationPermissionRequests)).toBe(1);
  await expect(notifications.getByRole("checkbox", { name: /People coming online/ })).toBeChecked();
  await expect(notifications.getByRole("checkbox", { name: /New messages/ })).not.toBeChecked();
  await notifications.getByRole("checkbox", { name: /New messages/ }).check();
  await notifications.getByRole("combobox").selectOption("30000");
  await notifications.getByRole("button", { name: "Close notification settings" }).click();

  await page.reload();
  await page.getByRole("button", { name: "Notification settings", exact: true }).click();
  const reloaded = page.getByRole("dialog", { name: "Notification settings" });
  await expect(reloaded.getByRole("checkbox", { name: /New messages/ })).toBeChecked();
  await expect(reloaded.getByRole("combobox")).toHaveValue("30000");
});

test("host administration edits message badge", async ({ page }) => {
  await page.goto("/");
  const settings = await openCoordinatorSettings(page, true);

  await settings.getByLabel("Badge text").fill("guide");
  await settings.getByRole("button", { name: "Choose badge emoji" }).click();
  await settings.getByRole("button", { name: "Use 🦉 for badge" }).click();
  await expect(settings.getByTestId("host-message-identity-preview")).toContainText("🦉");
  await expect(settings.getByTestId("host-message-identity-preview")).toContainText("guide");
  await closeCoordinatorSettings(settings);

  const reopened = await openCoordinatorSettings(page, true);
  await expect(reopened.getByLabel("Badge text")).toHaveValue("guide");
  await closeCoordinatorSettings(reopened);
});

test("personal profile omits host badge editor", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByTestId("user-profile").locator(".user-trigger");
  await trigger.click();
  const profile = page.getByRole("dialog", { name: "User profile" });

  await expect(profile.getByLabel("Badge text")).toHaveCount(0);
  await expect(profile.getByRole("button", { name: "Choose badge emoji" })).toHaveCount(0);
});

test("personal and host controls have one owner", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await revealFullWorkspaceControls(page);

  const rail = page.getByTestId("invite-panel");
  const personal = rail.getByRole("group", { name: "Personal controls" });
  const host = rail.getByRole("group", { name: "Coordinator controls" });
  await expect(personal).toBeVisible();
  await expect(host).toBeVisible();
  await expect(personal.getByRole("button", { name: /Open profile for/ })).toHaveCount(1);
  await expect(personal.getByRole("button", { name: /^Presence:/ })).toHaveCount(1);
  await expect(personal.getByRole("button", { name: "Notifications, no unread" })).toHaveCount(1);
  await expect(personal.getByRole("button", { name: "Notification settings", exact: true })).toHaveCount(1);
  await expect(host.getByRole("button", { name: /^Settings for / })).toHaveCount(1);
  await expect(page.locator(".host-topbar").getByRole("button", { name: "Open management interface" })).toHaveCount(1);
  await expect(page.getByTestId("header-message-rate")).toBeVisible();
  await expect(page.getByTestId("resource-monitor")).toHaveCount(0);
  await expect(page.getByTestId("active-server-context")).toHaveCount(0);
  await expect(page.getByTestId("chat-connection-status")).toHaveCount(0);
  await expect(rail.locator(".presence-control")).toHaveCount(1);
});

test("compact room browser owns contextual controls", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 520 });
  await page.goto("/");
  await revealFullWorkspaceControls(page);

  const commandbar = page.locator(".host-commandbar");
  await expect(commandbar.getByRole("button", { name: "Open room browser" })).toHaveCount(1);
  await expect(commandbar.getByRole("button", { name: "Notification settings", exact: true })).toHaveCount(0);
  await expect(commandbar.getByRole("button", { name: /^Settings for / })).toHaveCount(0);
  await commandbar.getByRole("button", { name: "Open room browser" }).click();
  const rail = page.getByTestId("invite-panel");
  await expect(rail.getByRole("group", { name: "Personal controls" })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Presence:/ })).toBeVisible();
  await expect(rail.getByRole("group", { name: "Coordinator controls" })).toBeVisible();
});

test("compact sidebar places invite first and personal controls last", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await revealFullWorkspaceControls(page);
  await page.getByRole("button", { name: "Open room browser" }).click();

  const rail = page.getByTestId("invite-panel");
  await expect(rail.getByRole("button", { name: "Join from invite" })).toBeVisible();
  expect(await rail.evaluate((element) => {
    const invite = element.querySelector(".rail-join");
    const account = element.querySelector(".sidebar-account");
    return Boolean(invite && account && (invite.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
});

test("notification feed accepts trusted invite only from live state", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cordn:v1:notification-feed", JSON.stringify({
      version: 1,
      entries: [{
        id: "room_invite:trusted-invite",
        category: "room_invite",
        key: "trusted-invite",
        actor: "Mara",
        room: "Gathering",
        createdAt: Date.now(),
        occurrences: 1,
        read: false,
      }],
    }));
  });
  await page.goto("/");
  await revealFullWorkspaceControls(page);

  const bell = page.getByRole("button", { name: "Notifications, 1 unread" });
  const feedTrigger = page.getByTestId("notification-feed-trigger");
  const viewport = page.viewportSize();
  await expect(bell).toBeVisible();
  await bell.click();
  const feed = page.getByRole("dialog", { name: "Notifications" });
  await expect.poll(async () => {
    const trigger = await feedTrigger.boundingBox();
    const panel = await feed.boundingBox();
    return Boolean(trigger && panel
      && panel.x >= 0
      && panel.x + panel.width <= (viewport?.width ?? 0)
      && panel.y >= 0
      && panel.y + panel.height <= trigger.y);
  }).toBe(true);
  await expect(feed.getByText("Room invitation")).toBeVisible();
  await expect(feed.getByText("Gathering")).toBeVisible();
  await expect(feed.getByText("From Mara")).toBeVisible();
  await expect(feed.getByText("Invitation unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Notifications, no unread" })).toBeVisible();
});

test("notification feed clears all history without resolving invitations", async ({ page }) => {
  await page.goto("/");
  await revealFullWorkspaceControls(page);
  await page.evaluate(() => {
    localStorage.setItem("cordn:v1:notification-feed", JSON.stringify({
      version: 1,
      entries: [
        { id: "room_invite:keep-live", category: "room_invite", key: "keep-live", actor: "Mara", room: "Gathering", createdAt: Date.now(), occurrences: 1, read: false },
        { id: "new_message:message-1", category: "new_message", key: "message-1", actor: "Jo", room: "Lobby", createdAt: Date.now() - 1, occurrences: 1, read: false },
      ],
    }));
  });
  await page.reload();

  await page.getByRole("button", { name: "Notifications, 2 unread" }).click();
  const feed = page.getByRole("dialog", { name: "Notifications" });
  await feed.getByRole("button", { name: "Clear all", exact: true }).click();

  await expect(feed.getByText("No personal activity")).toBeVisible();
  await expect(feed.getByRole("button", { name: "Clear all", exact: true })).toBeDisabled();
  await expect(feed.getByRole("status")).toHaveText("All notifications cleared.");
  await expect(page.getByRole("button", { name: "Notifications, no unread" })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cordn:v1:notification-feed") ?? "null"))).toEqual({ version: 1, entries: [] });
  expect(await page.evaluate(() => localStorage.getItem("cordn:v1:notification-resolutions"))).toBeNull();

  await page.reload();
  await page.getByRole("button", { name: "Notifications, no unread" }).click();
  await expect(page.getByRole("dialog", { name: "Notifications" }).getByText("No personal activity")).toBeVisible();
});

test("compact notification feed and Notification settings stay viewport-bound", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await page.addInitScript(() => {
    localStorage.setItem("cordn:v1:notification-feed", JSON.stringify({
      version: 1,
      entries: [{
        id: "user_online:Mara",
        category: "user_online",
        key: "Mara",
        actor: "Mara",
        createdAt: Date.now(),
        occurrences: 1,
        read: false,
      }],
    }));
  });
  await page.goto("/");
  await revealFullWorkspaceControls(page);
  await page.getByRole("button", { name: "Open room browser" }).click();

  const bell = page.getByRole("button", { name: "Notifications, 1 unread" });
  await bell.click();
  const feed = page.getByRole("dialog", { name: "Notifications" });
  await expect(feed).toHaveAttribute("data-viewport-overlay", "true");
  await expect.poll(() => feed.evaluate((element) => element.matches(":popover-open"))).toBe(true);
  await expectInsideViewport(feed);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Notifications, no unread" })).toBeFocused();

  const settings = page.getByRole("button", { name: "Notification settings", exact: true });
  await settings.click();
  const settingsSheet = page.getByRole("dialog", { name: "Notification settings" });
  await expect(settingsSheet).toHaveAttribute("data-viewport-overlay", "true");
  await expect.poll(() => settingsSheet.evaluate((element) => element.matches(":popover-open"))).toBe(true);
  await expectInsideViewport(settingsSheet);
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await expectNoDocumentOverflow(page, { width: 390, height: 520 });
});

test("centers the compact CAHMLS brand cluster with equal spacing", async ({ page }) => {
  const brandGeometry = async () => page.getByRole("link", { name: "CAHMLS home" }).evaluate((brand) => {
    const rectangle = (selector: string) => {
      const element = brand.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing brand child: ${selector}`);
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
      return { top, right, bottom, left, width, height, centerY: top + height / 2 };
    };
    const camel = rectangle(":scope > .brand-camel");
    const dot = rectangle(":scope > .brand-status-dot");
    const wordmark = rectangle(":scope > .brand-wordmark");
    const brandBounds = brand.getBoundingClientRect();
    const headerBounds = document.querySelector<HTMLElement>(".host-topbar")?.getBoundingClientRect();
    return {
      camel,
      dot,
      wordmark,
      camelToDotGap: dot.left - camel.right,
      dotToWordmarkGap: wordmark.left - dot.right,
      camelToDotCenterDelta: Math.abs(camel.centerY - dot.centerY),
      dotToWordmarkCenterDelta: Math.abs(dot.centerY - wordmark.centerY),
      brandInsideHeader: Boolean(headerBounds
        && brandBounds.left >= headerBounds.left
        && brandBounds.right <= headerBounds.right
        && brandBounds.top >= headerBounds.top
        && brandBounds.bottom <= headerBounds.bottom),
    };
  });

  for (const viewport of [
    { width: 390, height: 667 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const home = page.getByRole("link", { name: "CAHMLS home" });
    const tooltip = home.getByRole("tooltip");
    await expect(home).toBeVisible();
    const initial = await brandGeometry();
    expect(Math.abs(initial.camelToDotGap - initial.dotToWordmarkGap)).toBeLessThanOrEqual(1);
    expect(initial.camelToDotCenterDelta).toBeLessThanOrEqual(1);
    expect(initial.dotToWordmarkCenterDelta).toBeLessThanOrEqual(1);
    expect(initial.brandInsideHeader).toBe(true);

    await home.hover();
    await expect(tooltip).toHaveCSS("opacity", "1");
    expect(await brandGeometry()).toEqual(initial);

    await home.focus();
    await expect(home).toBeFocused();
    await expect(tooltip).toHaveCSS("opacity", "1");
    expect(await brandGeometry()).toEqual(initial);

    for (const control of await page.locator(".host-topbar a:visible, .host-topbar button:visible").all()) {
      await expectInsideViewport(control);
    }
    if (viewport.width === 390) await expectNoDocumentOverflow(page, viewport);
  }
});

test("operator shell does not overflow common viewports", async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 390, height: 350 },
    { width: 568, height: 320 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    await expect(page.getByTestId("operator-shell")).toBeVisible();
    await expect.poll(() => page.getByTestId("operator-shell").evaluate((element) => element.clientHeight)).toBe(viewport.height);
    await expect
      .poll(() =>
        page.getByTestId("operator-shell").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, width: bounds.width };
        }),
      )
      .toEqual({ left: 0, right: viewport.width, width: viewport.width });
    await expectNoDocumentOverflow(page, viewport);
    if (viewport.width <= 900) {
      await expect.poll(() => page.locator(".host-topbar").evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeLessThanOrEqual(112);
      await expect.poll(() => page.getByTestId("host-chat").evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThan(100);
      for (const control of await page.locator(".host-topbar button:visible, .host-topbar a:visible").all()) {
        await expectInsideViewport(control);
      }
    }
  }
});

test("names the coordinator context without changing its runtime", async ({ page }) => {
  await page.goto("/");
  const settings = await openCoordinatorSettings(page, true);
  await settings.getByLabel("Coordinator name").fill("Madeira node");
  await settings.getByRole("button", { name: "Save coordinator name" }).click();
  await expect(settings.getByLabel("Coordinator name")).toHaveValue("Madeira node");
  await closeCoordinatorSettings(settings);

  await expect(page.getByTestId("active-server-context")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Madeira node" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Server and channel browser" })).toContainText("Madeira node");
  await revealFullWorkspaceControls(page);
  await expect(page.getByRole("navigation", { name: "Server and channel browser" })).toContainText("Madeira node");
  await page.getByRole("button", { name: "Open management interface" }).click();
  await expect(page.getByRole("navigation", { name: "Server and channel browser" })).toContainText("Madeira node");
  await expect(page.getByTestId("status-badge")).toHaveText("idle");
});

test("starts, locks relay configuration, and stops", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  const initialSettings = await openCoordinatorSettings(page, true);
  await initialSettings.getByLabel("Toggle announcement").check();
  await initialSettings.getByTestId("max-users-input").fill("32");
  await initialSettings.getByTestId("max-users-input").blur();
  await expect(initialSettings.getByTestId("max-users-state")).toContainText("32 key packages / identity");
  await closeCoordinatorSettings(initialSettings);
  expect(await pageExitIsGuarded(page)).toBe(false);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  const startup = page.getByTestId("startup-progress-panel");
  await expect(startup).toBeVisible();
  await expect(startup.getByTestId("startup-current-status")).toContainText(/checking|opening|preparing|connecting/i);
  await expect(startup.getByRole("progressbar", { name: "Coordinator startup progress" })).toHaveAttribute(
    "aria-valuenow",
    /^(20|40|60|80)$/,
  );
  await expect(startup.getByRole("status")).toContainText(/identity|room|MLS|relay|coordinator/i);
  await expect(startup.getByRole("button", { name: "Review settings" })).toBeVisible();
  await expect(page.getByText("Starting", { exact: true })).toHaveCount(0);
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Runtime controls");
  await expect(page.getByTestId("status-badge")).toHaveText("running", { timeout: 20_000 });
  expect(await pageExitIsGuarded(page)).toBe(true);
  await expect(page.getByTestId("status-badge")).toHaveText("running");
  await expect(page.getByTestId("server-online-notice")).toBeVisible();
  await expect(page.getByTestId("host-chat")).toBeVisible();
  await expect(page.getByText("My coordinator", { exact: true })).toHaveCount(2);
  await expect(page.getByTestId("coordinator-runtime-card")).toContainText(/\d+ relay paths?/);
  await expect(page.getByRole("button", { name: /Open room Runtime controls/ })).toBeVisible();
  expect(await page.getByTestId("invite-panel").evaluate((rail) => {
    const selectors = [".rail-join", ".coordinator-runtime-card", ".room-tools", ".coordinator-card-list", ".sidebar-account"];
    const elements = selectors.map((selector) => rail.querySelector(selector));
    return elements.every(Boolean) && elements.every((element, index) => index === 0
      || Boolean(elements[index - 1]!.compareDocumentPosition(element!) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
  await expect(page.getByRole("button", { name: "Rooms", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await page.getByRole("button", { name: "Open management interface" }).click();
  await expect(page.getByTestId("management-interface")).toBeVisible();
  await expect(page.getByTestId("host-chat")).toBeHidden();
  const channelBrowser = page.getByRole("navigation", { name: "Server and channel browser" });
  await expect(channelBrowser.getByTestId("coordinator-card").first()).toContainText("My coordinator");
  const runningSettings = await openCoordinatorSettings(page, true);
  await runningSettings.getByTestId("max-users-input").fill("33");
  await runningSettings.getByTestId("max-users-input").blur();
  await expect(runningSettings.getByTestId("restart-required")).toBeVisible();
  await runningSettings.getByRole("button", { name: "Done editing" }).click();
  await runningSettings.getByRole("button", { name: "Restart to apply" }).click();
  await expect(page.getByTestId("status-badge")).toHaveText("running", { timeout: 20_000 });
  await expect(runningSettings.getByTestId("restart-required")).toBeHidden();
  await closeCoordinatorSettings(runningSettings);
  await expect(page.getByTestId("resource-monitor")).toHaveCount(0);
  await expect(page.getByTestId("header-message-rate")).toContainText(/\d+/);
  await expect(page.getByRole("log", { name: "Coordinator activity" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close management interface" })).toHaveText("Host");
  await page.getByRole("button", { name: "Close management interface" }).click();
  await expect(page.getByTestId("management-interface")).toBeHidden();
  await expect(page.getByTestId("host-chat")).toBeVisible();

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("status-badge")).toHaveText("idle");
  expect(await pageExitIsGuarded(page)).toBe(false);
  await expect(page.getByTestId("resource-monitor")).toHaveCount(0);

  await startCoordinator(page);
  await expect(page.getByTestId("status-badge")).toHaveText("running", { timeout: 20_000 });
  await expect(page.getByTestId("host-chat")).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("status-badge")).toHaveText("idle");
});

test("separates the coordinator runtime from the selected room connection", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Status room");
  await expect(page.getByTestId("coordinator-runtime-status")).toHaveText(/Coordinator\s*running/);
  const channelBrowser = page.getByRole("navigation", { name: "Server and channel browser" });
  await expect(channelBrowser).not.toContainText(/\brunning\b/i);
  await expect(page.getByTestId("coordinator-runtime-card")).toContainText(/\d+ relay paths?/);

  await page.getByRole("button", { name: "Open management interface" }).click();
  const summary = page.getByTestId("management-summary");
  await expect(summary.locator(":scope > div")).toHaveCount(3);
  await page.getByRole("button", { name: "Close management interface" }).click();

  await expect(page.getByTestId("chat-connection-status")).toHaveCount(0);
});

test("keeps live startup status and progress inside a short mobile viewport", async ({ page }) => {
  const viewport = { width: 390, height: 350 };
  await page.setViewportSize(viewport);
  await page.goto("/");
  await configureMockRelay(page);

  await startCoordinator(page);
  const panel = page.getByTestId("startup-progress-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("progressbar", { name: "Coordinator startup progress" })).toBeVisible();
  await expect(panel.getByRole("status")).not.toHaveText("");
  await expectStartupCompactVisualContract(page);
  await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "true");
  expect(await page.getByTestId("invite-panel").evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await expect.poll(() => page.getByTestId("invite-panel").evaluate((element) => Math.round(element.getBoundingClientRect().right))).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".startup-stage")?.getBoundingClientRect();
    const progress = document.querySelector<HTMLElement>('[data-testid="startup-progress-panel"]')?.getBoundingClientRect();
    return {
      viewport: document.documentElement.clientHeight,
      page: document.documentElement.scrollHeight,
      body: document.body.scrollHeight,
      panelInsideStage: Boolean(stage && progress && progress.top >= stage.top && progress.bottom <= stage.bottom),
    };
  })).toEqual({
    viewport: viewport.height,
    page: viewport.height,
    body: viewport.height,
    panelInsideStage: true,
  });

  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Compact startup room");
  await stopCoordinator(page);
  await expect(page.getByTestId("status-badge")).toHaveText("idle");
});

test("uses the full viewport for the live host workspace on desktop and mobile", async ({ page }) => {
  test.setTimeout(75_000);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 320, height: 568 },
    { width: 568, height: 320 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await configureMockRelay(page);
    await startCoordinator(page);
    if (viewport.width === 1440) {
      await expectGuidedCoordinatorOnline(page);
      await createRoom(page, `Viewport ${viewport.width}x${viewport.height}`);
    } else {
      await expectGuidedCoordinatorOnline(page);
      const invitePanel = page.getByTestId("invite-panel");
      if (await invitePanel.getAttribute("aria-hidden") === "false") {
        await page.getByRole("button", { name: "Close room browser" }).first().click();
      }
      await expect.poll(() => invitePanel.evaluate((element) => Math.round(element.getBoundingClientRect().right)))
        .toBeLessThanOrEqual(1);
      await createRoom(page, `Viewport ${viewport.width}x${viewport.height}`);
    }
    await expect(page.getByTestId("host-chat")).toBeVisible();
    await expect.poll(() => page.getByTestId("operator-shell").evaluate((element) => element.clientHeight)).toBe(viewport.height);
    await expect.poll(() => page.locator(".host-layout").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(viewport.width);
    await expectNoDocumentOverflow(page, viewport);
    const hostColumns = await page.locator(".host-layout").evaluate((layout) => {
      const rail = layout.querySelector<HTMLElement>(".host-rail")!.getBoundingClientRect();
      const chat = layout.querySelector<HTMLElement>(".host-chat")!.getBoundingClientRect();
      return {
        railLeft: Math.round(rail.left),
        railRight: Math.round(rail.right),
        railWidth: Math.round(rail.width),
        chatWidth: Math.round(chat.width),
        chatHeight: Math.round(chat.height),
        combinedWidth: Math.round(rail.width + chat.width),
        stacked: Math.round(rail.top) !== Math.round(chat.top),
      };
    });
    if (viewport.width > 900) {
      expect(hostColumns.stacked).toBe(false);
      expect(hostColumns.combinedWidth).toBe(viewport.width);
      await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "false");
    } else {
      expect(hostColumns.stacked).toBe(false);
      expect(hostColumns.railRight).toBeLessThanOrEqual(1);
      expect(hostColumns.chatWidth).toBe(viewport.width);
      expect(hostColumns.chatHeight).toBeGreaterThan(100);
      await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "true");
      expect(await page.getByTestId("invite-panel").evaluate((element) => (element as HTMLElement).inert)).toBe(true);

      const railToggle = page.locator(".mobile-rail-toggle");
      await railToggle.click();
      await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "false");
      await expectInsideViewport(page.getByTestId("invite-panel"));
      expect(await page.getByTestId("invite-panel").evaluate((element) => ({
        overflowY: getComputedStyle(element).overflowY,
        scrollOwnsContent: element.scrollHeight >= element.clientHeight,
      }))).toEqual({ overflowY: "auto", scrollOwnsContent: true });
      await railToggle.click();
      await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "true");
    }
    await openManagement(page);
    await expect(page.getByTestId("host-chat")).toBeHidden();
    await expect.poll(() => page.locator(".host-layout").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(viewport.width);
    await expectNoDocumentOverflow(page, viewport);
    await expect.poll(() => page.getByRole("log", { name: "Coordinator activity" }).evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThan(100);
    if (viewport.width <= 900) {
      await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "true");
    } else {
      await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "false");
    }
    await closeManagement(page);
    await expect(page.getByTestId("host-chat")).toBeVisible();
    const restoredHostColumns = await page.locator(".host-layout").evaluate((layout) => {
      const rail = layout.querySelector<HTMLElement>(".host-rail")!.getBoundingClientRect();
      const chat = layout.querySelector<HTMLElement>(".host-chat")!.getBoundingClientRect();
      return {
        railRight: Math.round(rail.right),
        railWidth: Math.round(rail.width),
        chatWidth: Math.round(chat.width),
        combinedWidth: Math.round(rail.width + chat.width),
        stacked: Math.round(rail.top) !== Math.round(chat.top),
      };
    });
    if (viewport.width > 900) {
      expect(restoredHostColumns.stacked).toBe(false);
      expect(restoredHostColumns.combinedWidth).toBe(viewport.width);
      await expect(page.getByRole("navigation", { name: "Server and channel browser" })).toBeVisible();
    } else {
      expect(restoredHostColumns.stacked).toBe(false);
      expect(restoredHostColumns.chatWidth).toBe(viewport.width);
      await expect(page.getByTestId("invite-panel")).toHaveAttribute("aria-hidden", "true");
      await expect.poll(() => page.getByTestId("invite-panel").evaluate((element) => Math.round(element.getBoundingClientRect().right))).toBeLessThanOrEqual(1);
      await page.locator(".mobile-rail-toggle").click();
      await expect(page.getByRole("navigation", { name: "Server and channel browser" })).toBeVisible();
      await expectInsideViewport(page.getByTestId("invite-panel"));
      await page.locator(".mobile-rail-toggle").click();
    }
    if (viewport.width <= 900 && viewport.height <= 420) {
      await page.setViewportSize({ width: 320, height: 568 });
    }
    await stopCoordinator(page);
    await expect(page.getByTestId("status-badge")).toHaveText("idle");
  }
});

test("keeps host mobile tools and room dialogs bounded inside the app shell", async ({ page }) => {
  const portrait = { width: 320, height: 568 };
  await page.setViewportSize(portrait);
  await page.goto("/");
  await configureMockRelay(page);
  await startCoordinator(page);
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Mobile controls");
  await expect(page.getByTestId("status-badge")).toHaveText("running");

  await page.getByRole("button", { name: "Open room browser" }).click();
  await page.getByRole("button", { name: /Open profile for/ }).click();
  const profile = page.getByRole("dialog", { name: "User profile" });
  await expect(profile).toBeVisible();
  await expectInsideViewport(profile);
  expect(await profile.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollOwnsContent: element.scrollHeight >= element.clientHeight,
  }))).toEqual({ overflowY: "auto", scrollOwnsContent: true });
  await page.keyboard.press("Escape");
  await expect(profile).toBeHidden();
  await expectNoDocumentOverflow(page, portrait);

  await page.getByRole("button", { name: "Open room browser" }).click();
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const invite = page.getByTestId("invite-dialog").getByRole("dialog");
  const inviteBody = invite.locator(".share-dialog-body");
  await expectInsideViewport(invite);
  expect(await inviteBody.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollable: element.scrollHeight > element.clientHeight,
  }))).toEqual({ overflowY: "auto", scrollable: true });
  await expectNoDocumentOverflow(page, portrait);

  const landscape = { width: 568, height: 320 };
  await page.setViewportSize(landscape);
  await expectInsideViewport(invite);
  await expect.poll(() => inviteBody.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThan(80);
  await expectNoDocumentOverflow(page, landscape);
  await invite.locator(".share-close").click();

  await page.setViewportSize(portrait);
  await page.setViewportSize(landscape);
  await openManagement(page);
  await expect.poll(() => page.getByRole("log", { name: "Coordinator activity" }).evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThan(100);
  await expectNoDocumentOverflow(page, landscape);
  await closeManagement(page);
  await page.setViewportSize(portrait);
  await stopCoordinator(page);
  await expect(page.getByTestId("status-badge")).toHaveText("idle");
});

test("persists and honors the autostart coordinator setting", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  const settings = await openCoordinatorSettings(page, true);
  await settings.getByLabel("Toggle autostart").check();
  await closeCoordinatorSettings(settings);
  await page.reload();

  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Autostart room");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("status-badge")).toHaveText("idle");
});

test("Feature: invite-only chat — Scenario: a guest link opens inside the unified root workspace", async ({ page, browser }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await expect(page.getByText("Invite a small group.")).toHaveCount(0);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const createDialog = page.getByTestId("create-room-dialog");
  await expect(createDialog).toBeVisible();
  await expect(page.getByLabel("Auto-approve invitees")).toBeChecked();
  await expect(page.locator(".host-layout")).toHaveCSS("filter", "blur(2px)");
  await createDialog.getByPlaceholder("Friday plans").fill("BDD room");
  await createDialog.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.getByTestId("host-chat")).toBeVisible();
  const inviteButton = page.getByTestId("invite-panel").getByRole("button", { name: "Invite", exact: true });
  await expect(inviteButton).toBeVisible();
  await expect(page.getByAltText("QR code to join BDD room")).toHaveCount(0);
  await inviteButton.click();
  const inviteDialog = page.getByTestId("invite-dialog");
  await expect(inviteDialog).toBeVisible();
  await expect(inviteDialog.getByRole("button", { name: "Copy invite link" })).toBeVisible();
  const coordinatorDetail = inviteDialog.locator(".invite-detail").filter({ hasText: "Coordinator pubkey" });
  await expect(coordinatorDetail.locator("code")).toHaveText(/^[0-9a-f]{64}$/);
  const portableInvite = await inviteDialog.locator(".invite-detail-primary code").textContent();
  expect(new URL(portableInvite!).origin).toBe(new URL(page.url()).origin);
  expect(new URL(portableInvite!).pathname).toContain("/chat/");
  expect(new URL(portableInvite!).searchParams.get("c")).toMatch(/^nprofile1/);
  expect(JSON.parse(Buffer.from(new URL(portableInvite!).searchParams.get("m")!, "base64url").toString())).toMatchObject({ name: "BDD room" });
  await expect(inviteDialog.getByRole("button", { name: "Copy coordinator pubkey" })).toBeVisible();
  await expect(inviteDialog.getByText("Interoperable invite code")).toHaveCount(0);
  await expect(inviteDialog.getByText("Send in app")).toBeVisible();
  await expect.poll(async () => (await inviteDialog.getByAltText("QR code to join BDD room").boundingBox())?.width ?? 0).toBeGreaterThan(200);
  const qrCode = inviteDialog.getByAltText("QR code to join BDD room");
  const compactQrWidth = (await qrCode.boundingBox())!.width;
  await inviteDialog.getByRole("button", { name: "Enlarge QR code" }).click();
  await expect(inviteDialog.getByRole("button", { name: "Restore QR code size" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await qrCode.boundingBox())?.width ?? 0).toBeGreaterThan(compactQrWidth);
  await expect(inviteDialog.locator(".invite-details")).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect.poll(() => inviteDialog.evaluate((dialog) => ({
    dialogScrolls: dialog.scrollHeight > dialog.clientHeight,
    pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    qrBottom: Math.ceil(dialog.querySelector(".share-qr")!.getBoundingClientRect().bottom),
    dialogBottom: Math.floor(dialog.getBoundingClientRect().bottom),
  }))).toEqual(expect.objectContaining({ dialogScrolls: false, pageScrolls: false }));
  expect(await inviteDialog.evaluate((dialog) => {
    const qrBottom = dialog.querySelector(".share-qr")!.getBoundingClientRect().bottom;
    return qrBottom <= dialog.getBoundingClientRect().bottom;
  })).toBe(true);
  await inviteDialog.getByRole("button", { name: "Restore QR code size" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(inviteDialog.getByRole("button", { name: "Enlarge QR code" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".host-layout")).toHaveCSS("filter", "blur(2px)");
  const inviteLink = await page.getByTestId("invite-link").textContent();
  expect(inviteLink).toContain("/chat/");
  await inviteDialog.getByRole("button", { name: "Close invite dialog" }).last().click();
  await expect(inviteDialog).toBeHidden();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(inviteLink!);

  await expect(guest).toHaveURL(/\/$/);
  await expect(guest.getByTestId("operator-shell")).toBeVisible();
  await expect(guest.getByTestId("workspace-navigation")).toHaveCount(1);
  await expect(guest.getByTestId("invite-panel")).toBeVisible();
  await expect(guest.getByTestId("chat-route")).toBeVisible();
  await expect(guest.getByText("Choose a name, then join the encrypted room.")).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await expect(guest.getByTestId("cached-room-view")).toBeVisible({ timeout: 35_000 });
  await expect(guest.getByRole("heading", { name: "BDD room" })).toBeVisible();
  await expect(guest.locator(".host-chat > [data-testid='chat-route']")).toBeVisible();
  await expectEmbeddedChatFillsHostPane(guest);
  await guestContext.close();
});

test("refreshes a room invite without disconnecting the room and rejects the previous link", async ({ page, browser }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Rotating room");

  const previousInvite = await page.getByTestId("invite-link").textContent();
  await page.getByTestId("invite-panel").getByRole("button", { name: "Invite", exact: true }).click();
  const inviteDialog = page.getByTestId("invite-dialog");
  await inviteDialog.getByRole("button", { name: "Refresh invite link" }).click();
  await expect(inviteDialog.getByText("New invite ready. Previous links are closed.")).toBeVisible();
  const currentInvite = await page.getByTestId("invite-link").textContent();
  expect(currentInvite).not.toBe(previousInvite);
  expect(new URL(currentInvite!).pathname).toBe(new URL(previousInvite!).pathname);
  await inviteDialog.getByRole("button", { name: "Close invite dialog" }).last().click();
  await expect(page.getByTestId("host-chat")).toBeVisible();

  const previousContext = await browser.newContext();
  const previousGuest = await previousContext.newPage();
  await previousGuest.goto(previousInvite!);
  await expect(previousGuest.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await expect(previousGuest.getByText("Your encrypted join request is with the host.")).toBeVisible();

  const currentContext = await browser.newContext();
  const currentGuest = await currentContext.newPage();
  await currentGuest.goto(currentInvite!);
  await expect(currentGuest.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await expect(currentGuest.getByPlaceholder("Message")).toBeVisible({ timeout: 20_000 });
  await expect(previousGuest.getByText("Your encrypted join request is with the host.")).toBeVisible();
  await expect(previousGuest.getByPlaceholder("Message")).toHaveCount(0);

  await previousContext.close();
  await currentContext.close();
});

test("Feature: invite-only chat — Scenario: a guest is admitted and messages survive coordinator delivery", async ({ page, browser }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await customizeHostIdentity(page, "Mara", "guide", "🦉");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Working room");
  const inviteLink = await page.getByTestId("invite-link").textContent();
  await expect(page.getByTestId("host-chat")).toBeVisible();
  const hostedRoomRow = page.getByTestId("invite-panel").getByRole("button", { name: "Open room Working room" });
  await expect.poll(() => hostedRoomRow.locator(".channel-owner-avatar").evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await hostedRoomRow.hover();
  await expect.poll(() => hostedRoomRow.locator(".channel-owner-avatar").evaluate((element) => getComputedStyle(element).opacity)).toBe("0.72");
  await expect(hostedRoomRow.getByTestId("room-host-identity")).toHaveAttribute("title", "Hosted by Mara");
  await expect(hostedRoomRow.getByTestId("room-host-identity")).toHaveText("");
  const hostActions = await openRoomActions(page, "Working room");
  await expect(hostActions.getByRole("menuitem", { name: "Copy coordinator pubkey for Working room" })).toBeVisible();
  const hostInviteAction = hostActions.getByRole("menuitem", { name: "Copy invite link for Working room" });
  await expect(hostInviteAction).toBeVisible();
  const hostInvite = await hostInviteAction.locator("code").textContent();
  expect(new URL(hostInvite!).origin).toBe(new URL(page.url()).origin);
  expect(new URL(hostInvite!).searchParams.get("c")).toMatch(/^nprofile1/);
  await expect(hostActions.getByLabel("Sound setting for Working room")).toBeVisible();
  await expect(hostActions.getByLabel("Notification setting for Working room")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hostActions).toBeHidden();
  await expect(page.getByTestId("invite-panel").getByLabel("Sound setting for Working room")).toHaveCount(0);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(inviteLink!);
  await expect(guest.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await expect(guest.getByTestId("active-server-context")).toHaveCount(0);
  await expect(guest.getByText("Your encrypted join request is with the host.")).toBeVisible();

  await expect(guest.getByPlaceholder("Message")).toBeVisible({ timeout: 20_000 });
  await expect(guest.getByLabel("Add 👍")).toBeVisible();
  const reachableCoordinator = guest.getByTestId(`coordinator-card-status-${await page.getByTestId("selected-coordinator-status").getAttribute("data-coordinator-pubkey")}`);
  await expect(reachableCoordinator).toHaveAttribute("data-state", "online", { timeout: 20_000 });
  await expect(reachableCoordinator).toHaveAttribute("aria-label", /coordinator online/i);
  const guestActions = await openRoomActions(guest, "Working room");
  await expect(guestActions.getByRole("menuitem", { name: "Copy coordinator pubkey for Working room" })).toBeVisible();
  await expect(guestActions.getByRole("menuitem", { name: "Copy invite link for Working room" })).toBeVisible();
  await expect(guestActions.getByLabel("Sound setting for Working room")).toBeVisible();
  await expect(guestActions.getByLabel("Notification setting for Working room")).toBeVisible();
  await expect(guestActions.getByRole("menuitem", { name: "Leave room Working room" })).toBeVisible();
  await guest.keyboard.press("Escape");
  await expect(guestActions).toBeHidden();
  await expect(guest.getByTestId("active-server-context")).toHaveCount(0);
  const guestSidebarRoom = guest.getByTestId("invite-panel").getByRole("button", { name: /Open room Working room/ });
  await expect.poll(() => guestSidebarRoom.locator(".channel-owner-avatar").evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await guestSidebarRoom.hover();
  await expect.poll(() => guestSidebarRoom.locator(".channel-owner-avatar").evaluate((element) => getComputedStyle(element).opacity)).toBe("0.72");
  await expect(guestSidebarRoom.getByTestId("room-host-identity")).toHaveAttribute("title", "Hosted by Mara");
  await expect(guestSidebarRoom.getByTestId("room-host-identity")).toHaveText("");
  await guest.getByPlaceholder("Message").fill("Hello from BDD");
  await guest.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("host-chat").getByText("Hello from BDD")).toBeVisible({ timeout: 15_000 });

  await guest.setViewportSize({ width: 390, height: 350 });
  await expect.poll(() => guest.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    pageHeight: document.documentElement.scrollHeight,
    viewportHeight: document.documentElement.clientHeight,
  }))).toEqual({ pageWidth: 390, viewportWidth: 390, pageHeight: 350, viewportHeight: 350 });
  await expect.poll(() => guest.getByTestId("guest-message-list").evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThan(60);
  await expect(guest.getByTestId("workspace-navigation")).toBeVisible();
  await expect(guest.getByRole("button", { name: "Open room browser" })).toBeVisible();
  for (let index = 1; index <= 10; index += 1) {
    await page.getByPlaceholder("Message as host").fill(`Host note ${index}`);
    await page.getByPlaceholder("Message as host").press("Enter");
  }
  await expect(guest.getByText("Host note 10")).toBeVisible({ timeout: 30_000 });
  const streaks = guest.getByTestId("guest-message-list").getByTestId("message-streak");
  const ownStreak = streaks.filter({ hasText: "Hello from BDD" });
  const hostStreak = streaks.filter({ hasText: "Host note 10" });
  await expect(streaks).toHaveCount(2);
  await expect(ownStreak).toHaveAttribute("data-message-count", "1");
  await expect(hostStreak).toHaveAttribute("data-message-count", "10");
  await expect(hostStreak.getByTestId("message-author")).toHaveCount(1);
  await expect(hostStreak.getByTestId("message-author")).toContainText("Mara");
  await expect(hostStreak.getByTestId("message-avatar")).toHaveCount(1);
  await expect(hostStreak.getByTestId("message-avatar")).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await expect(hostStreak.getByTestId("message-badge")).toContainText(/🦉\s*guide/);
  await expect(hostStreak.getByTestId("message-badge")).toHaveCSS("user-select", "text");
  await expect(hostStreak.locator("time")).toHaveCount(10);
  await expect.poll(() => guest.getByTestId("guest-message-list").evaluate((list) => {
    const listBounds = list.getBoundingClientRect();
    const [own, host] = Array.from(list.querySelectorAll<HTMLElement>('[data-testid="message-streak"]'));
    const ownAvatar = own?.querySelector<HTMLElement>('[data-testid="message-avatar"]')?.getBoundingClientRect();
    const ownBubble = own?.querySelector<HTMLElement>('[data-testid="message-bubble"]')?.getBoundingClientRect();
    const hostAvatar = host?.querySelector<HTMLElement>('[data-testid="message-avatar"]')?.getBoundingClientRect();
    const hostBubble = host?.querySelector<HTMLElement>('[data-testid="message-bubble"]')?.getBoundingClientRect();
    const ownStyle = ownBubble ? getComputedStyle(own!.querySelector<HTMLElement>('[data-testid="message-bubble"]')!) : null;
    const hostStyle = hostBubble ? getComputedStyle(host!.querySelector<HTMLElement>('[data-testid="message-bubble"]')!) : null;
    return Boolean(ownAvatar && ownBubble && hostAvatar && hostBubble
      && ownBubble.right < ownAvatar.left
      && hostAvatar.right < hostBubble.left
      && ownBubble.width >= listBounds.width * .5
      && hostBubble.width >= listBounds.width * .5
      && ownBubble.left > listBounds.left
      && hostBubble.right < listBounds.right
      && ownStyle?.borderTopWidth === "0px"
      && ownStyle.boxShadow === "none"
      && hostStyle?.borderTopWidth === "0px"
      && hostStyle.boxShadow !== "none"
      && ownStyle.backgroundColor !== hostStyle.backgroundColor
      && ownBubble.height < 70
      && hostBubble.height < 70);
  })).toBe(true);
  await expect.poll(() => guest.getByTestId("guest-message-list").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);

  const inviteMetadata = JSON.parse(Buffer.from(new URL(inviteLink!).searchParams.get("m")!, "base64url").toString("utf8")) as { coordinatorName: string };
  await page.getByPlaceholder("Message as host").fill(inviteLink!);
  await page.getByPlaceholder("Message as host").press("Enter");
  const sharedInviteAction = guest.getByRole("button", {
    name: `Join Working room on ${inviteMetadata.coordinatorName} by Mara`,
  });
  await expect(sharedInviteAction).toBeVisible({ timeout: 15_000 });
  await expect(sharedInviteAction.locator("img")).toBeVisible();
  await expect(guest.getByText(inviteLink!, { exact: true })).toHaveCount(0);
  await sharedInviteAction.click();
  await expect.poll(() => guest.evaluate(() => {
    const intent = (history.state as Record<string, unknown> | null)?.cahmlsWorkspaceIntent;
    return typeof intent === "string" ? new URL(intent).searchParams.get("autojoin") : null;
  })).toBe("1");
  await guestContext.close();
});

test("message reactions persist and synchronize", async ({ page, browser }) => {
  test.setTimeout(75_000);
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Reaction room");
  const inviteLink = await page.getByTestId("invite-link").textContent();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(inviteLink!);
  await expect(guest.getByPlaceholder("Message")).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder("Message as host").fill("A reaction target");
  await page.getByPlaceholder("Message as host").press("Enter");
  const hostMessage = page.locator("article.host-message").filter({ hasText: "A reaction target" });
  const guestMessage = guest.locator("article.message").filter({ hasText: "A reaction target" });
  await expect(guestMessage).toBeVisible({ timeout: 20_000 });
  await expect(hostMessage.getByRole("button", { name: "Add reaction" })).toHaveCount(0);
  await expect.poll(() => hostMessage.evaluate((message) => {
    const style = getComputedStyle(message);
    return { border: style.borderTopWidth, shadow: style.boxShadow };
  })).toEqual({ border: "0px", shadow: "none" });

  const hostPaneActions = page.getByTestId("host-chat").getByRole("button", { name: "More room actions" });
  await expect(hostPaneActions).toBeVisible();
  await hostPaneActions.click();
  await expect(page.getByRole("menuitem", { name: "Delete room Reaction room" })).toBeVisible();
  await page.keyboard.press("Escape");

  const addReaction = guestMessage.getByRole("button", { name: "Add reaction" });
  await expect(addReaction).toHaveCSS("opacity", "0");
  await guestMessage.hover();
  await expect(addReaction).toHaveCSS("opacity", "1");
  await addReaction.click();
  const reactionMenu = guestMessage.getByRole("menu", { name: /Choose reaction/ });
  await expect(reactionMenu).toBeVisible();
  await expect(reactionMenu).toHaveCSS("position", "absolute");
  await reactionMenu.getByRole("menuitem", { name: "React 👍" }).click();
  await expect(guestMessage.getByRole("button", { name: /Remove 👍 reaction, 1 participant/ })).toHaveAttribute("aria-pressed", "true");
  await expect(hostMessage.getByLabel("👍 reaction, 1 participant")).toBeVisible({ timeout: 20_000 });
  await expect(hostMessage.getByRole("button", { name: /👍 reaction/ })).toHaveCount(0);
  await expect.poll(() => guestMessage.evaluate((message) => {
    const add = message.querySelector<HTMLElement>(".reaction-add")?.getBoundingClientRect();
    const chip = message.querySelector<HTMLElement>(".reaction-chip")?.getBoundingClientRect();
    const bubble = message.getBoundingClientRect();
    return Boolean(add && chip
      && add.left < chip.left
      && add.right < chip.left
      && add.top < bubble.bottom
      && add.bottom > bubble.bottom
      && chip.top < bubble.bottom
      && chip.bottom > bubble.bottom);
  })).toBe(true);

  const guestPaneActions = guest.getByTestId("cached-room-view").getByRole("button", { name: "More room actions" });
  await expect(guestPaneActions).toBeVisible();
  await guestPaneActions.click();
  await expect(guest.getByRole("menuitem", { name: "Leave room Reaction room" })).toBeVisible();
  await guest.keyboard.press("Escape");
  await guestMessage.getByRole("button", { name: /Remove 👍 reaction, 1 participant/ }).click();
  await expect(guestMessage.getByLabel(/👍 reaction/)).toHaveCount(0);
  await expect(hostMessage.getByLabel(/👍 reaction/)).toHaveCount(0, { timeout: 20_000 });
  for (const emoji of ["👍", "❤️", "😂", "🎉", "👋", "✨"]) {
    await expect(page.getByTestId("host-chat").getByLabel(`Add ${emoji}`, { exact: true })).toBeVisible();
  }
  await guest.setViewportSize({ width: 390, height: 667 });
  for (const emoji of ["👍", "❤️", "😂", "🎉", "👋", "✨"]) {
    await expect(guest.getByTestId("chat-composer").getByLabel(`Add ${emoji}`, { exact: true })).toBeVisible();
  }
  await guestContext.close();
});

test("emoji shortcuts and offline cached reactions", async ({ page }) => {
  await page.goto("/");
  await seedJoinedRoom(page, "Offline reactions");
  await page.evaluate(() => {
    const key = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index) ?? "")
      .find((entry) => entry.includes("cordn-adhoc-chat-room:v2:"));
    if (!key) throw new Error("seeded room was not found");
    const room = JSON.parse(localStorage.getItem(key) ?? "{}");
    room.messages = [{
      type: "message", id: "cached-message", sender: "c".repeat(64), name: "Cached guest", content: "Still readable", createdAt: 1,
    }];
    room.reactions = [
      { id: "cached-reaction", sender: "d".repeat(64), targetMessageId: "cached-message", emoji: "✨", active: true, createdAt: 2 },
      { id: "bad-reaction", sender: "d".repeat(64), targetMessageId: "cached-message", emoji: "not-an-emoji", active: true, createdAt: 3 },
    ];
    localStorage.setItem(key, JSON.stringify(room));
  });
  await page.reload();
  await page.getByRole("button", { name: /Open room Offline reactions/ }).click();
  const cachedRoom = page.getByTestId("cached-room-view");
  await expect(cachedRoom.getByText("Still readable")).toBeVisible();
  await expect(cachedRoom.getByRole("button", { name: "Add reaction" })).toBeDisabled();
  for (const emoji of ["👍", "❤️", "😂", "🎉", "👋", "✨"]) {
    await expect(cachedRoom.getByLabel(`Add ${emoji}`, { exact: true })).toBeVisible();
    await expect(cachedRoom.getByLabel(`Add ${emoji}`, { exact: true })).toBeDisabled();
  }
});

test("hosts delete rooms and members leave with contextual confirmation", async ({ page, browser }) => {
  test.setTimeout(75_000);
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Keep room");
  await createRoom(page, "Disposable room");
  const inviteLink = await page.getByTestId("invite-link").textContent();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(inviteLink!);
  await expect(guest.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await expect(guest.getByPlaceholder("Message")).toBeVisible({ timeout: 20_000 });
  await guest.getByPlaceholder("Message").fill("Keep this cached");
  await guest.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("host-chat").getByText("Keep this cached")).toBeVisible({ timeout: 15_000 });

  let roomActions = await openRoomActions(page, "Disposable room");
  await expect(roomActions.getByRole("menuitem", { name: "Leave room Disposable room" })).toHaveCount(0);
  await roomActions.getByRole("menuitem", { name: "Delete room Disposable room" }).click();
  const deleteDialog = page.getByTestId("room-removal-dialog");
  await expect(deleteDialog.getByRole("heading", { name: "Delete #Disposable room?" })).toBeVisible();
  await expect(deleteDialog.getByTestId("room-removal-impact")).toContainText("1 cached message");
  await expect(deleteDialog.getByTestId("room-removal-impact")).toContainText("Coordinator");
  await expect(deleteDialog.getByTestId("room-removal-impact")).toContainText("Host");
  await expect(deleteDialog.getByTestId("room-removal-impact")).toContainText("This cannot be undone");
  await expect(deleteDialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toBeHidden();
  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Open room Disposable room" })).toBeVisible();

  roomActions = await openRoomActions(page, "Disposable room");
  await roomActions.getByRole("menuitem", { name: "Delete room Disposable room" }).click();
  await deleteDialog.getByTestId("confirm-delete-room").click();
  await expect(deleteDialog).toBeHidden();
  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Open room Disposable room" })).toHaveCount(0);
  await expect(page.locator(".channel-row.active")).toContainText("Keep room");

  await expect(guest.getByTestId("room-deleted-message")).toBeVisible({ timeout: 25_000 });
  await expect(guest.getByPlaceholder("Room deleted by host")).toBeDisabled();
  await guest.setViewportSize({ width: 390, height: 350 });
  const guestRoomActions = await openRoomActions(guest, "Disposable room");
  await expect(guestRoomActions.getByRole("menuitem", { name: "Delete room Disposable room" })).toHaveCount(0);
  await guestRoomActions.getByRole("menuitem", { name: "Leave room Disposable room" }).click();
  const leaveDialog = guest.getByTestId("room-removal-dialog");
  await expect(leaveDialog.getByRole("heading", { name: "Leave #Disposable room?" })).toBeVisible();
  await expect(leaveDialog.getByTestId("room-removal-impact")).toContainText("1 cached message");
  await expect.poll(() => guest.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('[data-testid="room-removal-dialog"]');
    const bounds = dialog?.getBoundingClientRect();
    return {
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: document.documentElement.clientHeight,
      fits: Boolean(bounds && bounds.top >= 0 && bounds.bottom <= window.innerHeight),
    };
  })).toEqual({ pageHeight: 350, viewportHeight: 350, fits: true });

  await leaveDialog.getByTestId("confirm-leave-room").click();
  await expect(guest).toHaveURL(/\/$/);
  await expect(guest.getByTestId("operator-shell")).toBeVisible();
  await expect(guest.getByTestId("workspace-navigation")).toHaveCount(1);
  expect(await guest.evaluate(() => [...Array(localStorage.length).keys()].some((index) => {
    const key = localStorage.key(index);
    if (!key?.startsWith("cordn-adhoc-chat-room:")) return false;
    const value = localStorage.getItem(key);
    return value?.includes('"title":"Disposable room"') ?? false;
  }))).toBe(false);

  await guestContext.close();
});

test("active room removal follows stable adjacent order, then reaches the coordinator empty state", async ({ page }) => {
  test.setTimeout(75_000);
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Adjacent first");
  await createRoom(page, "Adjacent middle");
  await createRoom(page, "Adjacent last");

  const deleteFromRail = async (title: string) => {
    const row = page.locator(".channel-row").filter({ hasText: title });
    const trigger = row.getByRole("button", { name: `More actions for # ${title}` });
    await trigger.click();
    await page.getByRole("menu", { name: `Room actions for ${title}` }).getByRole("menuitem", { name: `Delete room ${title}` }).click();
    await page.getByTestId("confirm-delete-room").click();
  };

  await page.getByRole("button", { name: /Open room Adjacent middle/ }).click();
  await deleteFromRail("Adjacent middle");
  await expect(page.locator(".channel-row.active .channel-row-primary")).toContainText("Adjacent first");

  await deleteFromRail("Adjacent first");
  await expect(page.locator(".channel-row.active .channel-row-primary")).toContainText("Adjacent last");

  await deleteFromRail("Adjacent last");
  await expect(page.getByTestId("coordinator-card").first()).toContainText("No groups yet");
  await expect(page.getByTestId("coordinator-empty-content")).toContainText("Ready for your first room");
  await expect(page.getByTestId("coordinator-empty-content")).toBeVisible();
});

test("room removal missing-target failure stays contextual and safe", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Safe removal");
  const roomActions = await openRoomActions(page, "Safe removal");
  await roomActions.getByRole("menuitem", { name: "Delete room Safe removal" }).click();
  const dialog = page.getByTestId("room-removal-dialog");
  await page.evaluate(() => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("cordn-adhoc-chat-room:v2:")) localStorage.removeItem(key);
    }
  });
  await dialog.getByTestId("confirm-delete-room").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText("Couldn’t delete # Safe removal. Try again.");
  await expect(page).toHaveURL(/\/$/);
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
});

test("sidebar room actions do not open the row before deleting its exact host room", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Sidebar keep");
  await createRoom(page, "Sidebar delete");

  await expect(page.locator(".channel-row.active .channel-row-primary")).toContainText("Sidebar delete");
  const targetRow = page.locator(".channel-row").filter({ hasText: "Sidebar delete" });
  const trigger = targetRow.getByRole("button", { name: "More actions for # Sidebar delete" });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.locator(".channel-row.active .channel-row-primary")).toContainText("Sidebar delete");

  const menu = page.getByRole("menu", { name: "Room actions for Sidebar delete" });
  await expect(menu).toHaveAttribute("data-viewport-overlay", "true");
  await expect.poll(() => menu.evaluate((element) => element.matches(":popover-open"))).toBe(true);
  await expectInsideViewport(menu);
  await expect(menu.getByRole("menuitem", { name: "Delete room Sidebar delete" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Delete room Sidebar delete" }).click();
  const dialog = page.getByTestId("room-removal-dialog");
  await expect(dialog.getByRole("heading", { name: "Delete #Sidebar delete?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("same-id sidebar removal leaves only the captured remote record", async ({ page }) => {
  await page.goto("/");
  await seedJoinedRoom(page, "Sidebar remote", "f".repeat(64));
  await page.reload();
  const targetRow = page.locator(".channel-row").filter({ hasText: "Sidebar remote" });
  const trigger = targetRow.getByRole("button", { name: "More actions for # Sidebar remote" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Room actions for Sidebar remote" });
  await expect(menu.getByRole("menuitem", { name: "Leave room Sidebar remote" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Delete room Sidebar remote" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Leave room Sidebar remote" }).click();
  const dialog = page.getByTestId("room-removal-dialog");
  await expect(dialog.getByRole("heading", { name: "Leave #Sidebar remote?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("leaving the last remote room returns to the home coordinator", async ({ page }) => {
  await page.goto("/");
  const remoteCoordinatorPubkey = "f".repeat(64);
  await seedJoinedRoom(page, "Last remote room", remoteCoordinatorPubkey);
  await page.reload();

  const homeCoordinatorPubkey = await page.getByTestId("selected-coordinator-status").getAttribute("data-coordinator-pubkey");
  expect(homeCoordinatorPubkey).toBeTruthy();
  await expect(page.getByTestId(`coordinator-card-status-${remoteCoordinatorPubkey}`)).toBeVisible();

  const targetRow = page.locator(".channel-row").filter({ hasText: "Last remote room" });
  await targetRow.getByRole("button", { name: "More actions for # Last remote room" }).click();
  await page.getByRole("menu", { name: "Room actions for Last remote room" })
    .getByRole("menuitem", { name: "Leave room Last remote room" })
    .click();
  await page.getByTestId("confirm-leave-room").click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("guided-start-state")).toHaveCount(0);
  await expect(page.getByTestId("coordinator-card").first()).toContainText("No groups yet");
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.getByTestId("selected-coordinator-status"))
    .toHaveAttribute("data-coordinator-pubkey", homeCoordinatorPubkey ?? "");
  await expect(page.getByTestId("coordinator-card").first()).toBeVisible();
});

test("switches local Delete to remote Leave without crossing same-id room identities", async ({ page }) => {
  test.setTimeout(75_000);
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);

  await createRoom(page, "Exact local delete target");
  const exactLocalActions = await openRoomActions(page, "Exact local delete target");
  await expect(exactLocalActions.getByRole("menuitem", { name: "Leave room Exact local delete target" })).toHaveCount(0);
  await exactLocalActions.getByRole("menuitem", { name: "Delete room Exact local delete target" }).click();
  const localDeleteDialog = page.getByTestId("room-removal-dialog");
  await expect(localDeleteDialog.getByRole("heading", { name: "Delete #Exact local delete target?" })).toBeVisible();
  await localDeleteDialog.getByTestId("confirm-delete-room").click();
  await expect(localDeleteDialog).toBeHidden();
  expect(await page.evaluate(() => [...Array(localStorage.length).keys()].every((index) => {
    const key = localStorage.key(index);
    const value = localStorage.getItem(key ?? "");
    return !key?.startsWith("cordn-adhoc-chat-room:") || !value?.includes('"title":"Exact local delete target"');
  }))).toBe(true);

  await createRoom(page, "Local collision room");
  const localInvite = await page.getByTestId("invite-link").textContent();
  expect(localInvite).toBeTruthy();
  const localRoom = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const room = JSON.parse(raw) as {
        id?: string;
        title?: string;
        coordinatorPubkey?: string;
        relayUrls?: string[];
      };
      if (room.title === "Local collision room"
        && typeof room.id === "string"
        && typeof room.coordinatorPubkey === "string"
        && Array.isArray(room.relayUrls)) {
        return room as Required<Pick<typeof room, "id" | "title" | "coordinatorPubkey" | "relayUrls">>;
      }
    }
    return null;
  });
  if (!localRoom) throw new Error("Could not find the hosted collision room");

  const remoteCoordinatorPubkey = "f".repeat(64);
  const remotePrivateFixture = createStoredRoomPrivateFixture();
  await page.evaluate(({ localRoom, remoteCoordinatorPubkey, relayUrl, remotePrivateFixture }) => {
    const remoteRoom = {
      version: 1,
      id: localRoom.id,
      title: "Remote collision room",
      coordinatorPubkey: remoteCoordinatorPubkey,
      coordinatorOrigin: "https://remote.example",
      relayUrls: [relayUrl],
      name: "Reader",
      stablePubkey: "b".repeat(64),
      isHost: false,
      stateBase64: "",
      keyPackage: {
        reference: "remote-ref",
        publicBase64: "public",
        privateBase64: remotePrivateFixture.keyPackagePrivateBase64,
      },
      anonymousSecretKey: remotePrivateFixture.anonymousSecretKey,
      lastCursor: 0,
      messages: [],
      pending: [],
      joinRequestSent: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const key = `cordn-adhoc-chat-room:v2:${encodeURIComponent(remoteCoordinatorPubkey)}:${encodeURIComponent(remoteRoom.id)}`;
    localStorage.setItem(key, JSON.stringify(remoteRoom));
  }, { localRoom, remoteCoordinatorPubkey, relayUrl: relay.url, remotePrivateFixture });

  await navigateWithinShell(page, localInvite!);
  let collisionActions = await openRoomActions(page, "Local collision room");
  await expect(collisionActions.getByRole("menuitem", { name: "Delete room Local collision room" })).toBeVisible();
  await expect(collisionActions.getByRole("menuitem", { name: "Leave room Local collision room" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Open room Remote collision room/ }).click();

  collisionActions = await openRoomActions(page, "Remote collision room");
  const remoteLeave = collisionActions.getByRole("menuitem", { name: "Leave room Remote collision room" });
  await expect(remoteLeave).toBeVisible();
  await expect(collisionActions.getByRole("menuitem", { name: "Delete room Remote collision room" })).toHaveCount(0);
  await remoteLeave.click();
  const remoteLeaveDialog = page.getByTestId("room-removal-dialog");
  await expect(remoteLeaveDialog.getByRole("heading", { name: "Leave #Remote collision room?" })).toBeVisible();
  await remoteLeaveDialog.getByTestId("confirm-leave-room").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("operator-shell")).toBeVisible();

  expect(await page.evaluate(({ localRoom, remoteCoordinatorPubkey }) => {
    const roomKey = (coordinatorPubkey: string) => (
      `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(localRoom.id)}`
    );
    return {
      local: localStorage.getItem(roomKey(localRoom.coordinatorPubkey)) !== null,
      remote: localStorage.getItem(roomKey(remoteCoordinatorPubkey)) !== null,
    };
  }, { localRoom, remoteCoordinatorPubkey })).toEqual({ local: true, remote: false });
  await navigateWithinShell(page, localInvite!);
  collisionActions = await openRoomActions(page, "Local collision room");
  await expect(collisionActions.getByRole("menuitem", { name: "Delete room Local collision room" })).toBeVisible();
});

test("leaves a previous local host session without deleting its same-id current room", async ({ page }) => {
  test.setTimeout(75_000);
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);

  await createRoom(page, "Current local collision room");
  const localInvite = await page.getByTestId("invite-link").textContent();
  expect(localInvite).toBeTruthy();
  const localRoom = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:v2:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const room = JSON.parse(raw) as { id?: string; title?: string; coordinatorPubkey?: string };
      if (room.title === "Current local collision room"
        && typeof room.id === "string"
        && typeof room.coordinatorPubkey === "string") return room;
    }
    return null;
  });
  if (!localRoom?.id || !localRoom.coordinatorPubkey) throw new Error("Could not find the local collision room");
  const localRoomIdentity = {
    id: localRoom.id,
    coordinatorPubkey: localRoom.coordinatorPubkey,
  };

  const remoteCoordinatorPubkey = "e".repeat(64);
  const stalePrivateFixture = createStoredRoomPrivateFixture();
  await page.evaluate(({ localRoom, remoteCoordinatorPubkey, relayUrl, stalePrivateFixture }) => {
    const staleRemoteRoom = {
      version: 1,
      id: localRoom.id,
      title: "Stale remote host claim",
      coordinatorPubkey: remoteCoordinatorPubkey,
      coordinatorOrigin: "https://remote.example",
      relayUrls: [relayUrl],
      name: "Stale host",
      stablePubkey: "b".repeat(64),
      // A legacy/corrupt record can preserve this old host claim even though
      // coordinator identity puts the room under a remote coordinator.
      isHost: true,
      stateBase64: "",
      keyPackage: {
        reference: "stale-remote-ref",
        publicBase64: "public",
        privateBase64: stalePrivateFixture.keyPackagePrivateBase64,
      },
      anonymousSecretKey: stalePrivateFixture.anonymousSecretKey,
      lastCursor: 0,
      messages: [],
      pending: [],
      joinRequestSent: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const key = `cordn-adhoc-chat-room:v2:${encodeURIComponent(remoteCoordinatorPubkey)}:${encodeURIComponent(staleRemoteRoom.id)}`;
    localStorage.setItem(key, JSON.stringify(staleRemoteRoom));
  }, {
    localRoom: localRoomIdentity,
    remoteCoordinatorPubkey,
    relayUrl: relay.url,
    stalePrivateFixture,
  });

  await navigateWithinShell(page, localInvite!);
  const localActions = await openRoomActions(page, "Current local collision room");
  await expect(localActions.getByRole("menuitem", { name: "Delete room Current local collision room" })).toBeVisible();
  await expect(localActions.getByRole("menuitem", { name: "Leave room Current local collision room" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const history = page.getByTestId("sidebar-history");
  await history.getByRole("button", { name: /History/ }).click();
  await expect(history).toContainText("Stale remote host claim");
  await expect(history).toContainText("Coordinator key rotated");
  await expect(page.getByRole("button", { name: /Open previous local session Stale remote host claim/ })).toHaveCount(0);
  await expect(page.getByTestId("operator-shell")).toBeVisible();

  expect(await page.evaluate(({ localRoom, remoteCoordinatorPubkey }) => {
    const keyFor = (coordinatorPubkey: string) => (
      `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(localRoom.id)}`
    );
    return {
      local: localStorage.getItem(keyFor(localRoom.coordinatorPubkey)) !== null,
      remote: localStorage.getItem(keyFor(remoteCoordinatorPubkey)) !== null,
    };
  }, { localRoom: localRoomIdentity, remoteCoordinatorPubkey })).toEqual({ local: true, remote: true });
});

test("manual admission shows a counted, identified queue and clears it after approval", async ({ page, browser }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const createDialog = page.getByTestId("create-room-dialog");
  await createDialog.getByPlaceholder("Friday plans").fill("Manual room");
  await createDialog.getByLabel("Auto-approve invitees").uncheck();
  await createDialog.getByRole("button", { name: "Create room", exact: true }).click();

  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Open room Manual room" })).toBeVisible();
  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Auto-approve invitees for Manual room: off" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".room-rail-heading")).toHaveCount(0);
  await page.getByRole("button", { name: "Open management interface" }).click();
  const approval = page.getByTestId("pending-invitees");
  await expect(approval.getByRole("button")).toBeDisabled();
  await expect(approval.getByRole("button")).toContainText("0");

  const inviteLink = await page.getByTestId("invite-link").textContent();
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(inviteLink!);
  await expect(guest.getByRole("button", { name: "Join chat" })).toHaveCount(0);

  await expect(approval.getByRole("button", { name: /Approve waiting invitees, 1 request/ })).toBeEnabled({ timeout: 15_000 });
  await expect(approval.locator("article")).toHaveCount(1);
  await expect(approval.locator("code")).toContainText("npub1");
  await expect(approval.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml/);

  await approval.getByRole("button", { name: /Approve waiting invitees, 1 request/ }).click();
  await expect(approval.getByRole("button")).toBeDisabled();
  await expect(approval.getByRole("button")).toContainText("0");
  await expect(guest.getByPlaceholder("Message")).toBeVisible({ timeout: 20_000 });
  await guestContext.close();
});

test("keeps auto-approval scoped to each room", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);

  await createRoom(page, "Manual access");
  const firstRoomToggle = page.getByTestId("invite-panel").getByRole("button", { name: "Auto-approve invitees for Manual access: on" });
  await expect(firstRoomToggle).toHaveAttribute("aria-pressed", "true");
  await firstRoomToggle.click();
  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Auto-approve invitees for Manual access: off" })).toHaveAttribute("aria-pressed", "false");

  await createRoom(page, "Open access");
  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Auto-approve invitees for Open access: on" })).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("invite-panel").getByRole("button", { name: "Open room Manual access" }).click();
  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Auto-approve invitees for Manual access: off" })).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("invite-panel").getByRole("button", { name: "Open room Open access" }).click();
  await expect(page.getByTestId("invite-panel").getByRole("button", { name: "Auto-approve invitees for Open access: on" })).toHaveAttribute("aria-pressed", "true");
});

test("a persistent host can navigate home rooms while communicating on another coordinator", async ({ browser }) => {
  test.setTimeout(90_000);
  const homeContext = await browser.newContext();
  const home = await homeContext.newPage();
  await installEstablishedInstallation(home);
  await home.goto("/");
  await enablePersistence(home, "room-navigation-passphrase");
  await configureMockRelay(home);
  await home.getByRole("button", { name: "Start", exact: true }).click();

  await createRoom(home, "Home alpha");
  await createRoom(home, "Home beta");

  const remoteContext = await browser.newContext();
  const remote = await remoteContext.newPage();
  await installEstablishedInstallation(remote);
  await remote.goto("/");
  await configureMockRelay(remote);
  await remote.getByRole("button", { name: "Start", exact: true }).click();
  const remoteCoordinatorPubkey = await remote.getByTestId("selected-coordinator-status").getAttribute("data-coordinator-pubkey");
  expect(remoteCoordinatorPubkey).toMatch(/^[0-9a-f]{64}$/);
  await createRoom(remote, "Remote lounge");
  const remoteInvite = await remote.getByTestId("invite-link").textContent();

  await navigateWithinShell(home, remoteInvite!);
  await expect(home).toHaveURL(/\/$/);
  await expect(home.getByTestId("active-server-context")).toHaveCount(0);
  await expect(home.getByRole("button", { name: "Join chat" })).toHaveCount(0);
  await expect(home.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });
  await expect(home.locator(".coordinator-runtime-stack > .room-tools")).toBeVisible();
  await expect.poll(() => home.evaluate(() => {
    const coordinator = document.querySelector<HTMLElement>(".coordinator-runtime-card");
    const controls = document.querySelector<HTMLElement>(".coordinator-runtime-stack > .room-tools");
    if (!coordinator || !controls) return Number.POSITIVE_INFINITY;
    return Math.abs(coordinator.getBoundingClientRect().bottom - controls.getBoundingClientRect().top);
  })).toBeLessThanOrEqual(1);
  await home.getByPlaceholder("Message").fill("Hello across coordinators");
  await home.getByRole("button", { name: "Send" }).click();
  await expect(remote.getByTestId("host-chat").getByText("Hello across coordinators")).toBeVisible({ timeout: 15_000 });

  const homeCoordinatorPubkey = await home.getByTestId("selected-coordinator-status").getAttribute("data-coordinator-pubkey");
  expect(homeCoordinatorPubkey).toMatch(/^[0-9a-f]{64}$/);
  await home.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(home.getByTestId("selected-coordinator-status")).toHaveAttribute("data-coordinator-pubkey", homeCoordinatorPubkey!);
  await expect(home.getByRole("button", { name: /Open room Home alpha/ })).toBeVisible();
  await expect(home.getByRole("button", { name: /Open room Home beta/ })).toBeVisible();

  await home.getByRole("button", { name: /Open room Home alpha/ }).click();
  await expect(home.getByTestId("active-server-context")).toHaveCount(0);

  await home.getByRole("button", { name: /Open room Remote lounge/ }).click();
  await expect(home.getByTestId("active-server-context")).toHaveCount(0);
  await expect(home.getByPlaceholder("Message")).toBeVisible({ timeout: 25_000 });
  await home.getByPlaceholder("Message").fill("Back in the remote room");
  await home.getByRole("button", { name: "Send" }).click();
  await expect(remote.getByTestId("host-chat").getByText("Back in the remote room")).toBeVisible({ timeout: 15_000 });
  const remoteCoordinatorStatus = home.getByTestId(`coordinator-card-status-${remoteCoordinatorPubkey}`);
  await expect(remoteCoordinatorStatus).toHaveAttribute("data-state", "online", { timeout: 20_000 });

  await remote.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(remote.getByTestId("status-badge")).toHaveText("idle");
  await expect(home.getByTestId("room-connection-offline-message")).toBeVisible({ timeout: 25_000 });
  await expect(remoteCoordinatorStatus).toHaveAttribute("data-state", "offline", { timeout: 25_000 });
  await expect(remoteCoordinatorStatus).not.toHaveClass(/\bonline\b/);
  await expect(home.getByTestId("guest-message-list")).toContainText("Back in the remote room");
  await expect(home.getByPlaceholder("Room offline")).toBeDisabled();
  await expect(home.getByTestId("chat-composer").getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(home.getByTestId("chat-composer").getByRole("button", { name: "Add 👍" })).toBeDisabled();

  await remote.getByRole("button", { name: "Start", exact: true }).click();
  await expect(remote.getByTestId("status-badge")).toHaveText("running", { timeout: 20_000 });
  await expect(home.getByPlaceholder("Message")).toBeEnabled({ timeout: 25_000 });
  await expect(remoteCoordinatorStatus).toHaveAttribute("data-state", "online", { timeout: 25_000 });

  await home.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const candidate = JSON.parse(raw) as { title?: string; anonymousSecretKey?: string };
      if (candidate.title !== "Remote lounge") continue;
      delete candidate.anonymousSecretKey;
      localStorage.setItem(key, JSON.stringify(candidate));
    }
  });
  await home.reload();
  const unlockPassphrase = home.getByPlaceholder("passphrase", { exact: true });
  if (await unlockPassphrase.isVisible()) {
    await unlockPassphrase.fill("room-navigation-passphrase");
    await home.getByRole("button", { name: "Unlock coordinator" }).click();
    await home.getByRole("button", { name: /Open room Remote lounge/ }).click();
  }
  await expect(home.getByTestId("chat-connection-status")).toHaveCount(0);
  await expect(home.getByTestId("guest-message-list")).toContainText("Back in the remote room");
  await expect(home.getByPlaceholder("Message")).toBeEnabled();
  await expect(home.getByTestId("reconnect-signer")).toHaveCount(0);

  await homeContext.close();
  await remoteContext.close();
});

test("persists relay and runtime configuration across reloads", async ({ page }) => {
  await page.goto("/");
  await configureMockRelay(page);
  const settings = await openCoordinatorSettings(page, true);
  await settings.getByLabel("Toggle announcement").check();
  await settings.getByTestId("max-users-input").fill("17");
  await settings.getByTestId("max-users-input").blur();
  await closeCoordinatorSettings(settings);

  await page.reload();

  const reloadedSettings = await openCoordinatorSettings(page);
  await expect(reloadedSettings.getByText(relay.url)).toBeVisible();
  await expect(reloadedSettings.getByText("wss://relay.contextvm.org")).toBeHidden();
  await expect(reloadedSettings.getByLabel("Toggle announcement")).toBeChecked();
  await expect(reloadedSettings.getByTestId("max-users-input")).toHaveValue("17");
  await closeCoordinatorSettings(reloadedSettings);
});

test("startup handoff keeps actions reachable", async ({ page }) => {
  await page.goto("/");
  await enablePersistence(page, "active-room-passphrase");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(page, "First room");
  await createRoom(page, "Second room");

  const firstRoom = page.locator(".channel-row").filter({ hasText: "First room" });
  await firstRoom.click();
  await expect(firstRoom).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const room = JSON.parse(raw) as { title?: string; identityOwner?: string };
      if (room.title === "First room") return room.identityOwner;
    }
    return null;
  })).toBe("anonymous");

  await page.reload();
  await page.getByPlaceholder("passphrase", { exact: true }).fill("active-room-passphrase");
  await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();

  await expect(page.getByTestId("status-badge")).toHaveText("idle");
  await expect(page.getByTestId("startup-ascii-field")).toBeVisible();
  await expect(page.getByTestId("host-message-list")).toBeHidden();
  const idleRail = page.getByTestId("invite-panel");
  const idleRoom = idleRail.getByRole("button", { name: /^Open room First room, hosted by/ });
  await expect(idleRail).toHaveAttribute("data-local-rail-state", "unavailable");
  await expect(idleRail).toHaveAttribute("aria-busy", "false");
  await expect(idleRail).toContainText("Coordinator offline");
  await expect(idleRoom).toBeDisabled();
  await expect(idleRail.locator(".channel-count")).toHaveCount(0);
  await expect(idleRail.getByRole("button", { name: "More actions for # First room" })).toHaveCount(0);
  await expect(idleRail.getByRole("button", { name: "New room" })).toHaveCount(0);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByTestId("startup-progress-panel")).toBeVisible();
  await expect(page.getByTestId("host-message-list")).toBeHidden();
  await expect(page.getByTestId("status-badge")).toHaveText("running", { timeout: 20_000 });
  await expect(idleRail).toHaveAttribute("data-local-rail-state", "ready");
  await expect(idleRoom).toBeEnabled();
  await expect(page.locator(".channel-row.active")).toContainText("First room");
  await expect(page.getByTestId("host-message-list")).toBeVisible();
  await expect(page.getByText("No channel selected")).toBeHidden();
});

test("a fresh empty hosted room survives refresh without depending on relay delivery", async ({ page }) => {
  test.setTimeout(90_000);
  const passphrase = "delayed-refresh-recovery-passphrase";
  const roomTitle = "Refresh recovery room";

  await page.goto("/");
  await enablePersistence(page, passphrase);
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(page, roomTitle);
  await expect(page.getByTestId("status-badge")).toHaveText("running");

  relay.setBroadcastDelay(2_100);
  try {
    await page.reload();
    await page.getByPlaceholder("passphrase", { exact: true }).fill(passphrase);
    await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();

    const rail = page.getByTestId("invite-panel");
    const roomButton = rail.getByRole("button", { name: new RegExp(`^Open room ${roomTitle}, hosted by`) });
    await expect(page.getByRole("button", { name: "Retry recovery" })).toHaveCount(0);
    await expect(page.getByTestId("status-badge")).toHaveText("running", { timeout: 45_000 });
    await expect(rail).toHaveAttribute("data-local-rail-state", "ready");
    await expect(rail).toHaveAttribute("aria-busy", "false");
    await expect(roomButton).toBeEnabled();
    await expect(rail.getByRole("button", { name: `More actions for # ${roomTitle}` })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Create group" })).toBeVisible();
    await expect(page.locator(".channel-row.active")).toContainText(roomTitle);
    await expect(page.getByTestId("host-message-list")).toBeVisible();
  } finally {
    relay.setBroadcastDelay(0);
  }
});

test("startup uses fluid masked ASCII ripple reveals", async ({ page }) => {
  const viewport = { width: 1280, height: 720 };
  await page.setViewportSize(viewport);
  await page.goto("/");
  await enablePersistence(page, "offline-host-room-passphrase");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(page, "Offline host room");

  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const room = JSON.parse(raw) as { isHost?: boolean; relayUrls?: string[]; title?: string };
      if (!room.isHost || room.title !== "Offline host room") continue;
      room.relayUrls = ["ws://127.0.0.1:1"];
      localStorage.setItem(key, JSON.stringify(room));
      return;
    }
    throw new Error("Could not find the persisted local host room");
  });

  await page.reload();
  await page.getByPlaceholder("passphrase", { exact: true }).fill("offline-host-room-passphrase");
  await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();

  const localStatus = page.getByTestId("selected-coordinator-status");
  await expect(page.getByTestId("status-badge")).toHaveText("idle");
  await expect(page.getByTestId("startup-ascii-field")).toBeVisible();
  await expect(page.getByTestId("host-message-list")).toBeHidden();
  await expect(localStatus).toHaveAttribute("data-state", "offline");
  await expect(localStatus).toHaveAttribute("aria-label", "Coordinator offline");
  await expectStartupFillsHostPane(page);
  const stage = page.locator(".startup-stage");
  await expect(stage).toHaveCSS("position", "absolute");
  await expectStartupMasks(page);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByTestId("startup-progress-panel")).toBeVisible();
  await expectStartupVisualContract(page);
  await expect(page.getByTestId("startup-ascii-field")).toHaveAttribute("data-motion-preference", "normal");
  await expect(page.getByTestId("startup-ascii-field")).toHaveAttribute("data-mode", "active");
  const bedTexture = page.getByTestId("startup-ascii-field").locator(".ascii-bed .ascii-texture");
  const initialTransform = await bedTexture.evaluate((element) => getComputedStyle(element).transform);
  await page.waitForTimeout(650);
  await expect.poll(() => bedTexture.evaluate((element) => getComputedStyle(element).transform)).not.toBe(initialTransform);
  await expect(page.getByTestId("startup-ascii-field")).toHaveAttribute("data-recovery-state", /idle|restoring|retrying|exhausted/);
  await expect(page.getByTestId("startup-ascii-field")).toHaveAttribute("data-forward-target", /\d+/);
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("status")).toBeVisible();
  await expectShellControlsUsable(page);
});

test("startup reduced motion stays static and readable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await configureMockRelay(page);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  const startup = page.getByTestId("startup-progress-panel");
  const field = page.getByTestId("startup-ascii-field");
  await expect(startup).toBeVisible();
  await expect(field).toHaveAttribute("data-motion-preference", "reduced");
  await expectStartupFillsHostPane(page);
  await expectStartupMasks(page);
  await expect(page.locator(".host-topbar")).toBeVisible();
  await expect(page.getByTestId("invite-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open management interface" })).toHaveCount(0);
  await expect(startup.getByRole("progressbar")).toBeVisible();
  await expect(startup.getByRole("status")).toBeVisible();

  const reducedVisualState = (element: HTMLElement) => {
    const displacement = element.querySelector<SVGFEDisplacementMapElement>(".ripple-displacement")!;
    const noise = element.querySelector<SVGFETurbulenceElement>(".ripple-noise")!;
    return {
      energy: getComputedStyle(element).getPropertyValue("--signal-energy"),
      planeTransform: getComputedStyle(element.querySelector(".ripple-plane")!).transform,
      maskTransform: getComputedStyle(element.querySelector(".ripple-mask-lines")!).transform,
      displacement: displacement.getAttribute("scale"),
      frequency: noise.getAttribute("baseFrequency"),
    };
  };
  const beforeVisualState = await field.evaluate(reducedVisualState);
  await page.waitForTimeout(650);
  await expect.poll(() => field.evaluate(reducedVisualState)).toEqual(beforeVisualState);
});

test("startup motion cleans up across repeated recovery cycles", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(page, "Cycle room");
  // Creating the first room mounts a settled normal-motion field. Keep this
  // assertion adjacent to that transition so a context-initialization error
  // cannot be hidden by later cleanup checks.
  expect(errors).toEqual([]);

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByTestId("status-badge")).toHaveText("idle");
    const field = page.getByTestId("startup-ascii-field");
    await expect(field).toHaveCount(1);
    await expect(field).toHaveAttribute("data-motion-preference", "normal");
    await expect(field.locator(".ascii-bed")).toHaveCount(1);
    await expect(field.locator(".ripple-mask-lines .ripple-contour")).toHaveCount(6);
    await expectShellControlsUsable(page);
    await expect(page.getByTestId("operator-shell")).toBeVisible();

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByTestId("status-badge")).toHaveText("running");
    await expect(page.getByTestId("startup-ascii-field")).toHaveCount(0);
    await expect(page.getByTestId("host-message-list")).toBeVisible();
    await expectShellControlsUsable(page);
  }

  expect(errors).toEqual([]);
});

test("startup covers every supported content pane", async ({ page }) => {
  const createdRoomTitle = "Content pane recovery room";
  const longRoomTitle = `Long <room> ${"recovery label ".repeat(18)}`;
  await page.goto("/");
  await enablePersistence(page, "content-pane-passphrase");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(page, createdRoomTitle);

  await page.evaluate(({ createdTitle, longTitle }) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("cordn-adhoc-chat-room:")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const room = JSON.parse(raw) as { isHost?: boolean; relayUrls?: string[]; title?: string };
      if (!room.isHost || room.title !== createdTitle) continue;
      room.title = longTitle;
      room.relayUrls = ["ws://127.0.0.1:1"];
      localStorage.setItem(key, JSON.stringify(room));
      return;
    }
    throw new Error("Could not find the persisted local host room");
  }, { createdTitle: createdRoomTitle, longTitle: longRoomTitle });

  await page.reload();
  await page.getByPlaceholder("passphrase", { exact: true }).fill("content-pane-passphrase");
  await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByTestId("startup-progress-panel")).toBeVisible();
  await expect(page.locator(".channel-row").filter({ hasText: longRoomTitle })).toBeVisible({ timeout: 20_000 });

  for (const viewport of [
    { width: 1024, height: 640 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expectShellControlsUsable(page);
    await expectNoDocumentOverflow(page, viewport);
    await expect(page.locator(".channel-row").filter({ hasText: longRoomTitle })).toBeVisible();
  }
});

test("blocks a second running coordinator for the same public key", async ({ page }) => {
  await page.goto("/");
  await enablePersistence(page, "single-instance-passphrase");
  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Single instance room");
  await expect(page.getByTestId("status-badge")).toHaveText("running");
  await expect(page.getByTestId("host-chat")).toBeVisible();

  const secondPage = await page.context().newPage();
  await secondPage.goto("/");
  await secondPage.getByPlaceholder("passphrase", { exact: true }).fill("single-instance-passphrase");
  await secondPage.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();
  await configureMockRelay(secondPage);
  await secondPage.getByRole("button", { name: "Start", exact: true }).click();

  await expect(secondPage.getByTestId("status-badge")).toHaveText("idle");
  await expect(secondPage.getByTestId("error-banner")).toContainText("cordn already running");
  await secondPage.getByRole("button", { name: "Open management interface" }).click();
  await expect(secondPage.getByTestId("management-log-entries")).toContainText("cordn already running");

  await secondPage.close();
});

test("rejects invalid relay URLs inline", async ({ page }) => {
  await page.goto("/");

  const settings = await openCoordinatorSettings(page, true);
  await settings.getByPlaceholder("wss://relay.example").fill("https://relay.example");
  await settings.getByRole("button", { name: "Add" }).click();
  await expect(settings.getByTestId("relay-error")).toContainText("ws:// or wss://");
  await closeCoordinatorSettings(settings);
});

test("persists encrypted key, rejects wrong passphrase, and unlocks after reload", async ({ page }) => {
  await page.goto("/");
  const initialNpub = await readCoordinatorNpub(page);

  await enablePersistence(page, "phase-two-passphrase");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock Cordn Ad-Hoc" })).toBeVisible();

  await page.getByPlaceholder("passphrase", { exact: true }).fill("wrong-passphrase");
  await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();
  await expect(page.getByTestId("passphrase-error")).toContainText("Wrong passphrase");

  await page.getByPlaceholder("passphrase", { exact: true }).fill("phase-two-passphrase");
  await page.getByTestId("coordinator-unlock").getByRole("button", { name: "Unlock coordinator" }).click();
  await expect(page.getByTestId("guided-start-state")).toBeVisible();
  await expect(page.getByTestId("status-badge")).toBeHidden();
  expect(await readCoordinatorNpub(page)).toBe(initialNpub);
});

test("exports a persisted coordinator as a password-verified encrypted backup", async ({ page }) => {
  await page.goto("/");

  let settings = await openCoordinatorSettings(page);
  await expect(settings.getByRole("button", { name: "Export backup" })).toHaveCount(0);
  await closeCoordinatorSettings(settings);

  const passphrase = "portable-coordinator-passphrase";
  await enablePersistence(page, passphrase);

  settings = await openCoordinatorSettings(page);
  await settings.getByRole("button", { name: "Export backup" }).click();
  const exportDialog = page.getByTestId("coordinator-export-dialog");
  await expect(exportDialog).toBeVisible();
  await expect(exportDialog.getByLabel("Current passphrase")).toBeFocused();

  await exportDialog.getByRole("button", { name: "Download backup" }).click();
  await expect(exportDialog.getByTestId("export-error")).toContainText("Passphrase is required");

  await exportDialog.getByLabel("Current passphrase").fill("wrong-passphrase");
  await exportDialog.getByRole("button", { name: "Download backup" }).click();
  await expect(exportDialog.getByTestId("export-error")).toContainText("Wrong passphrase");
  await expect(exportDialog).toBeVisible();

  const persistedKey = await page.evaluate(() => JSON.parse(localStorage.getItem("cordn:v1:persistence") ?? "null"));
  await exportDialog.getByLabel("Current passphrase").fill(passphrase);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportDialog.getByRole("button", { name: "Download backup" }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^cordn-npub1.+\.backup\.json$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const backupText = await readFile(downloadPath ?? "", "utf8");
  const backup = JSON.parse(backupText) as {
    format: string;
    version: number;
    identity: { publicKeyHex: string; npub: string };
    encryptedKey: unknown;
  };
  expect(backup).toMatchObject({
    format: "cordn.coordinator-key-backup",
    version: 1,
    identity: {
      publicKeyHex: expect.stringMatching(/^[0-9a-f]{64}$/),
      npub: expect.stringMatching(/^npub1/),
    },
    encryptedKey: persistedKey,
  });
  expect(backupText).not.toContain(passphrase);
  expect(backupText).not.toContain("nsec1");
  await expect(exportDialog).toBeHidden();
  await expect(settings.getByRole("status")).toHaveText("Encrypted backup downloaded");

  await settings.getByRole("button", { name: "Edit settings" }).click();
  await settings.getByRole("button", { name: "Remove saved key" }).click();
  await expect(settings.getByRole("button", { name: "Export backup" })).toHaveCount(0);
  await closeCoordinatorSettings(settings);
});

test("destroys persisted state after explicit confirmation", async ({ page }) => {
  await page.goto("/");
  const initialNpub = await readCoordinatorNpub(page);

  await enablePersistence(page, "destroy-passphrase");
  await page.evaluate(async () => {
    const cache = await caches.open("cordn-test-cache");
    await cache.put("/cache-proof", new Response("cached coordinator state"));
  });
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("cordn-test-cache"))).toBe(true);

  await configureMockRelay(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(page);
  await createRoom(page, "Destruction fixture");
  await page.getByRole("button", { name: "Destroy" }).click();
  await page.getByTestId("confirm-destroy").click();
  const setup = page.getByTestId("coordinator-setup");
  await expect(setup).toHaveAttribute("data-setup-state", "identity");
  await expect.poll(() => page.evaluate(() => Array.from(
    { length: localStorage.length },
    (_, index) => localStorage.key(index),
  ).filter((key): key is string => key !== null && key.startsWith("cordn:")).sort()))
    .toEqual(["cordn:v1:anonymous-identity"]);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cordn:v1:persistence"))).toBeNull();
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("cordn-test-cache"))).toBe(false);
  await setup.getByTestId("setup-anonymous").click();
  await setup.getByTestId("setup-coordinator-name").fill("Replacement coordinator");
  await setup.getByTestId("setup-save").click();
  await setup.getByTestId("setup-advanced").click();
  await setup.getByTestId("setup-ephemeral").click();
  await setup.getByTestId("setup-advanced-persistence").getByRole("button", { name: "Continue to relays", exact: true }).click();
  await setup.getByTestId("setup-advanced-relays").getByRole("button", { name: "Continue to announcement", exact: true }).click();
  await setup.getByTestId("setup-advanced-announce").getByRole("button", { name: "Continue to autostart", exact: true }).click();
  await setup.getByTestId("setup-advanced-autostart").getByRole("button").filter({ hasText: /^No/ }).click();
  await setup.getByTestId("setup-finish").click();
  const backToCoordinator = page.getByRole("button", { name: "Back to my coordinator" }).first();
  if (await backToCoordinator.isVisible()) await backToCoordinator.click();
  await expect(page.getByTestId("guided-start-state")).toBeVisible();
  expect(await readCoordinatorNpub(page)).not.toBe(initialNpub);
});

test("in-session invite redemption preserves the running home coordinator", async ({ browser }) => {
  test.setTimeout(90_000);
  const hostAContext = await browser.newContext();
  const hostA = await hostAContext.newPage();
  await installEstablishedInstallation(hostA);
  await hostA.goto("/");
  await configureMockRelay(hostA);
  await hostA.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(hostA);
  await createRoom(hostA, "Redeemable room");
  const inviteLink = await hostA.getByTestId("invite-link").textContent();
  const remoteCoordinatorPubkey = await hostA.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("cordn-adhoc-chat-room:v2:"))
    .map(([, value]) => JSON.parse(value ?? "{}") as { title?: string; coordinatorPubkey?: string })
    .find((room) => room.title === "Redeemable room")?.coordinatorPubkey);
  expect(remoteCoordinatorPubkey).toMatch(/^[0-9a-f]{64}$/);

  const hostBContext = await browser.newContext();
  const hostB = await hostBContext.newPage();
  await installEstablishedInstallation(hostB);
  await hostB.goto("/");
  await configureMockRelay(hostB);
  await hostB.getByRole("button", { name: "Start", exact: true }).click();
  await expectGuidedCoordinatorOnline(hostB);
  await hostB.evaluate(() => { (window as typeof window & { __inviteRedeemSentinel?: boolean }).__inviteRedeemSentinel = true; });

  await hostB.getByTestId("coordinator-empty-content").getByRole("button", { name: "Join from invite" }).click();
  const redeemer = hostB.getByTestId("invite-redeemer");
  await redeemer.getByLabel("Invite link").fill("this is not an invite");
  await redeemer.getByRole("button", { name: "Join invite" }).click();
  await expect(redeemer.getByRole("alert")).toContainText("valid invite link");
  await expect(hostB).toHaveURL(/\/$/);

  const foreignOriginInvite = new URL(inviteLink!);
  foreignOriginInvite.protocol = "https:";
  foreignOriginInvite.hostname = "invite.example.test";
  foreignOriginInvite.port = "";
  foreignOriginInvite.searchParams.set(
    "m",
    Buffer.from(JSON.stringify({ name: "Redeemable room" })).toString("base64url"),
  );
  foreignOriginInvite.searchParams.delete("i");
  await redeemer.getByLabel("Invite link").fill(foreignOriginInvite.href);
  await redeemer.getByRole("button", { name: "Join invite" }).click();
  await expect(hostB.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });
  expect(new URL(hostB.url()).origin).toBe(new URL(await hostB.evaluate(() => window.location.origin)).origin);
  expect(await hostB.evaluate(() => (window as typeof window & { __inviteRedeemSentinel?: boolean }).__inviteRedeemSentinel)).toBe(true);
  expect(await hostB.evaluate((coordinatorPubkey) => Object.keys(localStorage)
    .some((key) => key.startsWith(`cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:`)), remoteCoordinatorPubkey!)).toBe(true);

  await createRoom(hostA, "Fresh anonymous redemption room");
  const freshInviteLink = await hostA.getByTestId("invite-link").textContent();
  expect(freshInviteLink).toBeTruthy();

  await hostB.getByRole("link", { name: "CAHMLS home" }).click();
  await expectGuidedCoordinatorOnline(hostB);
  await hostB.getByTestId("coordinator-empty-content").getByRole("button", { name: "Join from invite" }).click();
  const repeatRedeemer = hostB.getByTestId("invite-redeemer");
  await repeatRedeemer.getByLabel("Invite link").fill(freshInviteLink!);
  await repeatRedeemer.getByRole("button", { name: "Join invite" }).click();
  expect(await hostB.getByText("Choose a name, then join the encrypted room. This invite connects only to its host coordinator.").count()).toBe(0);
  await expect(hostB.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });
  await hostAContext.close();
  await hostBContext.close();
});

test("invite camera scanner uses the redemption path and releases camera tracks", async ({ browser }) => {
  test.setTimeout(90_000);
  const hostAContext = await browser.newContext();
  const hostA = await hostAContext.newPage();
  await installEstablishedInstallation(hostA);
  await hostA.goto("/");
  await configureMockRelay(hostA);
  await hostA.getByRole("button", { name: "Start", exact: true }).click();
  await createRoom(hostA, "Scanned room");
  const inviteLink = await hostA.getByTestId("invite-link").textContent();

  const hostBContext = await browser.newContext();
  await hostBContext.addInitScript(() => {
    const testWindow = window as typeof window & {
      __cameraTrackStops?: number;
      __barcodeDetections?: number;
      __qrPayload?: string;
    };
    testWindow.__cameraTrackStops = 0;
    testWindow.__barcodeDetections = 0;
    const stream = new MediaStream();
    Object.defineProperty(stream, "getTracks", {
      value: () => [{ stop: () => { testWindow.__cameraTrackStops = (testWindow.__cameraTrackStops ?? 0) + 1; } }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    class MockBarcodeDetector {
      async detect(): Promise<Array<{ rawValue: string }>> {
        testWindow.__barcodeDetections = (testWindow.__barcodeDetections ?? 0) + 1;
        return testWindow.__qrPayload ? [{ rawValue: testWindow.__qrPayload }] : [];
      }
    }
    Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: MockBarcodeDetector });
  });
  const hostB = await hostBContext.newPage();
  await installEstablishedInstallation(hostB);
  await hostB.goto("/");
  await configureMockRelay(hostB);
  await hostB.getByRole("button", { name: "Start", exact: true }).click();
  await hostB.evaluate(() => { (window as typeof window & { __qrPayload?: string }).__qrPayload = "not an invite"; });

  await hostB.getByTestId("coordinator-empty-content").getByRole("button", { name: "Join from invite" }).click();
  const redeemer = hostB.getByTestId("invite-redeemer");
  await redeemer.getByRole("button", { name: "Scan QR code" }).click();
  await expect(redeemer.getByRole("alert")).toContainText("valid invite link");
  await hostB.evaluate((payload) => { (window as typeof window & { __qrPayload?: string }).__qrPayload = payload; }, inviteLink!);
  await expect(hostB.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });
  await expect.poll(() => hostB.evaluate(() => (window as typeof window & { __barcodeDetections?: number }).__barcodeDetections ?? 0)).toBeGreaterThan(0);
  await expect.poll(() => hostB.evaluate(() => (window as typeof window & { __cameraTrackStops?: number }).__cameraTrackStops ?? 0)).toBeGreaterThan(0);

  await hostB.getByRole("link", { name: "CAHMLS home" }).click();
  await hostB.evaluate(() => { (window as typeof window & { __qrPayload?: string }).__qrPayload = undefined; });
  await hostB.getByTestId("coordinator-empty-content").getByRole("button", { name: "Join from invite" }).click();
  await redeemer.getByRole("button", { name: "Scan QR code" }).click();
  await expect.poll(() => hostB.evaluate(() => (window as typeof window & { __barcodeDetections?: number }).__barcodeDetections ?? 0)).toBeGreaterThan(1);
  await hostB.keyboard.press("Escape");
  await expect(redeemer).toBeHidden();
  await expect.poll(() => hostB.evaluate(() => (window as typeof window & { __cameraTrackStops?: number }).__cameraTrackStops ?? 0)).toBeGreaterThan(1);

  await hostB.evaluate(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); } },
    });
  });
  await hostB.getByTestId("coordinator-empty-content").getByRole("button", { name: "Join from invite" }).click();
  await redeemer.getByRole("button", { name: "Scan QR code" }).click();
  await expect(redeemer.getByRole("alert")).toContainText("permission was denied");
  await expect(redeemer.getByRole("button", { name: "Join invite" })).toBeEnabled();
  await redeemer.getByRole("button", { name: "Close invite redemption" }).last().click();

  await hostB.evaluate(() => { Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: undefined }); });
  await hostB.getByTestId("coordinator-empty-content").getByRole("button", { name: "Join from invite" }).click();
  await redeemer.getByRole("button", { name: "Scan QR code" }).click();
  await expect(redeemer.getByRole("alert")).toContainText("QR scanning is not available");
  await expect(redeemer.getByRole("button", { name: "Join invite" })).toBeEnabled();
  await redeemer.getByRole("button", { name: "Close invite redemption" }).last().click();

  await hostB.evaluate(() => { Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined }); });
  await hostB.getByTestId("coordinator-empty-content").getByRole("button", { name: "Join from invite" }).click();
  await redeemer.getByRole("button", { name: "Scan QR code" }).click();
  await expect(redeemer.getByRole("alert")).toContainText("Camera access is not available");
  await expect(redeemer.getByRole("button", { name: "Join invite" })).toBeEnabled();
  await redeemer.getByRole("button", { name: "Close invite redemption" }).last().click();
  await hostAContext.close();
  await hostBContext.close();
});
