import { expect, installEstablishedInstallation, test, type Page } from "./established-installation-fixture";
import { getEventHash } from "nostr-tools";
import { createInviteUrl } from "../../src/chat/invite";
import { emitSocialContactEvent, installControllableNip07, installMockPublicRelayRoute, installSocialRelayControl, roomIdentity, socialRelaySubscriptions, waitForStoredMessage } from "./chat-user-interactions-fixture";
import { startMockRelay } from "./mock-relay";

interface SeedMessage {
  id: string;
  sender: string;
  name: string;
  content: string;
  createdAt: number;
  recipientPubkeys?: string[];
  auth?: { id: string; sig: string };
}

interface FixtureInteraction {
  pane: "host" | "guest";
  operation: "invite" | "follow";
  recipientPubkeys?: string[];
  participant?: string;
  roomId?: string;
}

async function openMessageGroupFixture(page: Page, pane: "host" | "guest"): Promise<void> {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { __messageGroupFixtureEvents?: FixtureInteraction[] };
    testWindow.__messageGroupFixtureEvents = [];
    window.addEventListener("cahmls-test-interaction-started", (event) => {
      testWindow.__messageGroupFixtureEvents?.push((event as CustomEvent<FixtureInteraction>).detail);
    });
  });
  await page.goto(`/?__message-group-test-harness=1&pane=${pane}`);
  await expect(page.getByTestId("message-group-test-harness")).toBeVisible();
}

async function latestFixtureInteraction(page: Page): Promise<FixtureInteraction | undefined> {
  return page.evaluate(() => {
    const testWindow = window as typeof window & { __messageGroupFixtureEvents?: FixtureInteraction[] };
    return testWindow.__messageGroupFixtureEvents?.at(-1);
  });
}

async function settleFixtureInteraction(page: Page, operation: "invite" | "follow", outcome: "resolve" | "reject"): Promise<void> {
  await page.evaluate(({ operation, outcome }) => {
    window.dispatchEvent(new CustomEvent("cahmls-test-interaction-settle", { detail: { operation, outcome } }));
  }, { operation, outcome });
}

