import { describe, expect, test } from "vitest";
import { createInviteUrl } from "../../src/chat/invite";
import { groupMessageStreaks, nextRelativeMessageTimeDelay, projectMessageStreaks, relativeMessageTime } from "../../src/chat/message-presentation";
import type { StoredMessage } from "../../src/chat/room-store";

function message(id: string, sender: string, createdAt = 0): StoredMessage {
  return { type: "message", id, sender, name: sender, content: id, createdAt };
}

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const carol = "c".repeat(64);
const inviteContent = createInviteUrl("https://chat.example", {
  groupId: "projection-room",
  coordinatorPubkey: alice,
  relayUrls: ["wss://relay.example"],
  title: "Projection room",
});

function inviteMessage(id: string, sender: string, recipientPubkeys?: string[]): StoredMessage {
  return {
    ...message(id, sender),
    content: inviteContent,
    ...(recipientPubkeys ? { recipientPubkeys } : {}),
  };
}

describe("message presentation", () => {
  test("groups only consecutive messages from the same sender", () => {
    const groups = groupMessageStreaks([
      message("a1", "alice"), message("a2", "alice"), message("b1", "bob"), message("a3", "alice"),
    ]);
    expect(groups.map((group) => [group.sender, group.messages.map(({ id }) => id)])).toEqual([
      ["alice", ["a1", "a2"]], ["bob", ["b1"]], ["alice", ["a3"]],
    ]);
  });

  test("repairs non-adjacent duplicate ids before keyed chat rendering", () => {
    const pending = { ...message("same", "alice"), pending: true };
    const confirmed = { ...message("same", "alice"), cursor: 12, pending: false, content: "confirmed" };
    const groups = groupMessageStreaks([pending, message("b1", "bob"), confirmed]);

    expect(groups.flatMap((group) => group.messages)).toEqual([
      expect.objectContaining({ id: "same", cursor: 12, pending: false, content: "confirmed" }),
      expect.objectContaining({ id: "b1" }),
    ]);
    expect(new Set(groups.flatMap((group) => group.messages.map(({ id }) => id))).size).toBe(2);
  });

  test("keeps public invites and ordinary tagged messages visible to every viewer", () => {
    const ordinaryTagged = { ...message("ordinary", alice), recipientPubkeys: [bob] };
    const visible = projectMessageStreaks([inviteMessage("public", alice), ordinaryTagged], carol);

    expect(visible.flatMap((group) => group.messages.map(({ id }) => id))).toEqual(["public", "ordinary"]);
  });

  test("removes only valid targeted invites before grouping and preserves adjacency", () => {
    const messages = [
      message("before", alice),
      inviteMessage("hidden", alice, [bob]),
      message("after", alice),
    ];

    expect(projectMessageStreaks(messages, carol)).toEqual([{
      sender: alice,
      messages: [messages[0], messages[2]],
    }]);
    expect(projectMessageStreaks(messages, bob)[0]?.messages.map(({ id }) => id)).toEqual(["before", "hidden", "after"]);
  });

  test("treats malformed invite text and malformed recipients as ordinary legacy content", () => {
    const malformedInvite = { ...message("malformed-invite", alice), content: `${inviteContent} trailing`, recipientPubkeys: [bob] };
    const malformedRecipient = inviteMessage("malformed-recipient", alice, ["not-a-pubkey"]);

    expect(projectMessageStreaks([malformedInvite, malformedRecipient], carol)
      .flatMap((group) => group.messages.map(({ id }) => id))).toEqual(["malformed-invite", "malformed-recipient"]);
    expect(projectMessageStreaks([], carol)).toEqual([]);
  });

  test("deduplicates before filtering while retaining chronological winner order", () => {
    const pending = { ...inviteMessage("duplicate", alice, [bob]), pending: true };
    const confirmed = { ...inviteMessage("duplicate", alice, [bob]), cursor: 5, pending: false };
    const groups = projectMessageStreaks([pending, message("public", carol), confirmed], carol);

    expect(groups.flatMap((group) => group.messages.map(({ id }) => id))).toEqual(["public"]);
  });

  test.each([
    [0, "now", 1_000],
    [9_000, "9s ago", 1_000],
    [10_000, "10s ago", 5_000],
    [29_000, "29s ago", 1_000],
    [30_000, "30s ago", 10_000],
    [59_000, "59s ago", 1_000],
    [60_000, "1m ago", 60_000],
    [3_600_000, "1h ago", 3_600_000],
    [86_400_000, "1d ago", 86_400_000],
    [6 * 86_400_000, "6d ago", 86_400_000],
  ])("formats and schedules age %i", (age, label, delay) => {
    const now = Date.UTC(2026, 7, 5, 12);
    expect(relativeMessageTime(now - age, now)).toBe(label);
    expect(nextRelativeMessageTimeDelay(now - age, now)).toBe(delay);
  });

  test("switches to a static locale date and time at seven days", () => {
    const now = Date.UTC(2026, 7, 5, 12);
    const createdAt = now - (7 * 86_400_000);
    expect(relativeMessageTime(createdAt, now)).toBe(new Date(createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
    expect(nextRelativeMessageTimeDelay(createdAt, now)).toBeNull();
  });
});
