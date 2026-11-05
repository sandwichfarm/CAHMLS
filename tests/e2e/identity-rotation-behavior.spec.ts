import { expect, test, type Page } from "./established-installation-fixture";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

const identityStorageKey = "cordn:v1:anonymous-identity";
const recoveryBoundaryKey = "cordn:v1:anonymous-identity-recovery";

type BoundaryMode = "continue" | "fail-once";

interface BoundarySnapshot {
  title: string | null;
  dialogOpen: boolean;
  primaryText: string | null;
  controls: Array<{ text: string; disabled: boolean }>;
  liveText: string | null;
  livePoliteness: string | null;
  cancelPrevented: boolean;
  openAfterCancel: boolean;
  openAfterBackdrop: boolean;
  identityRaw: string | null;
  avatar: string | null;
  authorityRaw: string | null;
}

interface AnonymousIdentitySnapshot {
  raw: string;
  pubkey: string;
  avatar: string;
}

interface StoredAuthorityFixture {
  key: string;
  raw: string;
}

async function installBoundaryProbe(page: Page, mode: BoundaryMode): Promise<void> {
  await page.addInitScript(({ boundaryKey, identityKey, probeMode }) => {
    const testWindow = window as typeof window & {
      __identityBoundaryRoomKey?: string;
      __identityBoundarySnapshots?: BoundarySnapshot[];
    };
    const originalSetItem = Storage.prototype.setItem;
    const originalGetItem = Storage.prototype.getItem;
    let failureInjected = false;
    testWindow.__identityBoundarySnapshots = [];

    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if (this === window.localStorage && key === boundaryKey) {
        const dialog = document.querySelector<HTMLDialogElement>('[data-testid="identity-rotation-dialog"]');
        const controls = dialog ? Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")) : [];
        const primary = controls.at(-1) ?? null;
        const live = dialog?.querySelector<HTMLElement>('[aria-live="polite"]') ?? null;
        const cancelPrevented = dialog
          ? !dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
          : false;
        const openAfterCancel = dialog?.open ?? false;
        dialog?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        testWindow.__identityBoundarySnapshots?.push({
          title: dialog?.querySelector("h2")?.textContent?.trim() ?? null,
          dialogOpen: dialog?.open ?? false,
          primaryText: primary?.textContent?.trim() ?? null,
          controls: controls.map((control) => ({
            text: control.textContent?.trim() ?? "",
            disabled: control.disabled,
          })),
          liveText: live?.textContent?.trim() ?? null,
          livePoliteness: live?.getAttribute("aria-live") ?? null,
          cancelPrevented,
          openAfterCancel,
          openAfterBackdrop: dialog?.open ?? false,
          identityRaw: originalGetItem.call(window.localStorage, identityKey),
          avatar: document.querySelector<HTMLImageElement>('[data-testid="user-profile"] img')?.getAttribute("src") ?? null,
          authorityRaw: testWindow.__identityBoundaryRoomKey
            ? originalGetItem.call(window.localStorage, testWindow.__identityBoundaryRoomKey)
            : null,
        });

        if (probeMode === "fail-once" && !failureInjected) {
          failureInjected = true;
          return;
        }
      }
      originalSetItem.call(this, key, value);
    };
  }, {
    boundaryKey: recoveryBoundaryKey,
    identityKey: identityStorageKey,
    probeMode: mode,
  });
}

async function currentIdentity(page: Page): Promise<AnonymousIdentitySnapshot> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), identityStorageKey);
  if (raw === null) throw new Error("Expected a persisted anonymous identity");
  const record = JSON.parse(raw) as { version?: unknown; secretKeyHex?: unknown };
  if (record.version !== 1 || typeof record.secretKeyHex !== "string") {
    throw new Error("Expected a valid persisted anonymous identity");
  }
  const avatar = await page.getByTestId("user-profile").locator(".user-trigger img").getAttribute("src");
  if (avatar === null) throw new Error("Expected the anonymous identity avatar");
  return {
    raw,
    pubkey: getPublicKey(hexToBytes(record.secretKeyHex)),
    avatar,
  };
}