async function seedGuestMessages(page: Page, recipientPubkey: string, messages: SeedMessage[]): Promise<void> {
  await page.evaluate(({ recipient, seededMessages }) => {
    const coordinatorPubkey = "c".repeat(64);
    const roomId = "recipient-tracer-guest";
    const room = {
      version: 1,
      id: roomId,
      title: "Recipient tracer guest",
      coordinatorPubkey,
      coordinatorOrigin: window.location.origin,
      relayUrls: ["ws://127.0.0.1:1"],
      name: "Guest",
      stablePubkey: recipient,
      host: { name: "Host", pubkey: "d".repeat(64) },
      isHost: false,
      stateBase64: "",
      keyPackage: { reference: "recipient-tracer", publicBase64: "public", privateBase64: "private" },
      lastCursor: 0,
      messages: seededMessages.map((message) => ({ type: "message", ...message })),
      pending: [],
      coordinatorKeyMode: "ephemeral",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    localStorage.setItem(
      `cordn-adhoc-chat-room:v2:${encodeURIComponent(coordinatorPubkey)}:${encodeURIComponent(roomId)}`,
      JSON.stringify(room),
    );
  }, { recipient: recipientPubkey, seededMessages: messages });
}

async function openSeededGuestRoom(page: Page): Promise<void> {
  const room = page.getByRole("button", { name: /^Open room Recipient tracer guest/ });
  if (!(await room.isVisible())) {
    const roomBrowser = page.getByRole("button", { name: "Open room browser" });
    if (await roomBrowser.isVisible()) await roomBrowser.click();
  }
  const card = page.getByTestId("invite-panel").locator(
    `[data-testid="coordinator-card"][data-coordinator-pubkey="${"c".repeat(64)}"]`,
  );
  await expect(card).toHaveAttribute("tabindex", "0", { timeout: 10_000 });
  await card.focus();
  await room.click();
}

async function authenticateNip07(page: Page): Promise<void> {
  const profile = page.getByTestId("user-profile");
  const menu = page.getByRole("dialog", { name: "User profile" });
  if (!(await menu.isVisible())) {
    await profile.getByRole("button", { name: /^(Open|Close) profile for / }).click();
  }
  await menu.getByRole("button", { name: /NIP-07 browser signer/ }).evaluate((button) => (button as HTMLElement).click());
  await expect(menu).toBeHidden();
  await expect(profile).toContainText("NIP-07");
}

async function expectNoMessageSubtree(
  page: Page,
  logTestId: "host-message-list" | "guest-message-list",
  messageId: string,
): Promise<void> {
  const log = page.getByTestId(logTestId);
  const row = log.locator(`[data-message-id="${messageId}"]`);
  const streak = log.getByTestId("message-streak").filter({ has: row });
  await expect(row).toHaveCount(0);
  await expect(streak).toHaveCount(0);
  await expect(streak.getByTestId("message-author")).toHaveCount(0);
  await expect(row.locator("time")).toHaveCount(0);
  await expect(row.getByRole("group", { name: /Reactions for message from / })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Add reaction" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /Join / })).toHaveCount(0);
}

test("signed recipient tracer renders Mentioned you in the shared invitee presentation", async ({ page }) => {
  await page.goto("/");
  const guestPubkey = "b".repeat(64);
  const createdAt = Date.now();
  const eventId = getEventHash({
    kind: 9,
    pubkey: "d".repeat(64),
    created_at: Math.floor(createdAt / 1_000),
    tags: [["name", "Host"], ["p", guestPubkey]],
    content: "A signed recipient tracer message",
  });
  await seedGuestMessages(page, guestPubkey, [{
    id: "recipient-tracer-message",
    sender: "d".repeat(64),
    name: "Host",
    content: "A signed recipient tracer message",
    createdAt,
    recipientPubkeys: [guestPubkey],
    auth: { id: eventId, sig: "cordn" },
  }]);
  await page.reload();
  await openSeededGuestRoom(page);
  await expect(page.getByTestId("guest-message-list").getByText("A signed recipient tracer message")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => {
    const raw = Object.entries(localStorage).find(([key]) => key.startsWith("cordn-adhoc-chat-room:v2:"))?.[1];
    const room = raw ? JSON.parse(raw) as { stablePubkey: string; messages: Array<{ recipientPubkeys?: string[]; auth?: unknown }> } : null;
    return room ? { stablePubkey: room.stablePubkey, recipientPubkeys: room.messages[0]?.recipientPubkeys, authenticated: Boolean(room.messages[0]?.auth) } : null;
  })).toEqual({ stablePubkey: guestPubkey, recipientPubkeys: [guestPubkey], authenticated: true });
  await expect(page.getByTestId("guest-message-list").getByTestId("mentioned-you")).toHaveText("Mentioned you");
});

test("targeted invite projection removes non-target layout artifacts before grouping", async ({ page }) => {
  const viewer = "e".repeat(64);
  const target = "b".repeat(64);
  const invite = createInviteUrl("https://chat.example", {
    groupId: "targeted-invite-projection",
    coordinatorPubkey: "a".repeat(64),
    relayUrls: ["wss://relay.example"],
    title: "Projection room",
  });

  await page.goto("/");
  await seedGuestMessages(page, viewer, [
    { id: "before", sender: "d".repeat(64), name: "Host", content: "Before targeted invite", createdAt: 1 },
    { id: "hidden-targeted-invite", sender: "d".repeat(64), name: "Host", content: invite, createdAt: 2, recipientPubkeys: [target] },
    { id: "after", sender: "d".repeat(64), name: "Host", content: "After targeted invite", createdAt: 3 },
    { id: "public-invite", sender: "f".repeat(64), name: "Public host", content: invite, createdAt: 4 },
  ]);
  await page.reload();
  await openSeededGuestRoom(page);

  const log = page.getByTestId("guest-message-list");
  await expect(log.getByText("After targeted invite")).toBeVisible({ timeout: 20_000 });
  await expect(log.getByTestId("message-bubble").filter({ has: page.locator('[data-message-id="hidden-targeted-invite"]') })).toHaveCount(0);
  await expect(log.locator('[data-message-id="hidden-targeted-invite"]')).toHaveCount(0);
  await expect(log.getByRole("button", { name: /Join Projection room/ })).toHaveCount(1);
  await expect(log.getByTestId("message-streak").filter({ hasText: "Before targeted invite" })).toHaveAttribute("data-message-count", "2");
});

test("host and guest participant fixtures deterministically cover targeted invite and authenticated follow UI", async ({ page }) => {
  const participant = "d".repeat(64);
  for (const pane of ["guest", "host"] as const) {
    await openMessageGroupFixture(page, pane);
    const trigger = page.getByRole("button", { name: "Actions for Participant" });
    await trigger.click();
    const menu = page.getByRole("dialog", { name: "Actions for Participant" });
    await menu.getByRole("button", { name: "Invite to room" }).click();
    const chooser = page.getByRole("dialog", { name: "Invite Participant to a room" });
    const room = chooser.getByRole("button", { name: /Fixture room/ });
    await room.click();
    await expect(chooser.getByRole("button", { name: "Sending invite…" })).toBeVisible();
    await expect.poll(() => latestFixtureInteraction(page)).toEqual({
      pane,
      operation: "invite",
      recipientPubkeys: [participant],
      roomId: "fixture-room",
    });
    await settleFixtureInteraction(page, "invite", "resolve");
    await expect(chooser).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByText("Invite sent to Participant.")).toBeAttached();

    await trigger.click();
    await menu.getByRole("button", { name: "Invite to room" }).click();
    await chooser.getByRole("button", { name: /Fixture room/ }).click();
    await settleFixtureInteraction(page, "invite", "reject");
    await expect(chooser.getByRole("status")).toContainText("Couldn’t send the invite");

    await page.keyboard.press("Escape");
    await trigger.click();
    const follow = menu.getByRole("button", { name: "Follow on Nostr" });
    await follow.click();
    await expect(menu.getByRole("button", { name: "Following Participant…" })).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => latestFixtureInteraction(page)).toEqual({ pane, operation: "follow", participant });
    await settleFixtureInteraction(page, "follow", "resolve");
    await expect(page.getByText("Now following Participant.")).toBeAttached();

    await follow.click();
    await expect(menu.getByRole("button", { name: "Following Participant…" })).toHaveAttribute("aria-busy", "true");
    await settleFixtureInteraction(page, "follow", "reject");
    await expect(menu.getByRole("status")).toContainText("Couldn’t complete that action. Check your connection and try again.");
  }
});

