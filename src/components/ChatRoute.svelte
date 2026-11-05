<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { generate } from "lean-qr";
  import { toSvgDataURL } from "lean-qr/extras/svg";
  import type { NostrSigner } from "@contextvm/sdk/core";
  import type { CoordinatorStore } from "../coordinator/coordinator.svelte";
  import { createInviteUrl, parseInviteUrl, type ChatInvite, type RoomHostIdentity } from "../chat/invite";
  import type { ChatPaneContext } from "../chat/chat-pane-context";
  import { createSameShellAutoJoinHref, createSameShellChatHref } from "../chat/room-navigation";
  import { ChatRoomSession, createJoiningRoom, hostIdentityForRoom, listRooms, loadRoom, markRoomRead, reactionSummary, reconcileRoomHostIdentity, removeStoredRoom, requireRoomSigner, roomIdentityKey, roomTargetFor, roomUnreadCount, ROOMS_CHANGED_EVENT, saveRoom, sameRoomIdentity, type StoredRoom } from "../chat/room-store";
  import { CHAT_EMOJI_SHORTCUTS, normalizeRecipientPubkeys, type ChatEmojiShortcut } from "../chat/protocol";
  import { projectMessagePresentation } from "../chat/message-presentation";
  import { chatParticipantPreferences, type ParticipantHighlightName } from "../chat/chat-participant-preferences.svelte";
  import { nostrSocialStore } from "../invites/nostr-social.svelte";
  import { userProfileStore } from "../identity/user-profile.svelte";
  import { channelPreferences } from "../notifications/channel-preferences.svelte";
  import MessageGroup, { type CoordinatorReachability, type ParticipantRoomChoice } from "./MessageGroup.svelte";
  import RoomActionsMenu from "./RoomActionsMenu.svelte";
  import RoomHostBadge from "./RoomHostBadge.svelte";
  import RoomRemovalDialog from "./RoomRemovalDialog.svelte";
  import WorkspaceNav from "./WorkspaceNav.svelte";
  import { mountAppVisualViewport } from "./app-visual-viewport";

  interface Props {
    currentUrl: string;
    homeCoordinatorPubkey?: string;
    homeCoordinatorName?: string;
    coordinatorStatus?: string;
    coordinator: CoordinatorStore;
    coordinatorPubkey: string;
    onNavigate: (href: string) => void;
    identityReady?: boolean;
    embedded?: boolean;
    onContextChange?: (context: ChatPaneContext | null) => void;
    onRoomStored?: (room: StoredRoom) => void;
    inviteCoordinatorReachability?: (coordinatorPubkey: string) => CoordinatorReachability;
  }

  interface RoomRemovalTarget {
    room: StoredRoom;
    mode: "delete" | "leave";
  }

  let {
    currentUrl,
    homeCoordinatorPubkey,
    homeCoordinatorName = "My coordinator",
    coordinatorStatus = "idle",
    coordinator,
    coordinatorPubkey,
    onNavigate,
    identityReady = false,
    embedded = false,
    onContextChange,
    onRoomStored,
    inviteCoordinatorReachability = () => "unknown",
  }: Props = $props();
  let invite = $state<ChatInvite | null>(null);
  let room = $state<StoredRoom | null>(null);
  let session = $state<ChatRoomSession | null>(null);
  let revision = $state(0);
  let connection = $state<"cached" | "connecting" | "connected" | "offline">("cached");
  let connectionDetail = $state<string | undefined>();
  let name = $state("");
  let composer = $state("");
  let pendingRecipientPubkeys = $state<string[]>([]);
  const expandedIgnoredStreaks = new SvelteSet<string>();
  let composerError = $state("");
  let error = $state("");
  let joining = $state(false);
  let signerConnecting = $state(false);
  let signerMode = $state<"anonymous" | "extension" | "remote">("anonymous");
  let bunkerUri = $state("");
  let remoteUri = $state("");
  let remoteQr = $state("");
  let soundsEnabled = $state(channelPreferences.globalSound);
  let messageList: HTMLDivElement | undefined = $state();
  let composerInput: HTMLInputElement | undefined = $state();
  let audioContext: AudioContext | null = null;
  let knownMessageIds = new Set<string>();
  let unsubscribeSession: (() => void) | null = null;
  let unregisterAnonymousSession: (() => void) | null = null;
  let pendingRemoteSigner: ReturnType<typeof userProfileStore.createNip46Request>["signer"] | null = null;
  let disposed = false;
  let followLatest = true;
  let roomRemovalTarget = $state<RoomRemovalTarget | null>(null);
  let reactionPickerMessageId = $state<string | null>(null);
  let activeParticipantSurfaceKey = $state<string | null>(null);
  let reactionError = $state("");
  let routeInitialized = false;
  let routeInitializing = $state(true);
  const roomDeletedByHost = $derived(connection === "offline" && connectionDetail?.toLowerCase().includes("room deleted by host") === true);
  const displayedConnection = $derived(room ? (roomDeletedByHost ? "deleted" : connection) : null);
  const activeRoomHost = $derived(room
    ? hostIdentityForRoom(room)
    : invite
      ? hostIdentityForInvite(invite)
      : null
  );
  const activeRoomRemovalMode = $derived(room ? removalModeFor(room) : null);

  $effect(() => {
    if (!identityReady || routeInitialized) return;
    routeInitialized = true;
    void initializeRoute();
  });

  $effect(() => {
    const activeRoom = room;
    const activeHost = activeRoomHost;
    const activeConnection = displayedConnection;
    const removalMode = activeRoomRemovalMode;
    onContextChange?.({
      room: activeRoom,
      host: activeHost,
      connection: activeConnection,
      soundsEnabled,
      removalMode,
      toggleSounds: activeRoom ? toggleSounds : undefined,
      requestRemoval: activeRoom ? () => requestRoomRemoval(activeRoom) : undefined,
    });
  });

  function hostIdentityForInvite(nextInvite: ChatInvite): RoomHostIdentity {
    const host = nextInvite.host ?? { name: "Unknown host", pubkey: "" };
    // Avoid a cross-origin image request merely from opening an invite.
    return { ...host, avatar: undefined };
  }

  function mergeFreshInviteMetadata(stored: StoredRoom, nextInvite: ChatInvite): StoredRoom {
    let nextHost = stored.host;
    if (nextInvite.host) {
      const currentHost = hostIdentityForRoom(stored);
      const candidateHost = stored.joinRequestSent
        ? nextInvite.host
        : reconcileRoomHostIdentity(nextInvite.host, currentHost.pubkey || null);
      // Once admitted, ignore an invite that claims a different creator instead
      // of replacing already verified presentation with untrusted metadata.
      if (!stored.joinRequestSent && candidateHost.name === "Unknown host" && currentHost.name !== "Unknown host") {
        nextHost = stored.host;
      } else {
        nextHost = candidateHost;
      }
    }
    const nextCoordinatorKeyMode = nextInvite.coordinatorKeyMode ?? stored.coordinatorKeyMode;
    const nextCoordinatorName = nextInvite.coordinatorName ?? stored.coordinatorName;
    if (stored.host?.name === nextHost?.name
      && stored.host?.pubkey === nextHost?.pubkey
      && stored.host?.avatar === nextHost?.avatar
      && stored.coordinatorKeyMode === nextCoordinatorKeyMode
      && stored.coordinatorName === nextCoordinatorName) return stored;
    const refreshed = {
      ...stored,
      host: nextHost,
      coordinatorKeyMode: nextCoordinatorKeyMode,
      coordinatorName: nextCoordinatorName,
    };
    saveRoom(refreshed);
    return refreshed;
  }

  function update() {
    if (session) {
      const wasConnected = connection === "connected";
      connection = session.status.connection;
      connectionDetail = session.status.detail;
      const nextRoom = { ...session.room, messages: [...session.room.messages], pending: [...session.room.pending], reactions: [...(session.room.reactions ?? [])] };
      const appendedMessage = nextRoom.messages.some((message) => !knownMessageIds.has(message.id));
      const receivedMessage = nextRoom.messages.some((message) => !knownMessageIds.has(message.id) && message.sender !== nextRoom.stablePubkey);
      knownMessageIds = new Set(nextRoom.messages.map((message) => message.id));
      room = nextRoom;
      acknowledgeVisibleRoom();
      if (receivedMessage && wasConnected) playIncomingTone();
      if (appendedMessage && followLatest) {
        void tick().then(() => {
          if (messageList) messageList.scrollTop = messageList.scrollHeight;
        });
      }
    }
    revision += 1;
  }

  function acknowledgeVisibleRoom(): void {
    const activeRoom = room;
    if (!activeRoom || document.visibilityState !== "visible") return;
    const routedInvite = parseInviteUrl(currentUrl);
    if (routedInvite && (routedInvite.groupId !== activeRoom.id || routedInvite.coordinatorPubkey !== activeRoom.coordinatorPubkey)) return;
    if (connection !== "connected" && connection !== "cached" && connection !== "offline") return;
    if (roomUnreadCount(activeRoom) === 0) return;
    if (session && sameRoomIdentity(session.room, activeRoom)) session.markRead();
    else markRoomRead(roomTargetFor(activeRoom));
  }

  async function attach(nextRoom: StoredRoom, signer: NostrSigner) {
    if (disposed) return;
    await requireRoomSigner(nextRoom, signer);
    if (disposed) return;
    unsubscribeSession?.();
    unregisterAnonymousSession?.();
    unregisterAnonymousSession = null;
    session?.stop();
    knownMessageIds = new Set(nextRoom.messages.map((message) => message.id));
    followLatest = true;
    room = nextRoom;
    session = new ChatRoomSession(nextRoom, signer);
    const attachedSession = session;
    connection = session.status.connection;
    connectionDetail = session.status.detail;
    unsubscribeSession = session.subscribe(update);
    if (userProfileStore.method === "anonymous" && userProfileStore.activeSigner === signer) {
      const stablePubkey = await signer.getPublicKey();
      unregisterAnonymousSession = userProfileStore.registerAnonymousSession({
        stablePubkey,
        retire: () => {
          if (session !== attachedSession) return;
          unsubscribeSession?.();
          unsubscribeSession = null;
          attachedSession.discard();
          session = null;
          connection = "cached";
          connectionDetail = "Local identity was retired";
          update();
        },
        restore: async () => {
          const restored = loadRoom(nextRoom.id, nextRoom.coordinatorPubkey);
          const activeSigner = userProfileStore.activeSigner;
          if (!restored || userProfileStore.method !== "anonymous" || !activeSigner) return;
          await requireRoomSigner(restored, activeSigner);
          if (!disposed) await attach(restored, activeSigner);
        },
      });
    }
    void session.start();
    update();
    onRoomStored?.(nextRoom);
    void tick().then(() => {
      if (messageList) messageList.scrollTop = messageList.scrollHeight;
    });
  }

  async function enableSounds(updatePreference = true) {
    try {
      audioContext ??= new AudioContext();
      await audioContext.resume();
      if (updatePreference) {
        soundsEnabled = true;
        channelPreferences.setGlobalSound(true);
      }
    } catch {
      if (updatePreference) {
        soundsEnabled = false;
        channelPreferences.setGlobalSound(false);
      }
    }
  }

  function playIncomingTone() {
    const activeRoomKey = room ? roomIdentityKey(room.coordinatorPubkey, room.id) : undefined;
    if ((activeRoomKey ? !channelPreferences.soundEnabled(activeRoomKey) : !channelPreferences.globalSound) || !audioContext || audioContext.state !== "running") return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.setValueAtTime(720, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(960, audioContext.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.045, audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.14);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.15);
  }

  function addEmoji(emoji: string) {
    if (!canSendMessages()) return;
    composer += emoji;
    composerInput?.focus();
  }

  async function setReaction(targetMessageId: string, emoji: ChatEmojiShortcut, active: boolean): Promise<void> {
    if (!session) return;
    reactionError = "";
    try {
      await session.setReaction(targetMessageId, emoji, active);
      reactionPickerMessageId = null;
      await tick();
      document.getElementById(`guest-add-reaction-${targetMessageId}`)?.focus();
    } catch (cause) {
      reactionError = cause instanceof Error ? cause.message : "Could not update reaction";
    }
  }

  async function toggleReaction(targetMessageId: string, emoji: ChatEmojiShortcut): Promise<void> {
    if (!session) return;
    reactionError = "";
    try {
      await session.toggleReaction(targetMessageId, emoji);
    } catch (cause) {
      reactionError = cause instanceof Error ? cause.message : "Could not update reaction";
    }
  }

  function connectionLabel(status: "cached" | "connecting" | "connected" | "offline" | "deleted"): string {
    if (status === "connected") return "Room synced";
    if (status === "deleted") return "Room deleted";
    if (status === "offline") return "Room offline";
    if (status === "cached") return "Room cached";
    return "Room connecting";
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !reactionPickerMessageId) return;
    event.preventDefault();
    const targetMessageId = reactionPickerMessageId;
    reactionPickerMessageId = null;
    void tick().then(() => document.getElementById(`guest-add-reaction-${targetMessageId}`)?.focus());
  }

  function navigate(href: string): void {
    onNavigate(href);
  }

  function updateFollowLatest(): void {
    if (!messageList) return;
    followLatest = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  }

  function canSendMessages(): boolean {
    return session?.status.connection === "connected" && room?.joinRequestSent !== true;
  }

  function describeJoinFailure(cause: unknown): string {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (/\b-32001\b|request timed out|\btimeout\b/i.test(detail)) {
      return "Couldn’t reach this coordinator through the invite’s relay paths. Make sure the host is online, then try again.";
    }
    return detail || "Unable to join this chat";
  }

  async function toggleSounds() {
    if (channelPreferences.globalSound) {
      soundsEnabled = false;
      channelPreferences.setGlobalSound(false);
      return;
    }
    await enableSounds();
  }

  function isCurrentCoordinatorHost(target: StoredRoom): boolean {
    const localCoordinatorPubkey = coordinatorPubkey.trim().toLowerCase();
    return target.isHost
      && localCoordinatorPubkey.length > 0
      && target.coordinatorPubkey.trim().toLowerCase() === localCoordinatorPubkey;
  }

  function removalModeFor(target: StoredRoom): "delete" | "leave" {
    return isCurrentCoordinatorHost(target) ? "delete" : "leave";
  }

  function removalCoordinatorLabel(target: Pick<StoredRoom, "coordinatorPubkey">): string {
    if (target.coordinatorPubkey === homeCoordinatorPubkey || target.coordinatorPubkey === coordinatorPubkey) {
      return homeCoordinatorName || "My coordinator";
    }
    return `Coordinator ${target.coordinatorPubkey.slice(0, 6)}…${target.coordinatorPubkey.slice(-4)}`;
  }

  function requestRoomRemoval(target: StoredRoom): void {
    roomRemovalTarget = { room: target, mode: removalModeFor(target) };
  }

  async function removeCurrentRoom(): Promise<boolean> {
    const removal = roomRemovalTarget;
    if (!removal) return false;
    const { room: target, mode } = removal;
    try {
      const latest = loadRoom(target.id, target.coordinatorPubkey);
      if (!latest || !sameRoomIdentity(latest, target) || removalModeFor(latest) !== mode) return false;
      if (mode === "delete") {
        if (!isCurrentCoordinatorHost(latest)) return false;
        await coordinator.deleteHostedRoom({
          id: latest.id,
          coordinatorPubkey: latest.coordinatorPubkey,
        });
      }
      unsubscribeSession?.();
      unsubscribeSession = null;
      unregisterAnonymousSession?.();
      unregisterAnonymousSession = null;
      session?.discard();
      session = null;
      removeStoredRoom(latest, { reason: mode === "delete" ? "deleted" : "left", coordinatorLabel: removalCoordinatorLabel(latest) });
      room = null;
      navigate(mode === "delete" ? "/" : "/chats");
      return true;
    } catch {
      return false;
    }
  }

  async function initializeRoute(): Promise<void> {
    invite = parseInviteUrl(currentUrl);
    if (!invite) {
      routeInitializing = false;
      return;
    }

    const loaded = loadRoom(invite.groupId, invite.coordinatorPubkey);
    const stored = loaded ? mergeFreshInviteMetadata(loaded, invite) : null;
    if (stored) {
      room = stored;
      const activeSigner = userProfileStore.activeSigner;
      if (activeSigner) await resumeActiveSigner(stored, activeSigner);
      routeInitializing = false;
      return;
    }

    if (!userProfileStore.hasIdentity) {
      routeInitializing = false;
      return;
    }

    name = userProfileStore.displayName;
    const activeSigner = userProfileStore.activeSigner;
    if (activeSigner) await join(activeSigner);
    routeInitializing = false;
  }

  async function retryEstablishedIdentity(): Promise<void> {
    if (!invite || !userProfileStore.hasIdentity || joining || signerConnecting) return;
    routeInitializing = true;
    error = "";
    name = userProfileStore.displayName;
    const activeSigner = userProfileStore.activeSigner;
    if (activeSigner) await join(activeSigner);
    routeInitializing = false;
  }

  onMount(() => {
    const visualViewport = embedded ? undefined : mountAppVisualViewport(document.documentElement);
    disposed = false;
    const handleRoomsChanged = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { action?: string; roomId?: string; coordinatorPubkey?: string } : undefined;
      if (detail?.action !== "removed" || !room || detail.roomId !== room.id || detail.coordinatorPubkey !== room.coordinatorPubkey) return;
      unsubscribeSession?.();
      unsubscribeSession = null;
      unregisterAnonymousSession?.();
      unregisterAnonymousSession = null;
      session?.discard();
      session = null;
      room = null;
      connection = "cached";
      connectionDetail = undefined;
      onContextChange?.(null);
      navigate("/");
    };
    window.addEventListener(ROOMS_CHANGED_EVENT, handleRoomsChanged);
    const acknowledgeOnVisibility = () => acknowledgeVisibleRoom();
    document.addEventListener("visibilitychange", acknowledgeOnVisibility);
    acknowledgeVisibleRoom();
    return () => {
      visualViewport?.destroy();
      window.removeEventListener(ROOMS_CHANGED_EVENT, handleRoomsChanged);
      document.removeEventListener("visibilitychange", acknowledgeOnVisibility);
    };
  });
  onDestroy(() => {
    disposed = true;
    onContextChange?.(null);
    if (pendingRemoteSigner) userProfileStore.cancelNip46Request(pendingRemoteSigner);
    pendingRemoteSigner = null;
    unsubscribeSession?.();
    unregisterAnonymousSession?.();
    unregisterAnonymousSession = null;
    session?.stop();
  });

  async function join(signer: NostrSigner) {
    if (!invite || disposed) return;
    joining = true;
    error = "";
    try {
      const created = await createJoiningRoom({
        invite,
        name,
        signer,
        identityOwner: userProfileStore.method === "anonymous" ? "anonymous" : "external",
        avatar: userProfileStore.avatarUrl,
      });
      if (disposed) return;
      await attach(created, signer);
    } catch (cause) {
      if (!disposed) error = describeJoinFailure(cause);
    } finally {
      if (!disposed) joining = false;
    }
  }

  async function joinAnonymous() {
    if (signerConnecting || joining) return;
    signerConnecting = true;
    void enableSounds(false);
    try {
      const signer = userProfileStore.activeSigner;
      if (!signer) throw new Error("Local identity is not ready");
      if (!disposed) await join(signer);
    } finally {
      if (!disposed) signerConnecting = false;
    }
  }

  async function joinExtension() {
    if (signerConnecting || joining) return;
    void enableSounds(false);
    signerConnecting = true;
    try {
      const signer = await userProfileStore.connectNip07();
      if (disposed) return;
      if (!name.trim() && userProfileStore.displayName !== "anon") name = userProfileStore.displayName;
      if (room && !session) await resume(signer);
      else await join(signer);
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : "Could not connect browser signer";
    } finally {
      if (!disposed) signerConnecting = false;
    }
  }

  async function beginRemote() {
    if (!invite || joining || signerConnecting) return;
    void enableSounds(false);
    error = "";
    const { signer: remote, uri } = userProfileStore.createNip46Request(invite.relayUrls);
    pendingRemoteSigner = remote;
    remoteUri = uri;
    remoteQr = toSvgDataURL(generate(remoteUri), { on: "#c8ffdc", off: "#101614", pad: 2, scale: 4 });
    joining = true;
    try {
      await remote.waitForSigner();
      if (disposed || pendingRemoteSigner !== remote) return;
      const signer = await userProfileStore.adoptNip46(remote);
      if (disposed || pendingRemoteSigner !== remote) return;
      if (!name.trim() && userProfileStore.displayName !== "anon") name = userProfileStore.displayName;
      if (room && !session) await resume(signer);
      else await join(signer);
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : "Remote signer did not connect";
    } finally {
      if (pendingRemoteSigner === remote) pendingRemoteSigner = null;
      if (!disposed) joining = false;
    }
  }

  async function joinBunker() {
    if (signerConnecting || joining) return;
    void enableSounds(false);
    signerConnecting = true;
    try {
      const signer = await userProfileStore.connectNip46(bunkerUri.trim());
      if (disposed) return;
      if (!name.trim() && userProfileStore.displayName !== "anon") name = userProfileStore.displayName;
      if (room && !session) await resume(signer);
      else await join(signer);
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : "Could not connect bunker";
    } finally {
      if (!disposed) signerConnecting = false;
    }
  }

  async function send() {
    if (!session || !canSendMessages()) return;
    const next = composer;
    const recipients = [...pendingRecipientPubkeys];
    if (!next.trim()) return;
    void enableSounds(false);
    composerError = "";
    session.setIdentity({
      name: userProfileStore.displayName,
      avatar: userProfileStore.avatarUrl,
    });
    composer = "";
    pendingRecipientPubkeys = [];
    try {
      await session.send(next, { recipientPubkeys: recipients });
    } catch (cause) {
      if (!composer.trim()) composer = next;
      if (pendingRecipientPubkeys.length === 0) pendingRecipientPubkeys = recipients;
      composerError = cause instanceof Error ? cause.message : "Unable to send this message";
    }
  }

  function mentionParticipant(pubkey: string, displayName: string): void {
    const input = composerInput;
    const start = input?.selectionStart ?? composer.length;
    const end = input?.selectionEnd ?? composer.length;
    const before = composer.slice(0, start);
    const after = composer.slice(end);
    const leading = before && !/\s$/.test(before) ? " " : "";
    const trailing = after && !/^\s/.test(after) ? " " : "";
    const token = `@${displayName}`;
    composer = `${before}${leading}${token}${trailing}${after}`;
    pendingRecipientPubkeys = [...new Set([...pendingRecipientPubkeys, pubkey.toLowerCase()])];
    void tick().then(() => {
      composerInput?.focus();
      const cursor = before.length + leading.length + token.length + trailing.length;
      composerInput?.setSelectionRange(cursor, cursor);
    });
  }

  function participantRoomChoices(): ParticipantRoomChoice[] {
    const currentRoom = room;
    if (!currentRoom) return [];
    return listRooms()
      .filter((candidate) => candidate.membershipStatus !== "retired" && !sameRoomIdentity(candidate, currentRoom))
      .map((candidate) => ({
        coordinatorPubkey: candidate.coordinatorPubkey,
        roomId: candidate.id,
        title: candidate.title,
        coordinatorLabel: candidate.coordinatorName?.trim()
          || `Coordinator ${candidate.coordinatorPubkey.slice(0, 6)}…${candidate.coordinatorPubkey.slice(-4)}`,
      }));
  }

  async function inviteParticipantToRoom(participantPubkey: string, choice: ParticipantRoomChoice): Promise<void> {
    const activeSession = session;
    const currentRoom = room;
    const recipients = normalizeRecipientPubkeys([participantPubkey]);
    if (recipients.length !== 1) throw new Error("This participant cannot receive a targeted invite");
    const candidate = listRooms().find((stored) => stored.membershipStatus !== "retired"
      && stored.coordinatorPubkey === choice.coordinatorPubkey
      && stored.id === choice.roomId);
    if (!activeSession || !currentRoom || !candidate || sameRoomIdentity(candidate, currentRoom)) throw new Error("Room is no longer available");
    const inviteUrl = createInviteUrl(window.location.origin, {
      groupId: candidate.id,
      coordinatorPubkey: candidate.coordinatorPubkey,
      relayUrls: candidate.relayUrls,
      title: candidate.title,
      coordinatorOrigin: candidate.coordinatorOrigin,
      coordinatorName: candidate.coordinatorName,
      inviteToken: candidate.inviteToken,
      host: hostIdentityForRoom(candidate),
      coordinatorKeyMode: candidate.coordinatorKeyMode,
    });
    activeSession.setIdentity({ name: userProfileStore.displayName, avatar: userProfileStore.avatarUrl });
    await activeSession.send(inviteUrl, { recipientPubkeys: recipients });
  }

  function participantIgnored(pubkey: string): boolean {
    return room ? chatParticipantPreferences.isIgnored(room.coordinatorPubkey, room.id, pubkey) : false;
  }

  function setParticipantIgnored(pubkey: string): void {
    if (!room) return;
    chatParticipantPreferences.setIgnored(room.coordinatorPubkey, room.id, pubkey, true);
  }

  function toggleIgnoredStreak(key: string): void {
    if (expandedIgnoredStreaks.has(key)) expandedIgnoredStreaks.delete(key);
    else expandedIgnoredStreaks.add(key);
  }

  function setParticipantHighlight(pubkey: string, name: ParticipantHighlightName | undefined): void {
    chatParticipantPreferences.setHighlight(pubkey, name);
  }

  async function followParticipant(pubkey: string): Promise<void> {
    await nostrSocialStore.follow(pubkey);
  }

  async function resume(signer: NostrSigner) {
    if (!room) return;
    const expectedRoom = room;
    if (disposed || room.id !== expectedRoom.id || room.coordinatorPubkey !== expectedRoom.coordinatorPubkey) return;
    await requireRoomSigner(expectedRoom, signer);
    if (disposed) return;
    await attach(expectedRoom, signer);
  }

  async function resumeActiveSigner(expectedRoom: StoredRoom, signer: NostrSigner) {
    try {
      await requireRoomSigner(expectedRoom, signer);
      if (disposed) return;
      if (room?.id !== expectedRoom.id || room.coordinatorPubkey !== expectedRoom.coordinatorPubkey) return;
      await attach(expectedRoom, signer);
    } catch {
      // The cached room remains readable when the active signer is unavailable.
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<section class:embedded class="chat-page flex flex-col overflow-hidden bg-[#0b0e0d] text-[#e8f5eb]" data-testid="chat-route">
  {#if !embedded}
    <header class="chat-global-nav flex shrink-0 items-center justify-between gap-3 px-3 py-3 sm:px-5">
    <div class="chat-workspace-nav">
      <WorkspaceNav
        {currentUrl}
        {homeCoordinatorPubkey}
        {homeCoordinatorName}
        {coordinatorStatus}
        {coordinator}
        {soundsEnabled}
        activeRoomHost={activeRoomHost ?? undefined}
        roomConnectionStatus={room ? (roomDeletedByHost ? "deleted" : connection) : undefined}
        onNavigate={navigate}
      />
    </div>
    <div class="mobile-primary-actions" aria-label="Current room controls">
      {#if displayedConnection}
        <span
          class:offline={displayedConnection === "offline"}
          class:deleted={displayedConnection === "deleted"}
          class:cached={displayedConnection === "cached"}
          class:connecting={displayedConnection === "connecting"}
          class="mobile-connection"
          role="status"
          aria-label={connectionLabel(displayedConnection)}
          title={connectionLabel(displayedConnection)}
        ><span aria-hidden="true"></span></span>
        <button
          class:enabled={soundsEnabled}
          class="mobile-sound-toggle"
          type="button"
          aria-label={soundsEnabled ? "Mute sounds" : "Enable sounds"}
          aria-pressed={soundsEnabled}
          title={soundsEnabled ? "Notification sounds on" : "Notification sounds off"}
          onclick={() => void toggleSounds()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9h3.3L12 5.2v13.6L7.3 15H4z"></path>
            {#if soundsEnabled}<path d="M15.5 9.1a4 4 0 0 1 0 5.8M18 6.7a7.4 7.4 0 0 1 0 10.6"></path>{:else}<path d="m16 9 5 6m0-6-5 6"></path>{/if}
          </svg>
        </button>
      {/if}
    </div>
    </header>
  {/if}
  {#if !identityReady || routeInitializing}
    <section class="identity-pending flex min-h-0 flex-1 items-center justify-center p-5" data-testid="chat-identity-pending" aria-live="polite">
      <div>
        <span class="pending-pulse" aria-hidden="true"></span>
        <p>Opening {invite?.title ? `# ${invite.title}` : "room"}</p>
        <small>{identityReady ? "Connecting with your current identity…" : "Restoring your identity…"}</small>
      </div>
    </section>
  {:else if !invite}
    <section class="flex min-h-0 flex-1 items-center justify-center p-5"><div class="max-w-sm border border-[#293832] bg-[#101614] p-6 text-sm text-[#a2b4a7]">This chat invite is incomplete or malformed.</div></section>
  {:else if !room && userProfileStore.hasIdentity}
    <section class="identity-pending flex min-h-0 flex-1 items-center justify-center p-5" data-testid="chat-join-error">
      <div>
        <p>Could not open # {invite.title || "room"}</p>
        <small>{error || "The room could not be joined with your current identity."}</small>
        <button class="secondary-button" type="button" disabled={joining || signerConnecting} onclick={() => void retryEstablishedIdentity()}>Try again</button>
      </div>
    </section>
  {:else if !room}
    <section class="mx-auto flex min-h-0 w-full max-w-xl flex-1 items-center overflow-y-auto p-4 sm:p-8"><div class="w-full border border-[#293832] bg-[#101614] p-5 shadow-2xl sm:p-8">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[#7cf59d]">Cordn private chat</p>
      <h1 class="mt-3 text-3xl font-semibold tracking-tight text-white">{invite.title || "You’re invited"}</h1>
      <p class="mt-2 leading-6 text-[#a2b4a7]">Choose a name, then join the encrypted room. This invite connects only to its host coordinator.</p>
      {#if invite.coordinatorKeyMode === "ephemeral"}
        <p class="invite-key-warning" data-testid="temporary-host-key-notice">This host uses a temporary coordinator key. If it changes, the saved conversation stays readable here, but reconnecting requires a new invite and the old room can be left from Room actions.</p>
      {/if}
      <div class="invite-host" data-testid="invite-host">
        <span>Invited by</span>
        <RoomHostBadge host={activeRoomHost || hostIdentityForInvite(invite)} showRole={false} allowExternalAvatar={false} />
      </div>
      <label class="mt-6 block text-sm font-medium text-[#d4e7da]">Your name<input bind:value={name} class="guest-input mt-2" placeholder="e.g. River" /></label>
      <div class="mt-5 grid gap-2 sm:grid-cols-3">
        <button class:active={signerMode === "anonymous"} class="choice" onclick={() => signerMode = "anonymous"}>Stay anonymous</button>
        <button class:active={signerMode === "extension"} class="choice" onclick={() => signerMode = "extension"}>NIP-07</button>
        <button class:active={signerMode === "remote"} class="choice" onclick={() => signerMode = "remote"}>NIP-46</button>
      </div>
      {#if signerMode === "anonymous"}<p class="mt-3 text-sm text-[#91a59a]">A chat-only identity stays on this device. No account needed.</p>{/if}
      {#if signerMode === "extension"}<p class="mt-3 text-sm text-[#91a59a]">Use your browser Nostr signer; your key stays in the extension.</p>{/if}
      {#if signerMode === "remote"}
        <div class="mt-4 border border-[#293832] bg-[#0b0e0d] p-4"><p class="text-sm text-[#b9cbbf]">Use a remote signer app, or paste its bunker URI.</p>
          <div class="mt-3 flex flex-col gap-2 sm:flex-row"><input bind:value={bunkerUri} class="guest-input min-w-0 flex-1" placeholder="bunker://…" /><button class="secondary-button" disabled={joining || signerConnecting} onclick={joinBunker}>Connect bunker</button></div>
          {#if remoteUri}<a href={remoteUri} class="mt-4 flex w-fit flex-col items-center border border-[#293832] bg-[#101614] p-3 text-xs text-[#bff6cc]"><img src={remoteQr} alt="QR code to connect remote signer" class="h-40 w-40" />Tap on mobile to open a signer</a>{/if}
        </div>
      {/if}
      {#if error}<p class="mt-4 text-sm text-[#ffaaa3]">{error}</p>{/if}
      <button class="primary-button mt-6 w-full" disabled={joining || signerConnecting} onclick={signerMode === "anonymous" ? joinAnonymous : signerMode === "extension" ? joinExtension : beginRemote}>{joining || signerConnecting ? "Connecting…" : signerMode === "remote" ? "Connect signer" : "Join chat"}</button>
    </div></section>
  {:else}
    {@const currentRoom = room}
    {@const composerEnabled = connection === "connected" && !currentRoom.joinRequestSent}
    <section class="room-pane mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col border-x border-[#1e2924] bg-[#101614]" data-revision={revision} data-testid="cached-room-view">
      <h1 class="sr-only">{currentRoom.title}</h1>
      <RoomActionsMenu
        roomTitle={currentRoom.title}
        roomId={currentRoom.id}
        coordinatorPubkey={currentRoom.coordinatorPubkey}
        inviteUrl={createSameShellChatHref(window.location.origin, currentRoom)}
        removalMode={activeRoomRemovalMode ?? "leave"}
        onRemove={() => requestRoomRemoval(currentRoom)}
      />
      {#if roomDeletedByHost}
        <p class="connection-banner deleted" role="status" aria-live="polite" data-testid="room-deleted-message">This room was deleted by its host. Cached messages remain on this device until you leave.</p>
      {:else if connection === "offline"}
        <p class="connection-banner offline" role="status" aria-live="polite" data-testid="room-connection-offline-message">Room connection offline. You can read cached messages, but sending is unavailable until this room reconnects.</p>
      {:else if connection === "connecting"}
        <p class="connection-banner" role="status" aria-live="polite">Connecting to the coordinator… Cached messages are available.</p>
      {:else if connectionDetail && !currentRoom.joinRequestSent}
        <p class="connection-banner" role="status">{connectionDetail}</p>
      {/if}
      {#if !session}
        <div class="reconnect-panel" data-testid="reconnect-signer">
          <div><strong>Cached conversation</strong><span>Reconnect the signer that joined this room to sync and send. The messages below remain readable.</span></div>
          <div class="reconnect-actions"><button class="secondary-button" type="button" disabled={joining || signerConnecting} onclick={joinExtension}>Use NIP-07</button><button class="secondary-button" type="button" disabled={joining || signerConnecting} onclick={() => signerMode = "remote"}>Use NIP-46</button></div>
          {#if signerMode === "remote"}
            <div class="reconnect-remote"><input bind:value={bunkerUri} class="guest-input" placeholder="bunker://…" /><button class="secondary-button" type="button" disabled={joining || signerConnecting} onclick={joinBunker}>Connect bunker</button><button class="secondary-button" type="button" disabled={joining || signerConnecting} onclick={beginRemote}>{joining ? "Waiting…" : "Show QR"}</button></div>
            {#if remoteUri}<a href={remoteUri} class="remote-resume-qr"><img src={remoteQr} alt="QR code to reconnect remote signer" />Open in a signer</a>{/if}
          {/if}
          {#if error}<p class="text-sm text-[#ffaaa3]">{error}</p>{/if}
        </div>
      {/if}
      {#if currentRoom.joinRequestSent}<div class="m-4 border border-[#2e553b] bg-[#112219] p-4 text-sm text-[#b9eac5]">Your encrypted join request is with the host. This page keeps checking for your welcome.</div>{:else}
        <div bind:this={messageList} class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5 sm:px-6" role="log" aria-live="polite" aria-relevant="additions" data-testid="guest-message-list" onscroll={updateFollowLatest}>
          {#if currentRoom.messages.length === 0}<p class="pt-16 text-center text-sm text-[#82958a]">Say hello — messages are encrypted before they leave your device.</p>{/if}
          {#each projectMessagePresentation(currentRoom.messages, currentRoom.stablePubkey, participantIgnored) as streak (streak.instanceKey)}
            {#if streak.ignored && !expandedIgnoredStreaks.has(streak.instanceKey)}
              <button class="ignored-streak-disclosure" type="button" aria-expanded="false" aria-label={`${streak.messages[0].name || "anon"} posted ${streak.messages.length} ${streak.messages.length === 1 ? "message" : "messages"}. Show messages`} onclick={() => toggleIgnoredStreak(streak.instanceKey)}><span>{streak.messages[0].name || "anon"} posted {streak.messages.length} {streak.messages.length === 1 ? "message" : "messages"}</span> <span>Show messages</span></button>
            {:else}
              {#if streak.ignored}<button class="ignored-streak-disclosure" type="button" aria-expanded="true" aria-label={`${streak.messages[0].name || "anon"} posted ${streak.messages.length} ${streak.messages.length === 1 ? "message" : "messages"}. Hide messages`} onclick={() => toggleIgnoredStreak(streak.instanceKey)}><span>{streak.messages[0].name || "anon"} posted {streak.messages.length} {streak.messages.length === 1 ? "message" : "messages"}</span> <span>Hide messages</span></button>{/if}
              <MessageGroup
                messages={streak.messages}
                viewerPubkey={currentRoom.stablePubkey}
                reactionsFor={(messageId) => reactionSummary(currentRoom, messageId, currentRoom.stablePubkey)}
                pickerOpenMessageId={reactionPickerMessageId}
                participantSurfaceKey={`guest:${streak.instanceKey}`}
                {activeParticipantSurfaceKey}
                disabled={!composerEnabled}
                idPrefix="guest"
                highlight={chatParticipantPreferences.highlightFor(streak.sender)}
                followAvailable={Boolean(nostrSocialStore.contactPubkey)}
                followStatus={nostrSocialStore.followStatus}
                onTogglePicker={(messageId) => reactionPickerMessageId = reactionPickerMessageId === messageId ? null : messageId}
                onClosePicker={(messageId) => { if (reactionPickerMessageId === messageId) reactionPickerMessageId = null; }}
                onToggleReaction={toggleReaction}
                onSetReaction={(messageId, emoji) => setReaction(messageId, emoji, true)}
                onActivateParticipantSurface={(key) => activeParticipantSurfaceKey = key}
                onDismissParticipantSurface={(key) => { if (activeParticipantSurfaceKey === key) activeParticipantSurfaceKey = null; }}
                onJoinInvite={(sharedInvite) => navigate(createSameShellAutoJoinHref(window.location.origin, sharedInvite))}
                {inviteCoordinatorReachability}
                participantRooms={participantRoomChoices()}
                onMention={mentionParticipant}
                onInviteToRoom={inviteParticipantToRoom}
                onIgnore={setParticipantIgnored}
                onHighlight={setParticipantHighlight}
                onFollow={followParticipant}
              />
            {/if}
          {/each}
        </div>
        <form class="chat-composer shrink-0 border-t border-[#293832] bg-[#101614] p-3 sm:p-4" data-testid="chat-composer" onsubmit={(event) => { event.preventDefault(); void send(); }}>
          <div id="chat-emoji-shortcuts" class="emoji-shortcuts" aria-label="Emoji shortcuts">{#each CHAT_EMOJI_SHORTCUTS as emoji (emoji)}<button type="button" class="emoji-button" aria-label={`Add ${emoji}`} disabled={!composerEnabled} onclick={() => addEmoji(emoji)}>{emoji}</button>{/each}</div>
          <div class="composer-row">
            <input bind:this={composerInput} bind:value={composer} class="guest-input min-w-0 flex-1" aria-describedby="chat-composer-status" disabled={!composerEnabled} placeholder={roomDeletedByHost ? "Room deleted by host" : connection === "offline" ? "Room offline" : connection === "cached" ? "Reconnect your signer" : connection === "connecting" ? "Connecting…" : "Message"} />
            <button class="primary-button px-4 sm:px-5" disabled={!composerEnabled || !composer.trim()}>Send</button>
          </div>
          <p id="chat-composer-status" class:unavailable={!composerEnabled} class="composer-status" aria-live="polite" data-testid="chat-composer-status">{roomDeletedByHost ? "This room is closed — cached messages are read-only." : connection === "offline" ? "This room is offline — cached messages are read-only." : connection === "cached" ? "Reconnect your signer to sync this room and send messages." : connection === "connecting" ? "Connecting this room…" : "Connected. Messages are end-to-end encrypted."}</p>
          {#if composerError || reactionError}<p class="mt-2 text-center text-xs text-[#ffaaa3]" role="status">{composerError || reactionError}</p>{/if}
        </form>
      {/if}
    </section>
  {/if}

  {#if roomRemovalTarget}
    <RoomRemovalDialog
      mode={roomRemovalTarget.mode}
      roomTitle={roomRemovalTarget.room.title}
      hostLabel={hostIdentityForRoom(roomRemovalTarget.room).name}
      coordinatorLabel={removalCoordinatorLabel(roomRemovalTarget.room)}
      messageCount={roomRemovalTarget.room.messages.length}
      pendingInviteCount={roomRemovalTarget.mode === "delete" ? session?.pendingJoinRequests.length ?? 0 : 0}
      joinRequestPending={roomRemovalTarget.mode === "leave" && roomRemovalTarget.room.joinRequestSent === true}
      onConfirm={removeCurrentRoom}
      onClose={() => roomRemovalTarget = null}
    />
  {/if}
</section>

<style>
  .ignored-streak-disclosure { width: 100%; border: 1px solid #293832; background: #101614; padding: 8px 16px; color: #82958a; font-size: 14px; font-weight: 400; line-height: 1.5; overflow-wrap: anywhere; }
  .ignored-streak-disclosure:hover, .ignored-streak-disclosure:focus-visible { border-color: #7cf59d; color: #dfffe7; outline: 2px solid #7cf59d; outline-offset: 2px; }
  .chat-page { width: 100%; height: var(--app-visual-height, 100dvh); max-height: var(--app-visual-height, 100dvh); overscroll-behavior: contain; }
  .chat-page.embedded { position: static; inset: auto; width: 100%; min-width: 0; height: 100%; max-width: none; max-height: 100%; background: #101614; }
  .chat-page.embedded > [data-testid="cached-room-view"] { width: 100%; min-width: 0; max-width: none; margin-inline: 0; border-inline: 0; }
  .identity-pending > div { display: grid; max-width: 28rem; justify-items: center; gap: .65rem; text-align: center; }
  .identity-pending p { color: #dfffe7; font-size: .82rem; font-weight: 650; }
  .identity-pending small { color: #82958a; font-size: .66rem; line-height: 1.55; }
  .identity-pending .secondary-button { margin-top: .35rem; }
  .pending-pulse { width: .55rem; height: .55rem; border-radius: 999px; background: #d9d68e; box-shadow: 0 0 0 0 rgb(217 214 142 / .28); animation: pending-pulse 1.5s ease-out infinite; }
  @keyframes pending-pulse { 65%, 100% { box-shadow: 0 0 0 .65rem rgb(217 214 142 / 0); } }
  .chat-global-nav { min-width: 0; border-bottom: 1px solid #21352a; background: rgb(10 16 12 / .96); }
  .chat-workspace-nav { min-width: 0; flex: 1 1 auto; }
  .mobile-primary-actions { display: none; }
  .guest-input { width: 100%; border: 1px solid #34433b; background: #0b0e0d; padding: .75rem .9rem; color: #f3fff6; outline: none; }
  .guest-input:focus { border-color: #7cf59d; box-shadow: 0 0 0 2px rgb(124 245 157 / .12); }
  .guest-input:disabled { cursor: not-allowed; border-color: #26322c; color: #64766b; opacity: .72; }
  .invite-host { display: flex; min-width: 0; align-items: center; gap: .7rem; margin-top: .9rem; color: #718277; }
  .invite-host > span { flex: 0 0 auto; font-size: .55rem; font-weight: 720; letter-spacing: .12em; text-transform: uppercase; }
  .invite-key-warning { margin-top: .85rem; border-left: 2px solid #d9d68e; background: #17180f; padding: .65rem .75rem; color: #c2c398; font-size: .7rem; line-height: 1.55; }
  .choice { border: 1px solid #34433b; padding: .7rem .8rem; font-size: .875rem; color: #b9cbbf; background: #0b0e0d; }
  .choice.active, .choice:hover { border-color: #7cf59d; background: #112219; color: #dfffe7; }
  .primary-button { border: 1px solid #7cf59d; background: #7cf59d; padding: .75rem 1rem; color: #0a120d; font-weight: 650; transition: .15s ease; }
  .primary-button:hover { background: #c5ffcf; border-color: #c5ffcf; }
  .primary-button:disabled { cursor: not-allowed; opacity: .5; }
  .secondary-button { border: 1px solid #4a6553; padding: .75rem 1rem; color: #c7ead0; }
  .secondary-button:hover { border-color: #7cf59d; }
  .connection-banner { flex: 0 0 auto; border-bottom: 1px solid #293832; background: #111814; padding: .65rem 1rem; color: #a9bbb0; font-size: .7rem; line-height: 1.5; }
  .connection-banner.offline { border-bottom-color: #604326; background: #21170f; color: #ffc17d; }
  .connection-banner.deleted { border-bottom-color: #6f3633; background: #21100f; color: #ffaaa3; }
  .reconnect-panel { display: grid; flex: 0 0 auto; gap: .7rem; border-bottom: 1px solid #35443c; background: #0c120f; padding: .85rem 1rem; }
  .reconnect-panel strong, .reconnect-panel span { display: block; }
  .reconnect-panel strong { color: #dfffe7; font-size: .75rem; }
  .reconnect-panel span { margin-top: .25rem; color: #82958a; font-size: .65rem; line-height: 1.45; }
  .reconnect-actions { display: flex; flex-wrap: wrap; gap: .45rem; }
  .reconnect-remote { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: .45rem; }
  .remote-resume-qr { display: flex; width: fit-content; flex-direction: column; gap: .35rem; border: 1px solid #293832; padding: .5rem; color: #bff6cc; font-size: .62rem; }
  .remote-resume-qr img { width: 8rem; height: 8rem; }
  .composer-status { margin-top: .5rem; color: #7ca087; text-align: center; font-size: .65rem; }
  .composer-status.unavailable { color: #a98b69; }
  .chat-composer { position: relative; }
  .composer-row, .emoji-shortcuts { display: flex; gap: .5rem; }
  .emoji-shortcuts { margin-bottom: .5rem; gap: .25rem; overflow-x: auto; padding-bottom: .25rem; }
  .emoji-button { flex: 0 0 auto; border: 1px solid #293832; background: #0b0e0d; padding: .2rem .4rem; font-size: .9rem; line-height: 1; }
  .emoji-button:hover { border-color: #7cf59d; background: #112219; }
  .emoji-button:disabled { cursor: not-allowed; opacity: .28; }
  .room-pane { position: relative; }
  @media (max-width: 900px) {
    .chat-page { position: fixed; inset: 0; width: 100%; height: var(--app-visual-height, 100dvh); max-height: var(--app-visual-height, 100dvh); overscroll-behavior: contain; }
    .chat-page.embedded { position: static; inset: auto; height: 100%; max-height: 100%; }
    .chat-global-nav { position: relative; z-index: 60; display: flex; min-height: 3.25rem; align-items: center; gap: .35rem; padding: max(.35rem, env(safe-area-inset-top)) .45rem .35rem; }
    .chat-workspace-nav { min-width: 0; overflow: visible; }
    .chat-workspace-nav, .chat-workspace-nav :global(.workspace-nav) { width: 100%; }
    .chat-workspace-nav :global(.workspace-nav) { gap: .35rem; }
    .chat-workspace-nav :global(.active-context) { flex: 1 1 auto; overflow: hidden; }
    .chat-workspace-nav :global(.context-copy) { min-width: 0; overflow: hidden; }
    .chat-workspace-nav :global(.context-copy strong) { max-width: none; }
    .chat-workspace-nav :global(.room-utilities), .chat-workspace-nav :global(.remote-badge) { display: none; }
    .chat-workspace-nav :global(.browse-button) { min-width: 44px; height: 44px; justify-content: center; padding: .35rem; }
    .chat-workspace-nav :global(.browse-label) { display: none; }
    .mobile-primary-actions { display: flex; flex: 0 0 auto; align-items: center; gap: .15rem; }
    .mobile-primary-actions > * { width: 44px; height: 44px; flex: 0 0 auto; }
    .mobile-connection { display: grid; place-items: center; border: 1px solid transparent; }
    .mobile-connection > span { width: .5rem; height: .5rem; border-radius: 999px; background: #7cf59d; box-shadow: 0 0 7px rgb(124 245 157 / .3); }
    .mobile-connection.offline > span { background: #f4a85f; box-shadow: 0 0 7px rgb(244 168 95 / .22); }
    .mobile-connection.deleted > span { border-radius: 1px; background: #dc6f66; box-shadow: none; }
    .mobile-connection.cached > span { background: #718277; box-shadow: none; }
    .mobile-connection.connecting > span { background: #e4e78d; animation: mobile-connection-pulse 1.4s ease-in-out infinite; }
    .mobile-sound-toggle { display: grid; place-items: center; border: 1px solid transparent; color: #718277; }
    .mobile-sound-toggle:hover, .mobile-sound-toggle:focus-visible { border-color: #34483a; background: #111a14; color: #dfffe7; outline: none; }
    .mobile-sound-toggle.enabled { color: #9bcfa7; }
    .mobile-sound-toggle svg { width: 1rem; height: 1rem; overflow: visible; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
    .mobile-sound-toggle svg path:first-child { fill: currentColor; stroke: none; }
    .chat-workspace-nav :global(.room-switcher) { top: calc(max(.35rem, env(safe-area-inset-top)) + 2.9rem); max-height: calc(100dvh - 3.5rem); }
    .connection-banner { padding: .45rem .65rem; font-size: .62rem; }
    .reconnect-panel { max-height: min(10rem, 28dvh); gap: .45rem; overflow-y: auto; padding: .55rem .65rem; overscroll-behavior: contain; }
    .reconnect-panel span { margin-top: .15rem; font-size: .58rem; line-height: 1.35; }
    .reconnect-actions { gap: .3rem; }
    .reconnect-panel .secondary-button { padding: .5rem .65rem; font-size: .62rem; }
    .reconnect-remote { grid-template-columns: minmax(0, 1fr); }
    .reconnect-remote .guest-input { padding: .55rem .65rem; }
    .remote-resume-qr { flex-direction: row; align-items: center; }
    .remote-resume-qr img { width: 5.5rem; height: 5.5rem; }
    [data-testid="guest-message-list"] { min-block-size: 6rem; padding: .75rem .65rem; overscroll-behavior: contain; }
    .chat-composer { padding: .45rem .55rem max(.45rem, env(safe-area-inset-bottom)); }
    .composer-row { gap: .35rem; }
    .composer-row .guest-input { padding: .58rem .65rem; }
    .composer-row .primary-button { padding: .58rem .72rem; }
    .emoji-button { min-width: 44px; min-height: 44px; padding: .3rem .45rem; }
    .composer-status { margin-top: .35rem; font-size: .58rem; }
    .composer-status:not(.unavailable) { display: none; }
  }

  @media (max-width: 520px) {
    .chat-workspace-nav :global(.brand) { display: none; }
    .chat-workspace-nav :global(.active-context) { border-left: 0; padding-left: 0; }
  }

  @media (max-width: 360px) {
    .chat-workspace-nav :global(.active-context > .room-host-badge) { display: none; }
    .chat-workspace-nav :global(.context-copy > span) { display: none; }
    .mobile-primary-actions { gap: 0; }
  }

  @media (max-width: 900px) and (max-height: 520px) {
    .chat-global-nav { min-height: 2.75rem; padding-top: max(.2rem, env(safe-area-inset-top)); padding-bottom: .2rem; }
    .chat-workspace-nav :global(.brand-copy span), .chat-workspace-nav :global(.context-copy > span) { display: none; }
    .chat-workspace-nav :global(.browse-button), .mobile-primary-actions > * { height: 44px; }
    .chat-workspace-nav :global(.room-switcher) { top: calc(max(.2rem, env(safe-area-inset-top)) + 2.55rem); max-height: calc(100dvh - 2.8rem); }
    .reconnect-panel { max-height: min(7rem, 24dvh); }
    [data-testid="guest-message-list"] { min-block-size: 4.5rem; padding-block: .5rem; }
    .chat-composer { padding-block: .35rem; }
  }

  @keyframes mobile-connection-pulse { 50% { opacity: .35; } }
</style>
