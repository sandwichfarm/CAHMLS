import { createInviteUrl, type ChatInvite } from "@cahmls/sdk/client";
import { hostIdentityForRoom, type StoredRoom } from "@cahmls/sdk/client";

/** Build a room URL on the current app shell without changing its coordinator target. */
export function createSameShellChatHref(shellOrigin: string, room: StoredRoom | ChatInvite): string {
  if ("groupId" in room) return createInviteUrl(shellOrigin, room);

  return createInviteUrl(shellOrigin, {
    groupId: room.id,
    coordinatorPubkey: room.coordinatorPubkey,
    relayUrls: room.relayUrls,
    title: room.title,
    coordinatorOrigin: room.coordinatorOrigin,
    coordinatorName: room.coordinatorName,
    host: hostIdentityForRoom(room),
    coordinatorKeyMode: room.coordinatorKeyMode,
  });
}

/** Build the existing explicit auto-join handoff without trusting a received URL as a destination. */
export function createSameShellAutoJoinHref(shellOrigin: string, invite: ChatInvite): string {
  const href = new URL(createSameShellChatHref(shellOrigin, invite));
  href.searchParams.set("autojoin", "1");
  return href.toString();
}