test("participant menu opens from a non-self author, mentions through the composer, and offers only other active rooms", async ({ page }) => {
  const viewer = "e".repeat(64);
  const participant = "d".repeat(64);
  await page.goto("/");
  await seedGuestMessages(page, viewer, [{
    id: "participant-menu-message",
    sender: participant,
    name: "Participant",
    content: "Open my actions",
    createdAt: Date.now(),
  }, {
    id: "second-participant-menu-message",
    sender: "f".repeat(64),
    name: "Second participant",
    content: "Open my other actions",
    createdAt: Date.now() + 1,
  }, {
    id: "self-message",
    sender: viewer,
    name: "Guest",
    content: "Do not offer self actions",
    createdAt: Date.now() + 2,
  }]);
  await page.evaluate(() => {
    const activeRoom = {
      version: 1,
      id: "other-active-room",
      title: "Other active room",
      coordinatorPubkey: "a".repeat(64),
      coordinatorOrigin: window.location.origin,
      coordinatorName: "Other coordinator",
      relayUrls: ["ws://127.0.0.1:1"],
      name: "Guest",
      stablePubkey: "e".repeat(64),
      isHost: false,
      stateBase64: "",
      keyPackage: { reference: "other-room", publicBase64: "public", privateBase64: "private" },
      lastCursor: 0,
      messages: [],
      pending: [],
      membershipStatus: "active",
      createdAt: Date.now(),
    };
    const retiredRoom = { ...activeRoom, id: "retired-room", title: "History room", membershipStatus: "retired" };
    localStorage.setItem(`cordn-adhoc-chat-room:v2:${encodeURIComponent(activeRoom.coordinatorPubkey)}:${encodeURIComponent(activeRoom.id)}`, JSON.stringify(activeRoom));
    localStorage.setItem(`cordn-adhoc-chat-room:v2:${encodeURIComponent(retiredRoom.coordinatorPubkey)}:${encodeURIComponent(retiredRoom.id)}`, JSON.stringify(retiredRoom));
  });
  await page.reload();
  await openSeededGuestRoom(page);

  const trigger = page.getByRole("button", { name: "Actions for Participant" });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Actions for Guest" })).toHaveCount(0);
  await trigger.press("Enter");
  const menu = page.getByRole("dialog", { name: "Actions for Participant" });
  await expect(menu.getByRole("button", { name: "Mention" })).toBeFocused();
  await expect(menu.getByRole("button").allTextContents()).resolves.toEqual(["Mention", "Invite to room", "Follow on Nostr", "Highlight: Default", "Ignore"]);
  await expect(menu.getByRole("button", { name: "Follow on Nostr" })).toBeDisabled();
  await expect(menu).toContainText("Sign in to follow people on Nostr.");
  await page.getByTestId("chat-composer").locator("input").evaluate((input) => input.removeAttribute("disabled"));
  await menu.getByRole("button", { name: "Mention" }).click();
  await expect(page.getByTestId("chat-composer").locator("input")).toBeFocused();
  await expect(page.getByTestId("chat-composer").locator("input")).toHaveValue("@Participant");

  const secondTrigger = page.getByRole("button", { name: "Actions for Second participant" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Actions for Participant" })).toBeVisible();
  await secondTrigger.focus();
  await expect(page.getByRole("dialog", { name: "Actions for Participant" })).toHaveCount(0);
  await secondTrigger.press("Enter");
  await expect(page.getByRole("dialog", { name: "Actions for Participant" })).toHaveCount(0);
  const secondMenu = page.getByRole("dialog", { name: "Actions for Second participant" });
  await expect(secondMenu).toHaveCount(1);
  await expect(secondMenu).toBeVisible();
  await page.getByTestId("chat-composer").locator("input").focus();
  await expect(secondMenu).toHaveCount(0);

  await secondTrigger.click();
  await expect(secondMenu).toBeVisible();
  await page.getByTestId("chat-composer").locator("input").click();
  await expect(secondMenu).toHaveCount(0);

  await trigger.click();
  await menu.getByRole("button", { name: "Invite to room" }).click();
  const chooser = page.getByRole("dialog", { name: "Invite Participant to a room" });
  await expect(chooser.getByRole("button", { name: /Other active room/ })).toBeVisible();
  await expect(chooser).not.toContainText("Recipient tracer guest");
  await expect(chooser).not.toContainText("History room");
  await chooser.getByRole("button", { name: /Other active room/ }).click();
  await expect(chooser.getByRole("status")).toContainText("Couldn’t send the invite");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("participant surfaces keep invite controls contained at 320px and disable invite motion", async ({ page }) => {
  const viewer = "e".repeat(64);
  const participant = "d".repeat(64);
  const invite = createInviteUrl("https://chat.example", {
    groupId: "motion-safe-invite",
    coordinatorPubkey: "a".repeat(64),
    relayUrls: ["wss://relay.example"],
    title: "Motion safe room",
  });
  await page.setViewportSize({ width: 320, height: 360 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await seedGuestMessages(page, viewer, [
    { id: "compact-participant", sender: participant, name: "Participant", content: "Compact menu", createdAt: 1 },
    { id: "motion-safe-invite", sender: "f".repeat(64), name: "Host", content: invite, createdAt: 2 },
  ]);
  await page.reload();
  await openSeededGuestRoom(page);

  const trigger = page.getByRole("button", { name: "Actions for Participant" });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  const menu = page.getByRole("dialog", { name: "Actions for Participant" });
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);
  await menu.getByRole("button", { name: "Invite to room" }).click();
  const chooser = page.getByRole("dialog", { name: "Invite Participant to a room" });
  await expect(chooser).toBeVisible();
  await expect.poll(() => chooser.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);
  await expect(page.getByRole("button", { name: /Join Motion safe room/ })).toHaveCSS("transition-duration", "0s");
});

test("participant visual contract preserves token roles and compact gutters", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });

  for (const pane of ["host", "guest"] as const) {
    await openMessageGroupFixture(page, pane);
    const trigger = page.getByRole("button", { name: "Actions for Participant" });
    await expect(trigger).toHaveCSS("min-height", "44px");
    await expect(trigger).toHaveCSS("min-width", "44px");
    await trigger.click();

    const menu = page.getByRole("dialog", { name: "Actions for Participant" });
    const mention = menu.getByRole("button", { name: "Mention" });
    const highlightAction = menu.locator(`#${pane}-participant-highlight`);
    const defaultHighlight = menu.getByTestId("participant-highlight-default");
    await expect(menu).toHaveCSS("background-color", "rgb(16, 22, 20)");
    await expect(mention).toHaveCSS("font-size", "14px");
    await highlightAction.click();
    await expect(defaultHighlight).toHaveAttribute("aria-pressed", "true");
    await expect(defaultHighlight).toHaveClass(/highlight-selected/);
    await expect(defaultHighlight).toHaveCSS("border-left-color", "rgb(124, 245, 157)");
    await expect.poll(() => menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: window.innerWidth - rect.right, width: rect.width };
    })).toEqual({ left: 16, right: 16, width: 288 });

    await menu.getByRole("button", { name: "Invite to room" }).click();
    const chooser = page.getByRole("dialog", { name: "Invite Participant to a room" });
    await expect(chooser.getByRole("heading")).toHaveCSS("font-size", "20px");
    await expect(chooser.getByRole("heading")).toHaveCSS("font-weight", "600");
    await expect(chooser.getByRole("button", { name: /Fixture room/ })).toHaveCSS("font-size", "14px");
    await expect.poll(() => chooser.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: window.innerWidth - rect.right, width: rect.width };
    })).toEqual({ left: 16, right: 16, width: 288 });
  }
});