async function seedAnonymousAuthority(
  page: Page,
  stablePubkey: string,
  roomId: string,
): Promise<StoredAuthorityFixture> {
  return page.evaluate(({ roomId, stablePubkey }) => {
    const coordinatorPubkey = "a".repeat(64);
    const key = `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(roomId)}`;
    const raw = JSON.stringify({
      version: 1,
      id: roomId,
      title: "Rotation boundary room",
      coordinatorPubkey,
      relayUrls: ["wss://relay.example"],
      name: "River",
      stablePubkey,
      identityOwner: "anonymous",
      isHost: false,
      stateBase64: "private-state-before-rotation",
      keyPackage: {
        reference: "private-reference",
        publicBase64: "public-package",
        privateBase64: "private-package",
      },
      lastCursor: 0,
      messages: [],
      pending: [],
      inviteToken: "private-invite-token",
    });
    localStorage.setItem(key, raw);
    (window as typeof window & { __identityBoundaryRoomKey?: string }).__identityBoundaryRoomKey = key;
    return { key, raw };
  }, { roomId, stablePubkey });
}

async function seedRecoveryState(page: Page): Promise<StoredAuthorityFixture> {
  const roomId = "recovery-boundary-room";
  const coordinatorPubkey = "b".repeat(64);
  const key = `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(roomId)}`;
  const raw = JSON.stringify({
    version: 1,
    id: roomId,
    title: "Recovery boundary room",
    coordinatorPubkey,
    relayUrls: ["wss://relay.example"],
    name: "River",
    stablePubkey: "c".repeat(64),
    identityOwner: "anonymous",
    isHost: false,
    stateBase64: "private-state-before-recovery",
    keyPackage: {
      reference: "recovery-private-reference",
      publicBase64: "recovery-public-package",
      privateBase64: "recovery-private-package",
    },
    lastCursor: 0,
    messages: [],
    pending: [],
    inviteToken: "recovery-private-invite-token",
  });

  await page.addInitScript(({ identityKey, roomKey, roomRaw }) => {
    localStorage.setItem(identityKey, "{");
    localStorage.setItem(roomKey, roomRaw);
    (window as typeof window & { __identityBoundaryRoomKey?: string }).__identityBoundaryRoomKey = roomKey;
  }, { identityKey: identityStorageKey, roomKey: key, roomRaw: raw });
  return { key, raw };
}

async function boundarySnapshots(page: Page): Promise<BoundarySnapshot[]> {
  return page.evaluate(() => (
    (window as typeof window & { __identityBoundarySnapshots?: BoundarySnapshot[] })
      .__identityBoundarySnapshots ?? []
  ));
}

async function storedAuthority(page: Page, key: string): Promise<Record<string, unknown>> {
  const raw = await page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
  if (raw === null) throw new Error("Expected stored room authority");
  return JSON.parse(raw) as Record<string, unknown>;
}

function expectLockedBoundary(
  snapshot: BoundarySnapshot,
  expected: { title: string; primary: string; controls: number },
): void {
  expect(snapshot).toMatchObject({
    title: expected.title,
    dialogOpen: true,
    primaryText: expected.primary,
    liveText: expected.primary,
    livePoliteness: "polite",
    cancelPrevented: true,
    openAfterCancel: true,
    openAfterBackdrop: true,
  });
  expect(snapshot.controls).toHaveLength(expected.controls);
  expect(snapshot.controls.every(({ disabled }) => disabled)).toBe(true);
}

