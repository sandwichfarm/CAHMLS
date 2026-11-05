import type { StoredMessage } from "./room-store";
import { parseInviteMessage } from "./invite";
import { normalizeRecipientPubkeys } from "./protocol";

export interface MessageStreak {
  sender: string;
  messages: StoredMessage[];
}

/** A stable, post-visibility streak projection suitable for private UI state. */
export interface MessagePresentationEntry extends MessageStreak {
  instanceKey: string;
  ignored: boolean;
}

export function groupMessageStreaks(messages: readonly StoredMessage[]): MessageStreak[] {
  return groupConsecutiveMessages(uniqueRenderableMessages(messages));
}

/**
 * Select a viewer's complete renderable message sequence before any layout is
 * formed. Targeting is a local invite UX rule: ordinary messages are always
 * visible, while valid tagged invites disappear for non-recipients.
 */
export function projectMessageStreaks(messages: readonly StoredMessage[], viewerPubkey: string): MessageStreak[] {
  const viewer = normalizeRecipientPubkeys([viewerPubkey])[0];
  const visible = uniqueRenderableMessages(messages).filter((message) => {
    if (!parseInviteMessage(message.content)) return true;
    const recipients = normalizeRecipientPubkeys(message.recipientPubkeys);
    return recipients.length === 0 || (viewer !== undefined && recipients.includes(viewer));
  });
  return groupConsecutiveMessages(visible);
}

/**
 * Apply private participant preferences only after target filtering has formed
 * the visible sequence. This keeps collapsed ignore disclosures from
 * resurrecting a non-target invite or joining independent visible streaks.
 */
export function projectMessagePresentation(
  messages: readonly StoredMessage[],
  viewerPubkey: string,
  isIgnored: (participantPubkey: string) => boolean,
): MessagePresentationEntry[] {
  return projectMessageStreaks(messages, viewerPubkey).map((streak) => ({
    ...streak,
    instanceKey: `${streak.sender}:${streak.messages[0]?.id ?? ""}`,
    ignored: isIgnored(streak.sender),
  }));
}

function groupConsecutiveMessages(messages: readonly StoredMessage[]): MessageStreak[] {
  const streaks: MessageStreak[] = [];
  for (const message of messages) {
    const current = streaks.at(-1);
    if (current?.sender === message.sender) current.messages.push(message);
    else streaks.push({ sender: message.sender, messages: [message] });
  }
  return streaks;
}

/**
 * Svelte keyed blocks require message ids to be unique. Storage hydration repairs
 * historical duplicates, but relay replay and concurrent session merges can still
 * briefly expose two versions of one message before the next persistence cycle.
 * Keep the render boundary total and prefer the confirmed/latest copy.
 */
function uniqueRenderableMessages(messages: readonly StoredMessage[]): StoredMessage[] {
  const unique = new Map<string, StoredMessage>();
  for (const message of messages) {
    const existing = unique.get(message.id);
    if (!existing) {
      unique.set(message.id, message);
      continue;
    }
    const existingCursor = existing.cursor ?? -1;
    const nextCursor = message.cursor ?? -1;
    if (nextCursor > existingCursor || (existing.pending === true && message.pending !== true)) {
      unique.set(message.id, message);
    }
  }
  return [...unique.values()];
}

export function relativeMessageTime(createdAt: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - createdAt);
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function nextRelativeMessageTimeDelay(createdAt: number, now = Date.now()): number | null {
  const ageMs = Math.max(0, now - createdAt);
  const step = ageMs < 10_000
    ? 1_000
    : ageMs < 30_000
      ? 5_000
      : ageMs < 60_000
        ? 10_000
        : ageMs < 3_600_000
          ? 60_000
          : ageMs < 86_400_000
            ? 3_600_000
            : ageMs < 7 * 86_400_000
              ? 86_400_000
              : null;
  if (step === null) return null;
  const nextBoundary = (Math.floor(ageMs / step) + 1) * step;
  return Math.max(50, nextBoundary - ageMs);
}