test("host renders the shared participant menu and mention flow for an admitted guest", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create room", exact: true })).toBeVisible({ timeout: 35_000 });
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const createRoom = page.getByTestId("create-room-dialog");
  await createRoom.getByPlaceholder("Friday plans").fill("Participant host parity");
  await createRoom.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(createRoom).toBeHidden();
  const inviteUrl = await page.getByTestId("invite-link").textContent();
  expect(inviteUrl).toBeTruthy();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    await installEstablishedInstallation(guest);
    await guest.goto(inviteUrl!);
    await expect(guest.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });
    await guest.getByPlaceholder("Message").fill("A host-visible participant message");
    await guest.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("host-message-list").getByText("A host-visible participant message")).toBeVisible({ timeout: 20_000 });

    const hostTrigger = page.getByTestId("host-message-list").getByRole("button", { name: /^Actions for / });
    await expect(hostTrigger).toBeVisible();
    await hostTrigger.click();
    const menu = page.getByRole("dialog", { name: /^Actions for / });
    await expect(menu.getByRole("button").allTextContents()).resolves.toEqual(["Mention", "Invite to room", "Follow on Nostr", "Highlight: Default", "Ignore"]);
    await menu.getByRole("button", { name: "Mention" }).click();
    await expect(page.getByPlaceholder("Message as host")).toBeFocused();
    await expect(page.getByPlaceholder("Message as host")).toHaveValue(/^@/);
  } finally {
    await guestContext.close();
  }
});