async function openRotationDialog(page: Page): Promise<ReturnType<Page["getByTestId"]>> {
  const profile = page.getByTestId("user-profile");
  await profile.getByRole("button", { name: /^Open profile for / }).click();
  const menu = page.getByRole("dialog", { name: "User profile" });
  await menu.getByRole("button", { name: "Rotate identity…" }).click();
  const dialog = page.getByTestId("identity-rotation-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("locks a confirmed rotation until the replacement identity succeeds", async ({ page }) => {
  await installBoundaryProbe(page, "continue");
  await page.goto("/");
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  const original = await currentIdentity(page);
  const authority = await seedAnonymousAuthority(page, original.pubkey, "rotation-in-flight-room");
  const dialog = await openRotationDialog(page);

  await expect(dialog).toContainText("You will lose access to 1 channel. It will be moved to History.");
  await dialog.getByRole("button", { name: "Rotate identity" }).click();
  await expect(dialog).toBeHidden();

  const snapshots = await boundarySnapshots(page);
  expect(snapshots).toHaveLength(1);
  const [snapshot] = snapshots;
  expectLockedBoundary(snapshot, {
    title: "Rotate local identity?",
    primary: "Rotating…",
    controls: 3,
  });
  expect(snapshot.identityRaw).toBe(original.raw);
  expect(snapshot.avatar).toBe(original.avatar);
  expect(snapshot.authorityRaw).toBe(authority.raw);

  const replacement = await currentIdentity(page);
  expect(replacement.raw).not.toBe(original.raw);
  expect(replacement.pubkey).not.toBe(original.pubkey);
  expect(replacement.avatar).not.toBe(original.avatar);
  await expect(storedAuthority(page, authority.key)).resolves.toMatchObject({
    membershipStatus: "retired",
    stateBase64: "",
    keyPackage: { reference: "", publicBase64: "", privateBase64: "" },
  });
  const history = page.getByTestId("sidebar-history");
  await expect(history.getByRole("button", { name: /History 1/ })).toHaveAttribute("aria-expanded", "false");
  await history.getByRole("button", { name: /History 1/ }).click();
  await expect(history).toContainText("Rotation boundary room");
  await expect(history).toContainText("Identity retired");
});

test("locks explicit recovery until the new local identity succeeds", async ({ page }) => {
  await installBoundaryProbe(page, "continue");
  const authority = await seedRecoveryState(page);
  await page.goto("/");

  const dialog = page.getByTestId("identity-rotation-dialog");
  await expect(dialog.getByRole("heading", { name: "Recover local identity" })).toBeVisible();
  await expect(page.getByTestId("user-profile").locator(".user-trigger")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create new identity" }).click();
  await expect(dialog).toBeHidden();

  const snapshots = await boundarySnapshots(page);
  expect(snapshots).toHaveLength(1);
  const [snapshot] = snapshots;
  expectLockedBoundary(snapshot, {
    title: "Recover local identity",
    primary: "Creating…",
    controls: 1,
  });
  expect(snapshot.identityRaw).toBe("{");
  expect(snapshot.avatar).toBeNull();
  expect(snapshot.authorityRaw).toBe(authority.raw);

  const replacement = await currentIdentity(page);
  expect(replacement.raw).not.toBe("{");
  await expect(storedAuthority(page, authority.key)).resolves.toMatchObject({
    membershipStatus: "retired",
    stateBase64: "",
    keyPackage: { reference: "", publicBase64: "", privateBase64: "" },
  });
});

test("keeps identity and room authority retryable after a pre-boundary failure", async ({ page }) => {
  await installBoundaryProbe(page, "fail-once");
  await page.goto("/");
  await expect(page.getByTestId("operator-shell")).toBeVisible();
  const original = await currentIdentity(page);
  const authority = await seedAnonymousAuthority(page, original.pubkey, "rotation-retry-room");
  const dialog = await openRotationDialog(page);

  await dialog.getByRole("button", { name: "Rotate identity" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(
    "Unable to rotate your identity. Your current identity and local room access are unchanged. Try again.",
  );
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Rotate identity" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Keep current identity" })).toBeEnabled();

  const afterFailure = await currentIdentity(page);
  expect(afterFailure).toEqual(original);
  expect(await page.evaluate((key) => localStorage.getItem(key), authority.key)).toBe(authority.raw);
  expect(await page.evaluate((key) => localStorage.getItem(key), recoveryBoundaryKey)).toBeNull();
  const failureSnapshots = await boundarySnapshots(page);
  expect(failureSnapshots).toHaveLength(1);
  expect(failureSnapshots[0]?.identityRaw).toBe(original.raw);
  expect(failureSnapshots[0]?.avatar).toBe(original.avatar);
  expect(failureSnapshots[0]?.authorityRaw).toBe(authority.raw);

  await dialog.getByRole("button", { name: "Rotate identity" }).click();
  await expect(dialog).toBeHidden();
  const replacement = await currentIdentity(page);
  expect(replacement.pubkey).not.toBe(original.pubkey);
  await expect(storedAuthority(page, authority.key)).resolves.toMatchObject({
    membershipStatus: "retired",
    stateBase64: "",
    keyPackage: { reference: "", publicBase64: "", privateBase64: "" },
  });
  await expect.poll(async () => (await boundarySnapshots(page)).length).toBe(2);
});
