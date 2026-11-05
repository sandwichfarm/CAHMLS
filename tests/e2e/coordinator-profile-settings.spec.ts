import { expect, test, type Locator, type Page } from "@playwright/test";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools";

import { startMockRelay, type MockRelay, type PublicRelayEvent } from "../../packages/sdk/tests/support/mock-relay";

const configStorageKey = "cordn:v1:config";
const primaryRelayUrl = "wss://profile-primary.example.test";
const secondaryRelayUrl = "wss://profile-secondary.example.test";
const appUrl = process.env.E2E_BASE_URL ?? "/";

let primaryRelay: MockRelay;
let secondaryRelay: MockRelay;

test.beforeAll(async () => {
  primaryRelay = await startMockRelay(8894);
  secondaryRelay = await startMockRelay(8895);
});

test.afterAll(async () => {
  await Promise.all([primaryRelay.close(), secondaryRelay.close()]);
});

test.beforeEach(() => {
  primaryRelay.setPublishAcknowledgement(true);
  secondaryRelay.setPublishAcknowledgement(true);
});

async function installRelayRoute(page: Page): Promise<void> {
  await page.addInitScript(({ primaryRelayUrl, secondaryRelayUrl, primaryRelayTarget, secondaryRelayTarget }) => {
    const NativeWebSocket = window.WebSocket;
    const RoutedWebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const target = String(args[0] ?? "");
        if (target.startsWith(primaryRelayUrl)) {
          return Reflect.construct(Target, [primaryRelayTarget, ...args.slice(1)]);
        }
        if (target.startsWith(secondaryRelayUrl)) {
          return Reflect.construct(Target, [secondaryRelayTarget, ...args.slice(1)]);
        }
        return Reflect.construct(Target, args);
      },
    });
    Object.defineProperty(window, "WebSocket", { configurable: true, value: RoutedWebSocket });
  }, {
    primaryRelayUrl,
    secondaryRelayUrl,
    primaryRelayTarget: primaryRelay.url,
    secondaryRelayTarget: secondaryRelay.url,
  });
}

async function openRunningCoordinatorSettings(page: Page): Promise<Locator> {
  await page.addInitScript(({ storageKey, primaryRelayUrl, secondaryRelayUrl }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      relays: [
        { id: "profile-primary", url: primaryRelayUrl, enabled: true },
        { id: "profile-secondary", url: secondaryRelayUrl, enabled: true },
      ],
      announce: false,
      maxUsers: 16,
      autostart: false,
      coordinatorName: "Before rename",
      setupCompleted: true,
      presenceState: "invisible",
    }));
  }, { storageKey: configStorageKey, primaryRelayUrl, secondaryRelayUrl });
  await installRelayRoute(page);
  await page.goto(appUrl);

  await expect(page.getByTestId("guided-start-state")).toBeVisible();
  await page.getByTestId("coordinator-start").click();
  await expect(page.getByText("Coordinator online", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const createRoom = page.getByTestId("create-room-dialog");
  await createRoom.getByPlaceholder("Friday plans").fill("Profile rename room");
  await createRoom.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(createRoom).toBeHidden();
  await expect(page.getByTestId("invite-panel")).toHaveAttribute("data-local-rail-state", "ready", { timeout: 15_000 });
  const settingsTrigger = page.getByRole("button", { name: /^Settings for / });
  if (!(await settingsTrigger.isVisible())) {
    await page.getByRole("button", { name: "Open room browser" }).click();
  }
  await settingsTrigger.click();
  const settings = page.getByTestId("coordinator-settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Edit settings" }).click();
  return settings;
}

function signedProfileEvent(event: PublicRelayEvent): NostrEvent {
  if (
    typeof event.id !== "string"
    || typeof event.pubkey !== "string"
    || typeof event.created_at !== "number"
    || typeof event.content !== "string"
    || typeof event.sig !== "string"
  ) {
    throw new Error("Mock relay returned incomplete public event observation");
  }
  return {
    id: event.id,
    kind: event.kind ?? -1,
    pubkey: event.pubkey,
    created_at: event.created_at,
    tags: event.tags ?? [],
    content: event.content,
    sig: event.sig,
  };
}