test("real targeted message and room invite cross production transport", async ({ page: host, browser }) => {
  test.setTimeout(150_000);
  const sourceTitle = "Production transport source";
  const targetRoomTitle = "Production transport target";
  const publicRelay = await startMockRelay(8896);
  await installMockPublicRelayRoute(host, publicRelay.url);
  await host.goto("/");
  await host.getByRole("button", { name: "Start", exact: true }).click();
  await expect(host.getByRole("button", { name: "Create room", exact: true })).toBeVisible({ timeout: 35_000 });
  await host.getByRole("button", { name: "Create room", exact: true }).click();
  const createSource = host.getByTestId("create-room-dialog");
  await createSource.getByPlaceholder("Friday plans").fill(sourceTitle);
  await createSource.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(createSource).toBeHidden();
  const sourceInvite = await host.getByTestId("invite-link").textContent();
  expect(sourceInvite).toBeTruthy();

  const targetContext = await browser.newContext();
  const nonTargetContext = await browser.newContext();
  const target = await targetContext.newPage();
  const nonTarget = await nonTargetContext.newPage();
  try {
    await Promise.all([
      installEstablishedInstallation(target),
      installEstablishedInstallation(nonTarget),
      installMockPublicRelayRoute(target, publicRelay.url),
      installMockPublicRelayRoute(nonTarget, publicRelay.url),
    ]);
    // Admit sequentially: the coordinator's real join/admission queue is part
    // of the behavior under test and concurrent initial joins are needlessly
    // timing-sensitive in a one-worker browser trace.
    await target.goto(sourceInvite!);
    await expect(target.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });
    await nonTarget.goto(sourceInvite!);
    await expect(nonTarget.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });

    await host.getByPlaceholder("Message as host").fill("Host author for a structured mention");
    await host.getByRole("button", { name: "Send" }).click();
    await expect(target.getByTestId("guest-message-list").getByText("Host author for a structured mention")).toBeVisible({ timeout: 20_000 });
    await expect(nonTarget.getByTestId("guest-message-list").getByText("Host author for a structured mention")).toBeVisible({ timeout: 20_000 });

    const hostAuthorActions = target.getByTestId("guest-message-list").getByRole("button", { name: /^Actions for / }).first();
    await hostAuthorActions.click();
    await target.getByRole("dialog", { name: /^Actions for / }).getByRole("button", { name: "Mention" }).click();
    const targetComposer = target.getByTestId("chat-composer").locator("input");
    await targetComposer.fill("Visible text deliberately differs from the selected name");
    await target.getByRole("button", { name: "Send" }).click();

    const hostLog = host.getByTestId("host-message-list");
    await expect(hostLog.getByText("Visible text deliberately differs from the selected name")).toBeVisible({ timeout: 20_000 });
    await expect(hostLog.getByTestId("mentioned-you")).toHaveCount(1);
    await expect(target.getByTestId("guest-message-list").getByTestId("mentioned-you")).toHaveCount(0);
    await expect(nonTarget.getByTestId("guest-message-list").getByTestId("mentioned-you")).toHaveCount(0);

    const hostIdentity = await roomIdentity(host, sourceTitle);
    const mention = await waitForStoredMessage(host, sourceTitle, (message) => message.content === "Visible text deliberately differs from the selected name");
    expect(mention.recipientPubkeys).toEqual([hostIdentity.stablePubkey]);
    expect(mention.auth).toBeTruthy();

    // An active channel exposes the new-room flow through the live sidebar
    // control (the visible label is "Create group" in the compact rail).
    await host.getByRole("button", { name: "Create group", exact: true }).click();
    const createTarget = host.getByTestId("create-room-dialog");
    await createTarget.getByPlaceholder("Friday plans").fill(targetRoomTitle);
    await createTarget.getByRole("button", { name: "Create room", exact: true }).click();
    await expect(createTarget).toBeHidden();
    const targetIdentity = await roomIdentity(host, targetRoomTitle);
    await host.getByRole("button", { name: new RegExp(`^Open room ${sourceTitle}, hosted by`) }).click();
    await expect(hostLog.getByText("Visible text deliberately differs from the selected name")).toBeVisible({ timeout: 20_000 });

    const targetMessageActions = hostLog.locator("[data-testid=message-streak]")
      .filter({ hasText: "Visible text deliberately differs from the selected name" })
      .getByRole("button", { name: /^Actions for / });
    await targetMessageActions.click();
    await host.getByRole("dialog", { name: /^Actions for / }).getByRole("button", { name: "Invite to room" }).click();
    const chooser = host.getByRole("dialog", { name: /^Invite .+ to a room$/ });
    const publicEventsBeforeInvite = publicRelay.events().length;
    await chooser.getByRole("button", { name: new RegExp(targetRoomTitle) }).click();
    await expect(chooser).toBeHidden({ timeout: 20_000 });

    const targetSourceIdentity = await roomIdentity(target, sourceTitle);
    const appOrigin = new URL(host.url()).origin;
    const deliveredInvite = await waitForStoredMessage(
      target,
      sourceTitle,
      (message) => message.recipientPubkeys?.length === 1
        && message.recipientPubkeys[0] === targetSourceIdentity.stablePubkey
        && message.content?.startsWith(appOrigin) === true,
    );
    expect(deliveredInvite.recipientPubkeys).toEqual([targetSourceIdentity.stablePubkey]);
    expect(deliveredInvite.auth).toBeTruthy();
    const deliveredUrl = new URL(deliveredInvite.content ?? "", host.url());
    expect(deliveredUrl.pathname).toContain(targetIdentity.id);
    await expect(target.getByRole("button", { name: new RegExp(`Join ${targetRoomTitle}`) })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => publicRelay.events().length).toBeGreaterThan(publicEventsBeforeInvite);
    const publicEventsAfterInvite = publicRelay.events().slice(publicEventsBeforeInvite);
    expect(publicEventsAfterInvite.some((event) => event.content?.includes(deliveredInvite.content ?? "") === true)).toBe(false);
    await expectNoMessageSubtree(host, "host-message-list", deliveredInvite.id);
    await expectNoMessageSubtree(nonTarget, "guest-message-list", deliveredInvite.id);
  } finally {
    await Promise.all([targetContext.close(), nonTargetContext.close()]);
    await publicRelay.close();
  }
});