function newKindZeroEvents(relay: MockRelay, before: number): PublicRelayEvent[] {
  return relay.events().filter((event) => event.kind === 0).slice(before);
}

test("rename publishes a signed coordinator profile with mixed acknowledgement only after explicit save", async ({ page }) => {
  secondaryRelay.setPublishAcknowledgement(false);
  const settings = await openRunningCoordinatorSettings(page);
  const name = settings.getByLabel("Coordinator name", { exact: true });
  const coordinatorPubkey = await page.getByTestId("selected-coordinator-status").getAttribute("data-coordinator-pubkey");
  const primaryEventsBefore = primaryRelay.events().filter((event) => event.kind === 0).length;
  const secondaryEventsBefore = secondaryRelay.events().filter((event) => event.kind === 0).length;

  await expect(name).toHaveValue("Before rename");
  await expect(settings.getByText("This public coordinator name is separate from your operator profile.", { exact: true })).toBeVisible();
  await name.fill("Renamed coordinator");
  const save = settings.getByRole("button", { name: "Save coordinator name", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(settings.getByTestId("coordinator-name-publication")).toHaveAttribute("data-publication-state", "published");
  await expect(settings.getByRole("status")).toContainText("Coordinator name published.");
  await expect(page.getByTestId("restart-required")).toContainText("published now");

  await expect.poll(() => newKindZeroEvents(primaryRelay, primaryEventsBefore)).toHaveLength(1);
  await expect.poll(() => newKindZeroEvents(secondaryRelay, secondaryEventsBefore)).toHaveLength(1);
  const primaryEvents = newKindZeroEvents(primaryRelay, primaryEventsBefore);
  const secondaryEvents = newKindZeroEvents(secondaryRelay, secondaryEventsBefore);
  for (const event of [...primaryEvents, ...secondaryEvents]) {
    const signed = signedProfileEvent(event);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.pubkey === coordinatorPubkey).toBe(true);
    expect(JSON.parse(signed.content)).toMatchObject({ name: "Renamed coordinator" });
  }
  expect(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").coordinatorName, configStorageKey)).toBe("Renamed coordinator");
});

test("invalid name never saves or publishes", async ({ page }) => {
  const settings = await openRunningCoordinatorSettings(page);
  const name = settings.getByLabel("Coordinator name", { exact: true });
  const before = primaryRelay.events().filter((event) => event.kind === 0).length;

  await name.fill("   ");
  await name.blur();
  await expect(settings.getByTestId("coordinator-name-error")).toHaveText("Enter a coordinator name to continue.");
  await expect(settings.getByRole("button", { name: "Save coordinator name", exact: true })).toBeDisabled();
  expect(newKindZeroEvents(primaryRelay, before)).toEqual([]);
  expect(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").coordinatorName, configStorageKey)).toBe("Before rename");
});

test("restart applies the persisted coordinator name without replacing the coordinator identity", async ({ page }) => {
  const settings = await openRunningCoordinatorSettings(page);
  const coordinatorPubkey = await page.getByTestId("selected-coordinator-status").getAttribute("data-coordinator-pubkey");
  await settings.getByLabel("Coordinator name", { exact: true }).fill("Restarted coordinator");
  await settings.getByRole("button", { name: "Save coordinator name", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Coordinator name published.");
  await settings.getByRole("button", { name: "Restart to apply", exact: true }).click();
  await expect(settings.getByTestId("restart-required")).toHaveCount(0);
  await expect(page.getByTestId("selected-coordinator-status")).toHaveAttribute("data-coordinator-pubkey", coordinatorPubkey ?? "");
  expect(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").coordinatorName, configStorageKey)).toBe("Restarted coordinator");
});

test("failure retains the running coordinator and retries with the saved name", async ({ page }) => {
  const settings = await openRunningCoordinatorSettings(page);
  const coordinatorPubkey = await page.getByTestId("selected-coordinator-status").getAttribute("data-coordinator-pubkey");
  primaryRelay.setPublishAcknowledgement(false);
  secondaryRelay.setPublishAcknowledgement(false);
  const beforeRetry = primaryRelay.events().filter((event) => event.kind === 0).length;

  await settings.getByLabel("Coordinator name", { exact: true }).fill("Retry coordinator");
  await settings.getByRole("button", { name: "Save coordinator name", exact: true }).click();
  const failure = settings.getByRole("alert");
  await expect(failure).toHaveText("Couldn’t publish the coordinator profile. The coordinator name is saved locally and the coordinator is still running. Try again.");
  await expect(settings.getByRole("button", { name: "Retry publishing", exact: true })).toBeEnabled();
  await expect(page.getByTestId("selected-coordinator-status")).toHaveAttribute("data-coordinator-pubkey", coordinatorPubkey ?? "");
  expect(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").coordinatorName, configStorageKey)).toBe("Retry coordinator");
  const persistedBeforeRetry = await page.evaluate((storageKey) => localStorage.getItem(storageKey), configStorageKey);

  primaryRelay.setPublishAcknowledgement(true);
  secondaryRelay.setPublishAcknowledgement(true);
  await settings.getByRole("button", { name: "Retry publishing", exact: true }).click();
  await expect(settings.getByTestId("coordinator-name-publication")).toHaveAttribute("data-publication-state", "published");
  expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), configStorageKey)).toBe(persistedBeforeRetry);
  await expect.poll(() => newKindZeroEvents(primaryRelay, beforeRetry)).toHaveLength(2);
});

test("duplicate save is suppressed while publishing", async ({ page }) => {
  const settings = await openRunningCoordinatorSettings(page);
  primaryRelay.setPublishAcknowledgement(true, 500);
  secondaryRelay.setPublishAcknowledgement(true, 500);
  const primaryBefore = primaryRelay.events().filter((event) => event.kind === 0).length;
  const secondaryBefore = secondaryRelay.events().filter((event) => event.kind === 0).length;
  await settings.getByLabel("Coordinator name", { exact: true }).fill("Single publication");
  const save = settings.getByRole("button", { name: "Save coordinator name", exact: true });

  await save.dblclick();
  await expect(settings.getByTestId("coordinator-name-publication")).toHaveAttribute("data-publication-state", "publishing");
  await expect(settings.getByRole("button", { name: "Publishing…", exact: true })).toBeDisabled();
  await expect.poll(() => newKindZeroEvents(primaryRelay, primaryBefore)).toHaveLength(1);
  await expect.poll(() => newKindZeroEvents(secondaryRelay, secondaryBefore)).toHaveLength(1);
  await expect(settings.getByTestId("coordinator-name-publication")).toHaveAttribute("data-publication-state", "published");
});

test("failure copy is secret-safe and identity controls remain usable at responsive sizes", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 360 });
  const settings = await openRunningCoordinatorSettings(page);
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  primaryRelay.setPublishAcknowledgement(false);
  secondaryRelay.setPublishAcknowledgement(false);
  await settings.getByLabel("Coordinator name", { exact: true }).fill("Private retry");
  await settings.getByRole("button", { name: "Save coordinator name", exact: true }).click();
  const failure = settings.getByRole("alert");
  await expect(failure).toBeVisible();
  await expect(settings.getByRole("button", { name: "Retry publishing", exact: true })).toBeVisible();
  const layout = await settings.getByTestId("coordinator-name-publication").evaluate((element) => {
    const section = element.closest(".identity-section")?.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll<HTMLButtonElement>("button")).map((button) => button.getBoundingClientRect());
    const bounds = element.getBoundingClientRect();
    return {
      contained: section !== undefined && bounds.left >= section.left && bounds.right <= section.right,
      controlsAreTouchSized: controls.every((control) => control.height >= 44),
    };
  });
  expect(layout).toEqual({ contained: true, controlsAreTouchSized: true });

  const visibleFailure = await failure.innerText();
  const forbidden = /wss?:\/\/|MCP error|Error:|at \S+\(|bunker:|[0-9a-f]{64,}|[0-9a-f]{128,}/i;
  expect(visibleFailure).not.toMatch(forbidden);
  expect(consoleMessages.join("\n")).not.toMatch(forbidden);
});