test("both composers restore edited mentions after signer failure", async ({ page: host, browser }) => {
  test.setTimeout(150_000);
  const roomTitle = "Signer rollback transport";
  const hostSigner = await installControllableNip07(host);
  await host.goto("/");
  await authenticateNip07(host);
  await host.getByRole("button", { name: "Start", exact: true }).click();
  await expect(host.getByRole("button", { name: "Create room", exact: true })).toBeVisible({ timeout: 35_000 });
  await host.getByRole("button", { name: "Create room", exact: true }).click();
  const dialog = host.getByTestId("create-room-dialog");
  await dialog.getByPlaceholder("Friday plans").fill(roomTitle);
  await dialog.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(dialog).toBeHidden();
  const invite = await host.getByTestId("invite-link").textContent();
  expect(invite).toBeTruthy();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    const guestSigner = await installControllableNip07(guest);
    await installEstablishedInstallation(guest);
    await guest.goto("/");
    await authenticateNip07(guest);
    await guest.goto(invite!);
    await expect(guest.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 });

    await guest.getByPlaceholder("Message").fill("Guest author available for host mention");
    await guest.getByRole("button", { name: "Send" }).click();
    await expect(host.getByTestId("host-message-list").getByText("Guest author available for host mention")).toBeVisible({ timeout: 20_000 });
    await host.getByPlaceholder("Message as host").fill("Host author available for guest mention");
    await host.getByRole("button", { name: "Send" }).click();
    await expect(guest.getByTestId("guest-message-list").getByText("Host author available for guest mention")).toBeVisible({ timeout: 20_000 });

    const hostGuestActions = host.getByTestId("host-message-list").locator("[data-testid=message-streak]")
      .filter({ hasText: "Guest author available for host mention" }).getByRole("button", { name: /^Actions for / });
    await hostGuestActions.click();
    await host.getByRole("dialog", { name: /^Actions for / }).getByRole("button", { name: "Mention" }).click();
    const hostComposer = host.getByPlaceholder("Message as host");
    await hostComposer.fill("host keeps this exact edited text");
    hostSigner.rejectNextSignature();
    await host.getByRole("button", { name: "Send" }).click();
    await expect(hostComposer).toHaveValue("host keeps this exact edited text");
    await host.getByRole("button", { name: "Send" }).click();
    const hostRetry = await waitForStoredMessage(guest, roomTitle, (message) => message.content === "host keeps this exact edited text");
    expect(hostRetry.recipientPubkeys).toEqual([guestSigner.pubkey]);

    const guestHostActions = guest.getByTestId("guest-message-list").locator("[data-testid=message-streak]")
      .filter({ hasText: "Host author available for guest mention" }).getByRole("button", { name: /^Actions for / });
    await guestHostActions.click();
    await guest.getByRole("dialog", { name: /^Actions for / }).getByRole("button", { name: "Mention" }).click();
    const guestComposer = guest.getByPlaceholder("Message");
    await guestComposer.fill("guest keeps this exact edited text");
    guestSigner.rejectNextSignature();
    await guest.getByRole("button", { name: "Send" }).click();
    await expect(guestComposer).toHaveValue("guest keeps this exact edited text");
    await guest.getByRole("button", { name: "Send" }).click();
    const guestRetry = await waitForStoredMessage(host, roomTitle, (message) => message.content === "guest keeps this exact edited text");
    expect(guestRetry.recipientPubkeys).toEqual([hostSigner.pubkey]);
  } finally {
    await guestContext.close();
  }
});

test("authenticated host expands filtered ignored streaks", async ({ page: host, browser }) => {
  test.setTimeout(150_000);
  const roomTitle = "Host ignore projection";
  await installControllableNip07(host);
  await host.goto("/");
  await authenticateNip07(host);
  await host.getByRole("button", { name: "Start", exact: true }).click();
  await expect(host.getByRole("button", { name: "Create room", exact: true })).toBeVisible({ timeout: 35_000 });
  await host.getByRole("button", { name: "Create room", exact: true }).click();
  const dialog = host.getByTestId("create-room-dialog");
  await dialog.getByPlaceholder("Friday plans").fill(roomTitle);
  await dialog.getByRole("button", { name: "Create room", exact: true }).click();
  const invite = await host.getByTestId("invite-link").textContent();
  expect(invite).toBeTruthy();
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  try {
    await Promise.all([installEstablishedInstallation(a), installEstablishedInstallation(b)]);
    await Promise.all([a.goto(invite!), b.goto(invite!)]);
    await Promise.all([expect(a.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 }), expect(b.getByPlaceholder("Message")).toBeVisible({ timeout: 35_000 })]);
    await host.getByPlaceholder("Message as host").fill("Host author for ignore mention");
    await host.getByRole("button", { name: "Send" }).click();
    await expect(a.getByText("Host author for ignore mention")).toBeVisible({ timeout: 20_000 });
    await a.getByTestId("guest-message-list").getByRole("button", { name: /^Actions for / }).first().click();
    await a.getByRole("dialog", { name: /^Actions for / }).getByRole("button", { name: "Mention" }).click();
    await a.getByPlaceholder("Message").fill("A target host stays visible");
    await a.getByRole("button", { name: "Send" }).click();
    await expect(host.getByText("A target host stays visible")).toBeVisible({ timeout: 20_000 });
    await b.getByPlaceholder("Message").fill("B separates ignored streaks");
    await b.getByRole("button", { name: "Send" }).click();
    await expect(host.getByText("B separates ignored streaks")).toBeVisible({ timeout: 20_000 });
    await a.getByPlaceholder("Message").fill("A second visible message");
    await a.getByRole("button", { name: "Send" }).click();
    await expect(host.getByText("A second visible message")).toBeVisible({ timeout: 20_000 });

    const bIdentity = await roomIdentity(b, roomTitle);
    const filteredInvite = createInviteUrl(new URL(host.url()).origin, {
      groupId: "filtered-targeted-invite",
      coordinatorPubkey: "a".repeat(64),
      relayUrls: ["wss://relay.example"],
      title: "Filtered targeted invite",
    });
    // Target B through A's active session. This produces the same signed,
    // encrypted Cordn event the host session normally receives, rather than
    // fabricating local storage that a later session update can replace.
    const bActions = a.getByTestId("guest-message-list").locator("[data-testid=message-streak]")
      .filter({ hasText: "B separates ignored streaks" }).getByRole("button", { name: /^Actions for / });
    await expect(bActions).toBeVisible({ timeout: 20_000 });
    await bActions.click();
    await a.getByRole("dialog", { name: /^Actions for / }).getByRole("button", { name: "Mention" }).click();
    await a.getByPlaceholder("Message").fill(filteredInvite);
    await a.getByRole("button", { name: "Send" }).click();

    const deliveredFilteredInvite = await waitForStoredMessage(b, roomTitle, (message) => message.content === filteredInvite);
    expect(deliveredFilteredInvite.recipientPubkeys).toEqual([bIdentity.stablePubkey]);
    expect(deliveredFilteredInvite.auth).toBeTruthy();
    const filteredInviteId = deliveredFilteredInvite.id;
    const log = host.getByTestId("host-message-list");
    // The probe is populated directly from HostWorkspace's active
    // ChatRoomSession, before projectMessagePresentation filters the invite.
    await expect(host.getByTestId("host-session-message-probe")).toHaveAttribute(
      "data-session-message-ids",
      new RegExp(`(^|,)${filteredInviteId}(,|$)`),
      { timeout: 35_000 },
    );
    await expect(log.locator(`[data-message-id="${filteredInviteId}"]`)).toHaveCount(0);
    const firstActions = log.locator("[data-testid=message-streak]").filter({ hasText: "A target host stays visible" }).getByRole("button", { name: /^Actions for / });
    await firstActions.click();
    await host.getByRole("dialog", { name: /^Actions for / }).getByRole("button", { name: "Ignore" }).click();
    const disclosures = host.getByRole("button", { name: /anon posted 1 message/ });
    await expect(disclosures).toHaveCount(2);
    await disclosures.nth(0).click();
    await expect(disclosures.nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(disclosures.nth(1)).toHaveAttribute("aria-expanded", "false");
    await expect(log.getByText("A target host stays visible")).toBeVisible();
    await expect(log.getByText("A second visible message")).toHaveCount(0);
    await expect(log.getByTestId("mentioned-you")).toHaveCount(1);
    await disclosures.nth(1).click();
    await expect(disclosures.nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(disclosures.nth(1)).toHaveAttribute("aria-expanded", "true");
    await expect(log.getByText("A second visible message")).toBeVisible();
    await expect(log.locator(`[data-message-id="${filteredInviteId}"]`)).toHaveCount(0);
  } finally {
    await Promise.all([aContext.close(), bContext.close()]);
  }
});

test("App owns one current kind-3 lifecycle across logout and replacement", async ({ page }) => {
  const signer = await installControllableNip07(page);
  await installSocialRelayControl(page);
  const firstPubkey = signer.pubkey;
  const contactKindThreeSubscriptions = async () => (await socialRelaySubscriptions(page))
    .filter((subscription) => subscription.kinds.includes(3) && subscription.authors.length > 0);
  const contactRequestsFor = async (pubkey: string) => (await contactKindThreeSubscriptions())
    .filter((subscription) => subscription.authors.length === 1 && subscription.authors[0] === pubkey);
  const openContactRequestsFor = async (pubkey: string) => (await contactRequestsFor(pubkey))
    .filter((subscription) => subscription.state === "open");
  const expectOneLiveRequestPerRelay = async (pubkey: string) => {
    // SOCIAL_RELAYS has two configured relays. Each is a required physical
    // leg for the one logical owner, so two entries proves there is exactly
    // one live REQ per relay rather than a collapsed or duplicate lifecycle.
    await expect.poll(() => openContactRequestsFor(pubkey)).toEqual([
      { state: "open", kinds: [3], authors: [pubkey] },
      { state: "open", kinds: [3], authors: [pubkey] },
    ]);
  };
  await page.goto("/");
  const probe = page.getByTestId("contact-lifecycle-probe");
  await expect(probe).toHaveAttribute("data-owner-ready", "false");
  await expect.poll(contactKindThreeSubscriptions).toEqual([]);
  await authenticateNip07(page);
  await expect(probe).toHaveAttribute("data-contact-pubkey", firstPubkey, { timeout: 20_000 });
  await expect(probe).toHaveAttribute("data-owner-ready", "true");
  await expectOneLiveRequestPerRelay(firstPubkey);
  const staleAEvent = signer.signedContactList(["c".repeat(64)]);

  const profile = page.getByTestId("user-profile");
  await profile.getByRole("button", { name: /^Open profile for / }).click();
  const firstMenu = page.getByRole("dialog", { name: "User profile" });
  await firstMenu.getByRole("button", { name: "Disconnect" }).click();
  await expect(probe).toHaveAttribute("data-contact-pubkey", "");
  await expect(probe).toHaveAttribute("data-owner-ready", "false");
  await expect.poll(async () => await openContactRequestsFor(firstPubkey)).toEqual([]);
  await expect.poll(async () => {
    const requests = await contactRequestsFor(firstPubkey);
    return requests.length >= 2 && requests.every((request) => request.state === "closed");
  }).toBe(true);

  const secondPubkey = signer.replaceIdentity();
  await authenticateNip07(page);
  await expect(probe).toHaveAttribute("data-contact-pubkey", secondPubkey, { timeout: 20_000 });
  await expect(probe).toHaveAttribute("data-owner-ready", "true");
  await expectOneLiveRequestPerRelay(secondPubkey);
  await expect.poll(async () => await openContactRequestsFor(firstPubkey)).toEqual([]);
  await expect.poll(async () => {
    const requests = await contactRequestsFor(firstPubkey);
    return requests.length >= 2 && requests.every((request) => request.state === "closed");
  }).toBe(true);
  const followingB = "b".repeat(64);
  await emitSocialContactEvent(page, signer.signedContactList([followingB]));
  await expect(probe).toHaveAttribute("data-following", followingB);
  // This valid A event is delivered through the retained, already-closed A callback.
  // The mounted store must reject it because the current owner is B.
  await emitSocialContactEvent(page, staleAEvent);
  await expect(probe).toHaveAttribute("data-contact-pubkey", secondPubkey);
  await expect(probe).toHaveAttribute("data-following", followingB);
  await expect(probe).not.toHaveAttribute("data-contact-pubkey", firstPubkey);

  await profile.getByRole("button", { name: /^Open profile for / }).click();
  const secondMenu = page.getByRole("dialog", { name: "User profile" });
  await secondMenu.getByRole("button", { name: "Disconnect" }).click();
  await expect(probe).toHaveAttribute("data-contact-pubkey", "");
  await expect(probe).toHaveAttribute("data-owner-ready", "false");
  await expect.poll(async () => await openContactRequestsFor(secondPubkey)).toEqual([]);
  await expect.poll(async () => {
    const requests = await contactRequestsFor(secondPubkey);
    return requests.length >= 2 && requests.every((request) => request.state === "closed");
  }).toBe(true);
  await expect.poll(async () => (await contactKindThreeSubscriptions())
    .filter((subscription) => subscription.state === "open")).toEqual([]);
});

test("participant feedback remains visible and persistent in host and guest renderers", async ({ page }) => {
  const viewer = "e".repeat(64);
  const participant = "d".repeat(64);

  for (const pane of ["host", "guest"] as const) {
    await openMessageGroupFixture(page, pane);
    const fixtureTrigger = page.getByRole("button", { name: "Actions for Participant" });
    const fixtureStreak = page.getByTestId("message-streak");
    const fixtureBubble = page.getByTestId("message-bubble");
    const [streakBefore, bubbleBefore] = await Promise.all([
      fixtureStreak.boundingBox(),
      fixtureBubble.boundingBox(),
    ]);
    await fixtureTrigger.click();
    await expect.poll(() => fixtureTrigger.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44;
    })).toBe(true);
    await expect(Promise.all([fixtureStreak.boundingBox(), fixtureBubble.boundingBox()]))
      .resolves.toEqual([streakBefore, bubbleBefore]);
  }

  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("cordn:v1:chat-participant-preferences"));
  await seedGuestMessages(page, viewer, [{
    id: "highlight-before-ignore",
    sender: participant,
    name: "Participant",
    content: "First local preference message",
    createdAt: Date.now(),
  }, {
    id: "other-before-ignore",
    sender: "f".repeat(64),
    name: "Other participant",
    content: "Separating message",
    createdAt: Date.now() + 1,
  }, {
    id: "highlight-after-ignore",
    sender: participant,
    name: "Participant",
    content: "Second local preference message",
    createdAt: Date.now() + 2,
  }]);
  await page.reload();
  await openSeededGuestRoom(page);
  const firstParticipantStreak = page.getByTestId("message-streak").filter({
    has: page.locator('[data-message-id="highlight-before-ignore"]'),
  });
  const trigger = firstParticipantStreak.getByRole("button", { name: "Actions for Participant" });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  const menu = page.getByRole("dialog", { name: "Actions for Participant" });
  const highlightAction = menu.locator("#guest-participant-highlight");
  await expect(highlightAction).toHaveText("Highlight: Default");
  await highlightAction.click();
  const defaultHighlight = menu.getByTestId("participant-highlight-default");
  const goldHighlight = menu.getByTestId("participant-highlight-gold");
  await expect(defaultHighlight).toHaveAttribute("aria-pressed", "true");
  await expect(goldHighlight).toHaveAttribute("aria-pressed", "false");
  await goldHighlight.click();
  await expect(firstParticipantStreak).toHaveClass(/highlighted/);
  await expect(highlightAction).toHaveText("Highlight: Gold");
  await expect(highlightAction).toBeFocused();
  await highlightAction.click();
  await expect(goldHighlight).toHaveAttribute("aria-pressed", "true");
  await expect(goldHighlight).toContainText("Selected");
  await trigger.click();
  await menu.getByRole("button", { name: "Ignore" }).click();
  const disclosures = page.getByRole("button", { name: /Participant posted 1 message/ });
  await expect(disclosures).toHaveCount(2);
  await expect(disclosures.nth(0)).toHaveText(/Participant posted 1 message\s*Show messages/);
  await expect(disclosures.nth(1)).toHaveText(/Participant posted 1 message\s*Show messages/);
  await expect(disclosures.nth(0)).toHaveAttribute("aria-expanded", "false");
  await expect(disclosures.nth(1)).toHaveAttribute("aria-expanded", "false");
  await disclosures.nth(0).click();
  await expect(disclosures.nth(0)).toHaveText(/Participant posted 1 message\s*Hide messages/);
  await expect(disclosures.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(disclosures.nth(1)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("First local preference message")).toBeVisible();
  await page.reload();
  await openSeededGuestRoom(page);
  const restoredDisclosures = page.getByRole("button", { name: /Participant posted 1 message/ });
  await expect(restoredDisclosures).toHaveCount(2, { timeout: 20_000 });
  await restoredDisclosures.nth(0).click();
  const restoredTrigger = page.getByTestId("message-streak").filter({
    has: page.locator('[data-message-id="highlight-before-ignore"]'),
  }).getByRole("button", { name: "Actions for Participant" });
  await restoredTrigger.click();
  await expect(highlightAction).toHaveText("Highlight: Gold");
  await highlightAction.click();
  await expect(goldHighlight).toHaveAttribute("aria-pressed", "true");
  await defaultHighlight.click();
  await expect(highlightAction).toHaveText("Highlight: Default");
  await highlightAction.click();
  await expect(defaultHighlight).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).not.toContainText(participant);
});
