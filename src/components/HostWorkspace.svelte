<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { generate } from "lean-qr";
  import { toSvgDataURL } from "lean-qr/extras/svg";
  import type { CoordinatorIdentity } from "../crypto/key-manager";
  import type { CoordinatorStore } from "../coordinator/coordinator.svelte";
  import type { HostedRoomRecoveryAdapter, HostedRoomRecoveryTarget } from "../coordinator/types";
  import type { ConfigStore } from "../config/config.svelte";
  import { createInviteUrl, normalizeRoomHostIdentity, parseInviteUrl } from "../chat/invite";
  import type { ChatPaneContext } from "../chat/chat-pane-context";
  import { createSameShellAutoJoinHref, createSameShellChatHref } from "../chat/room-navigation";
  import { ChatRoomSession, coordinatorUnreadTotal, createHostedRoom, hostIdentityForRoom, listRooms, loadLastOpenRoom, loadRoom, reactionSummary, rememberActiveHostRoom, rememberLastOpenRoom, removeStoredRoom, roomIdentityKey, roomUnreadCount, ROOMS_CHANGED_EVENT, rotateRoomInvite, sameRoomIdentity, saveRoom, SERVER_OFFLINE_EVENT, SERVER_ONLINE_EVENT, type RoomIdentity, type StoredRoom } from "../chat/room-store";
  import { emptySidebarLedger, parseSidebarLedger, reconcileSidebarLedger, serializeSidebarLedger, SIDEBAR_LEDGER_KEY, type SidebarHistoryEntry, type SidebarLedger } from "../chat/sidebar-ledger";
  import { CHAT_EMOJI_SHORTCUTS, type ChatEmojiShortcut } from "../chat/protocol";
  import { groupMessageStreaks } from "../chat/message-presentation";
  import {
    type ChatCoordinatorClientFactory,
    type RemoteJoinRequest,
  } from "../chat/coordinator-client";
  import { SimplePoolNostrInstanceNetwork } from "../coordinator/single-instance-guard";
  import CoordinatorSettings from "./CoordinatorSettings.svelte";
  import CoordinatorRoomCard from "./CoordinatorRoomCard.svelte";
  import ChannelPreferenceIndicators from "./ChannelPreferenceIndicators.svelte";
  import CoordinatorSetup from "./CoordinatorSetup.svelte";
  import type { CoordinatorSetupSubmission } from "./coordinator-setup";
  import ChatRoute from "./ChatRoute.svelte";
  import PassphrasePrompt from "./PassphrasePrompt.svelte";
  import LifecyclePanel from "./LifecyclePanel.svelte";
  import MessageGroup from "./MessageGroup.svelte";
  import NotificationCenter from "./NotificationCenter.svelte";
  import NotificationFeed from "./NotificationFeed.svelte";
  import InviteRedeemer from "./InviteRedeemer.svelte";
  import OnlineInvitePicker from "./OnlineInvitePicker.svelte";
  import PendingInvitees from "./PendingInvitees.svelte";
  import PresenceControl from "./PresenceControl.svelte";
  import RoomHostBadge from "./RoomHostBadge.svelte";
  import RoomActionsMenu from "./RoomActionsMenu.svelte";
  import RoomRemovalDialog from "./RoomRemovalDialog.svelte";
  import SidebarHistory from "./SidebarHistory.svelte";
  import StartupSignalField from "./StartupSignalField.svelte";
  import StartupProgressMeter from "./StartupProgressMeter.svelte";
  import { projectStartupSignal } from "./startup-signal-presentation";
  import UserProfile from "./UserProfile.svelte";
  import WorkspaceNav from "./WorkspaceNav.svelte";
  import { userProfileStore } from "../identity/user-profile.svelte";
  import { channelPreferences } from "../notifications/channel-preferences.svelte";

  interface Props {
    coordinator: CoordinatorStore;
    config: ConfigStore;
    identity: CoordinatorIdentity;
    coordinatorPubkey: string;
    relayUrls: string[];
    currentUrl: string;
    homeCoordinatorPubkey?: string;
    identityReady: boolean;
    locked?: boolean;
    onNavigate: (href: string) => void;
  }

  interface HostedRoomEntry {
    room: StoredRoom;
    inviteUrl: string;
    qrUrl: string;
  }

  interface RemoteServerGroup {
    pubkey: string;
    origin?: string;
    rooms: StoredRoom[];
  }

  type CoordinatorReachability = "online" | "connecting" | "offline" | "unknown";

  let { coordinator, config, identity, coordinatorPubkey, relayUrls, currentUrl, homeCoordinatorPubkey, identityReady, locked = false, onNavigate }: Props = $props();
  let title = $state("");
  let inviteUrl = $state("");
  let qrUrl = $state("");
  let error = $state("");
  let busy = $state(false);
  let autoApprove = $state(true);
  let room = $state<StoredRoom | null>(null);
  let session = $state<ChatRoomSession | null>(null);
  let hostedRooms = $state<HostedRoomEntry[]>([]);
  let homeJoinedRooms = $state<StoredRoom[]>([]);
  let remoteRooms = $state<StoredRoom[]>([]);
  let previousLocalRooms = $state<StoredRoom[]>([]);
  let sidebarLedger = $state<SidebarLedger>(emptySidebarLedger());
  let sidebarHistory = $state<SidebarHistoryEntry[]>([]);
  let composer = $state("");
  let revision = $state(0);
  let roomConnection = $state<"connecting" | "connected" | "offline">("connecting");
  let roomConnectionDetail = $state<string | undefined>();
  let messageList: HTMLDivElement | undefined = $state();
  let composerInput: HTMLInputElement | undefined = $state();
  let audioContext: AudioContext | null = null;
  let knownMessageIds = new Set<string>();
  let inviteDialogOpen = $state(false);
  let inviteQrExpanded = $state(false);
  let createDialogOpen = $state(false);
  let settingsDialogOpen = $state(false);
  let newRoomAutoApprove = $state(true);
  let serverMenuOpen = $state(false);
  let selectedServerPubkey = $state("");
  let copyState = $state<"idle" | "copied">("idle");
  let detailCopyState = $state<"idle" | "coordinator">("idle");
  let unsubscribeSession: (() => void) | null = null;
  let unregisterAnonymousSession: (() => void) | null = null;
  let roomNameInput: HTMLInputElement | undefined = $state();
  let pendingJoinRequests = $state<RemoteJoinRequest[]>([]);
  let admissionError = $state<string | null>(null);
  let managementOpen = $state(false);
  let compactViewport = $state(false);
  let mobileRailOpen = $state(false);
  let mobileToolsOpen = $state(false);
  let mobileToolsTrigger = $state<HTMLButtonElement>();
  let refreshState = $state<"idle" | "refreshing" | "refreshed">("idle");
  let roomRemovalTarget = $state<StoredRoom | null>(null);
  let roomRemovalMode = $state<"delete" | "leave">("delete");
  let roomRemovalOrigin = $state<HTMLButtonElement | null>(null);
  let reactionPickerMessageId = $state<string | null>(null);
  let reactionError = $state("");
  let embeddedChatContext = $state<ChatPaneContext | null>(null);
  let remoteCoordinatorReachability = $state<Record<string, CoordinatorReachability>>({});
  let reachabilityProbeGeneration = 0;
  let reachabilityTimer: number | null = null;
  let reachabilityTargetsSignature = "";
  let unregisterHostedRoomRecovery: (() => void) | null = null;
  let pendingRecoverySession: ChatRoomSession | null = null;
  const hostedRoomSessions = new SvelteMap<string, ChatRoomSession>();
  let preferredRecoveryRoomIdentityKey: string | null = null;
  let preferredRecoveryRoomOpened = false;
  let browserOnline = $state(typeof navigator === "undefined" ? true : navigator.onLine);
  let lastSyncedRouteContext = "";
  let unreadAnnouncement = $state("");
  let autostartAttempted = false;
  let setupWasCompleteOnMount = $state(false);
  const reachabilityProbe = new SimplePoolNostrInstanceNetwork(1_500);
  const dialogOpen = $derived(inviteDialogOpen || createDialogOpen || roomRemovalTarget !== null);
  const remoteServers = $derived.by(() => {
    const groups: Record<string, RemoteServerGroup> = {};
    for (const storedRoom of remoteRooms) {
      const group = groups[storedRoom.coordinatorPubkey];
      if (group) {
        group.rooms.push(storedRoom);
      } else {
        groups[storedRoom.coordinatorPubkey] = {
          pubkey: storedRoom.coordinatorPubkey,
          origin: storedRoom.coordinatorOrigin,
          rooms: [storedRoom],
        };
      }
    }
    return Object.values(groups);
  });
  const previousLocalServers = $derived.by(() => {
    const groups: Record<string, RemoteServerGroup> = {};
    for (const storedRoom of previousLocalRooms) {
      const group = groups[storedRoom.coordinatorPubkey];
      if (group) {
        group.rooms.push(storedRoom);
      } else {
        groups[storedRoom.coordinatorPubkey] = {
          pubkey: storedRoom.coordinatorPubkey,
          origin: storedRoom.coordinatorOrigin,
          rooms: [storedRoom],
        };
      }
    }
    return Object.values(groups);
  });
  const selectedRemoteServer = $derived(remoteServers.find((server) => server.pubkey === selectedServerPubkey));
  const selectedPreviousLocalServer = $derived(previousLocalServers.find((server) => server.pubkey === selectedServerPubkey));
  const selectedExternalServer = $derived(selectedRemoteServer ?? selectedPreviousLocalServer);
  const selectedServerIsHome = $derived(!selectedServerPubkey || selectedServerPubkey === coordinatorPubkey);
  const selectedServerIsPreviousLocal = $derived(!selectedServerIsHome && selectedPreviousLocalServer !== undefined);
  const selectedServerName = $derived(selectedServerIsHome
    ? config.coordinatorName || "My coordinator"
    : selectedServerIsPreviousLocal
      ? `Previous local ${shortKey(selectedServerPubkey)}`
      : `Coordinator ${shortKey(selectedServerPubkey || coordinatorPubkey)}`
  );
  const selectedServerRoomCount = $derived(selectedServerIsHome
    ? hostedRooms.length + homeJoinedRooms.length
    : selectedRemoteServer?.rooms.length
      ?? selectedPreviousLocalServer?.rooms.length
      ?? (activeIntentInvite?.coordinatorPubkey === selectedServerPubkey ? 1 : 0)
  );
  const firstSavedExternalCoordinatorPubkey = $derived(
    remoteServers[0]?.pubkey ?? previousLocalServers[0]?.pubkey,
  );
  const hasAnySavedRooms = $derived(
    hostedRooms.length + homeJoinedRooms.length + remoteRooms.length + previousLocalRooms.length + sidebarHistory.length > 0,
  );
  const activeIntentInvite = $derived(parseInviteUrl(currentUrl));
  const activeIntentHost = $derived(activeIntentInvite?.host
    ? { ...activeIntentInvite.host, avatar: undefined }
    : undefined);
  const hasChatIntent = $derived(new URL(currentUrl).pathname.startsWith("/chat/"));
  const intentStoredRoom = $derived.by(() => {
    if (revision < 0 || !activeIntentInvite) return null;
    return loadRoom(activeIntentInvite.groupId, activeIntentInvite.coordinatorPubkey);
  });
  const intentTargetsCurrentHostedRoom = $derived(Boolean(
    intentStoredRoom?.isHost && intentStoredRoom.coordinatorPubkey === coordinatorPubkey,
  ));
  const embeddedChatActive = $derived(hasChatIntent && !intentTargetsCurrentHostedRoom);
  const activeSidebarRoomKey = $derived(roomIdentityKey(
    embeddedChatActive ? activeIntentInvite?.coordinatorPubkey ?? "" : room?.coordinatorPubkey ?? "",
    embeddedChatActive ? activeIntentInvite?.groupId ?? "" : room?.id ?? "",
  ));
  const setupState = $derived<"checking" | "identity">(
    !identityReady ? "checking" : "identity",
  );
  // First-run setup gates operating this browser's coordinator, never accepting
  // an invite to somebody else's coordinator.
  const setupRequired = $derived(!embeddedChatActive && (!identityReady || !config.isSetupComplete));
  const guidedSetupMode = $derived(
    !setupRequired
      && !locked
      && !embeddedChatActive
      && selectedServerIsHome
      && selectedServerRoomCount === 0
      && (coordinator.status === "running" || !hasAnySavedRooms),
  );
  const localRoomReady = $derived(
    coordinator.status === "running"
      && coordinator.startupProgress.roomRecovery.state === "complete"
      && room !== null
      && session !== null
      && roomConnection === "connected"
  );
  const localRailBusy = $derived(
    selectedServerIsHome
      && (
        coordinator.status === "starting"
          || coordinator.status === "stopping"
          || (
            coordinator.status === "running"
              && coordinator.startupProgress.roomRecovery.state !== "complete"
          )
      )
  );
  const localRailActionable = $derived(
    !selectedServerIsHome
      || (
        !locked
          && coordinator.status === "running"
          && coordinator.startupProgress.roomRecovery.state === "complete"
      )
  );
  const localRailUnavailable = $derived(selectedServerIsHome && !localRailActionable);
  const localRailState = $derived(
    localRailBusy ? "loading" : localRailUnavailable ? "unavailable" : "ready"
  );
  const localRailStatusLabel = $derived.by(() => {
    if (locked) return "Coordinator locked";
    if (coordinator.status === "stopping") return "Stopping coordinator…";
    if (
      coordinator.startupProgress.roomRecovery.state === "restoring"
        || coordinator.startupProgress.roomRecovery.state === "retrying"
    ) return "Restoring rooms…";
    if (coordinator.status === "starting") return "Starting coordinator…";
    if (coordinator.status === "running") return "Preparing rooms…";
    return "Coordinator offline";
  });
  const startupSignal = $derived(projectStartupSignal(coordinator.startupProgress, coordinator.status));
  const startupPanelPercent = $derived(
    coordinator.startupProgress.phase === "restoring-rooms"
      ? coordinator.startupProgress.roomRecovery.total === 0
        ? 100
        : Math.round((coordinator.startupProgress.roomRecovery.completed / coordinator.startupProgress.roomRecovery.total) * 100)
      : coordinator.startupProgress.percent,
  );
  const localCoordinatorStatus = $derived<CoordinatorReachability>(
    !browserOnline
      ? "offline"
      : coordinator.status === "running"
      ? "online"
      : coordinator.status === "starting" || coordinator.status === "stopping"
        ? "connecting"
        : "offline"
  );
  const localCoordinatorStatusLabel = $derived.by(() => {
    if (localCoordinatorStatus === "online") return "Coordinator online";
    if (coordinator.status === "starting") return "Coordinator starting";
    if (coordinator.status === "stopping") return "Coordinator stopping";
    return "Coordinator offline";
  });
  const exhaustedRecoveryRoom = $derived.by(() => {
    const target = coordinator.exhaustedRoomRecoveryTarget;
    return target ? loadRoom(target.roomId, target.coordinatorPubkey) : null;
  });

  $effect(() => {
    if (revision >= 0) void tick().then(() => messageList?.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" }));
  });

  $effect(() => {
    if (coordinator.status === "starting" || coordinator.status === "running") return;
    for (const hostedSession of hostedRoomSessions.values()) hostedSession.stop();
    hostedRoomSessions.clear();
  });

  $effect(() => {
    if (autostartAttempted || !setupWasCompleteOnMount || locked || !identityReady || !config.isSetupComplete) return;
    if (!config.autostart || config.presenceState === "offline" || coordinator.status !== "idle") return;
    autostartAttempted = true;
    void coordinator.start();
  });

  $effect(() => {
    const coordinatorTarget = embeddedChatActive ? activeIntentInvite?.coordinatorPubkey : undefined;
    const routeContext = embeddedChatActive
      ? `remote:${coordinatorTarget ?? ""}:${activeIntentInvite?.groupId ?? ""}`
      : "local";
    if (routeContext !== lastSyncedRouteContext) {
      lastSyncedRouteContext = routeContext;
      selectedServerPubkey = coordinatorTarget ?? coordinatorPubkey;
      probeRemoteCoordinatorsIfTargetsChanged();
    }
    if (!embeddedChatActive && embeddedChatContext) embeddedChatContext = null;
  });

  $effect(() => {
    const activeSession = session;
    const activeRoom = room;
    const identity = currentHostIdentity();
    if (!activeSession || !activeRoom?.isHost) return;
    if (activeRoom.name === identity.name
      && activeRoom.avatar === identity.avatar
      && activeRoom.badgeLabel === identity.badgeLabel
      && activeRoom.badgeEmoji === identity.badgeEmoji) return;

    activeSession.setIdentity(identity);
    const refreshedEntry = buildHostedRoomEntry(activeSession.room);
    hostedRooms = hostedRooms.map((entry) => sameRoomIdentity(entry.room, activeSession.room) ? refreshedEntry : entry);
    inviteUrl = refreshedEntry.inviteUrl;
    qrUrl = refreshedEntry.qrUrl;
  });

  $effect(() => {
    const identity = currentHostIdentity();
    const activeRoom = room;
    let changed = false;
    const nextEntries = hostedRooms.map((entry) => {
      if ((activeRoom && sameRoomIdentity(entry.room, activeRoom)) || roomIdentityMatches(entry.room, identity)) return entry;
      const updatedRoom: StoredRoom = {
        ...entry.room,
        name: identity.name,
        avatar: identity.avatar,
        badgeLabel: identity.badgeLabel,
        badgeEmoji: identity.badgeEmoji,
        host: normalizeRoomHostIdentity({
          name: identity.name,
          pubkey: entry.room.stablePubkey,
          avatar: identity.avatar,
        }),
      };
      saveRoom(updatedRoom);
      changed = true;
      return buildHostedRoomEntry(updatedRoom);
    });
    if (changed) hostedRooms = nextEntries;
  });

  function roomIdentityMatches(nextRoom: StoredRoom, identity: RoomIdentity): boolean {
    return nextRoom.name === identity.name
      && nextRoom.avatar === identity.avatar
      && nextRoom.badgeLabel === identity.badgeLabel
      && nextRoom.badgeEmoji === identity.badgeEmoji;
  }

  function update() {
    if (session) {
      roomConnection = session.status.connection;
      roomConnectionDetail = session.status.detail;
      const nextRoom = { ...session.room, messages: [...session.room.messages], pending: [...session.room.pending], reactions: [...(session.room.reactions ?? [])] };
      const receivedMessage = nextRoom.messages.some((message) => !knownMessageIds.has(message.id) && message.sender !== nextRoom.stablePubkey);
      knownMessageIds = new Set(nextRoom.messages.map((message) => message.id));
      room = nextRoom;
      pendingJoinRequests = [...session.pendingJoinRequests];
      admissionError = session.admissionError;
      hostedRooms = hostedRooms.map((entry) => sameRoomIdentity(entry.room, nextRoom) ? { ...entry, room: nextRoom } : entry);
      if (receivedMessage) playIncomingTone();
      acknowledgeVisibleHostRoom();
    }
    revision += 1;
  }

  function displayUnreadCount(count: number): string {
    return count >= 100 ? "99+" : String(count);
  }

  function coordinatorUnreadCount(pubkey: string): number {
    return coordinatorUnreadTotal(listRooms(), pubkey);
  }

  function acknowledgeVisibleHostRoom(): void {
    if (document.visibilityState !== "visible" || roomConnection !== "connected") return;
    const activeRoom = room;
    const activeSession = session;
    if (!activeRoom || !activeSession || !sameRoomIdentity(activeSession.room, activeRoom)) return;
    if (roomUnreadCount(activeSession.room) > 0) activeSession.markRead();
  }

  const createHostRoomClient: ChatCoordinatorClientFactory = (target) => {
    const client = coordinator.createHostedRoomClient(target);
    if (!client) throw new Error("The local coordinator is not ready for hosted room access");
    return client;
  };

  function activeSignerForRoom(nextRoom: StoredRoom): Parameters<ChatCoordinatorClientFactory>[1] {
    const signer = userProfileStore.activeSigner;
    if (!signer) throw new Error("The host chat signer is unavailable");
    if (nextRoom.membershipStatus === "retired") throw new Error("This room identity has been retired");
    if (!userProfileStore.pubkey || userProfileStore.pubkey !== nextRoom.stablePubkey) {
      throw new Error("The active identity does not own this room");
    }
    return signer;
  }

  function createHostRoomSession(nextRoom: StoredRoom, signer: Parameters<ChatCoordinatorClientFactory>[1]): ChatRoomSession {
    return new ChatRoomSession(nextRoom, signer, createHostRoomClient);
  }

  async function openHostChat(nextRoom: StoredRoom, recoveredSession: ChatRoomSession | undefined = undefined): Promise<void> {
    const signer = activeSignerForRoom(nextRoom);
    const key = roomIdentityKey(nextRoom.coordinatorPubkey, nextRoom.id);
    const existingSession = hostedRoomSessions.get(key);
    const attachedSession = recoveredSession ?? existingSession ?? createHostRoomSession(nextRoom, signer);
    unsubscribeSession?.();
    unregisterAnonymousSession?.();
    unregisterAnonymousSession = null;
    knownMessageIds = new Set(nextRoom.messages.map((message) => message.id));
    room = nextRoom;
    pendingJoinRequests = [];
    session = attachedSession;
    hostedRoomSessions.set(key, attachedSession);
    roomConnection = attachedSession.status.connection;
    roomConnectionDetail = attachedSession.status.detail;
    unsubscribeSession = attachedSession.subscribe(update);
    if (recoveredSession) {
      attachedSession.activateSteadyState();
    } else if (!existingSession && coordinator.status === "running") {
      await attachedSession.start();
    }
    if (userProfileStore.method === "anonymous" && userProfileStore.activeSigner === signer) {
      unregisterAnonymousSession = userProfileStore.registerAnonymousSession({
        stablePubkey: nextRoom.stablePubkey,
        retire: () => {
          if (session !== attachedSession) return;
          unsubscribeSession?.();
          unsubscribeSession = null;
          attachedSession.discard();
          session = null;
          roomConnection = "connecting";
          roomConnectionDetail = "Local identity was retired";
          update();
        },
        restore: async () => {
          const restored = loadRoom(nextRoom.id, nextRoom.coordinatorPubkey);
          const activeSigner = userProfileStore.activeSigner;
          if (!restored || userProfileStore.method !== "anonymous" || !activeSigner) return;
          await openHostChat(restored);
        },
      });
    }
    autoApprove = nextRoom.autoApprove !== false;
    rememberActiveHostRoom(nextRoom);
    update();
  }

  function hostedRoomRecoveryAdapter(): HostedRoomRecoveryAdapter {
    return {
      listTargets: () => {
        const activeCoordinatorPubkey = coordinator.identity.publicKeyHex;
        const rememberedRoom = loadLastOpenRoom(activeCoordinatorPubkey);
        preferredRecoveryRoomIdentityKey = rememberedRoom
          ? roomIdentityKey(rememberedRoom.coordinatorPubkey, rememberedRoom.id)
          : null;
        preferredRecoveryRoomOpened = false;
        return listRooms()
          .filter((storedRoom) => storedRoom.isHost && storedRoom.coordinatorPubkey === activeCoordinatorPubkey)
          .map((storedRoom): HostedRoomRecoveryTarget => ({
          coordinatorPubkey: storedRoom.coordinatorPubkey,
          roomId: storedRoom.id,
          roomName: storedRoom.title,
          roomIdentityKey: roomIdentityKey(storedRoom.coordinatorPubkey, storedRoom.id),
          }));
      },
      recover: async (target, signal) => {
        if (signal.aborted) throw new DOMException("Recovery cancelled", "AbortError");
        const latest = loadRoom(target.roomId, target.coordinatorPubkey);
        const signer = userProfileStore.activeSigner;
        if (!latest || !latest.isHost || latest.coordinatorPubkey !== coordinator.identity.publicKeyHex || !signer) {
          throw new Error("Hosted room recovery is unavailable");
        }
        activeSignerForRoom(latest);
        if (signal.aborted) throw new DOMException("Recovery cancelled", "AbortError");
        pendingRecoverySession?.discard();
        const candidate = createHostRoomSession(latest, signer);
        pendingRecoverySession = candidate;
        await candidate.recover(signal);
        if (signal.aborted || candidate.status.connection !== "connected") {
          candidate.discard();
          if (pendingRecoverySession === candidate) pendingRecoverySession = null;
          throw new Error("Hosted room recovery is unavailable");
        }
        const key = roomIdentityKey(latest.coordinatorPubkey, latest.id);
        hostedRoomSessions.get(key)?.stop();
        hostedRoomSessions.set(key, candidate);
        candidate.activateSteadyState();
        const targetIsPreferred = preferredRecoveryRoomIdentityKey === target.roomIdentityKey;
        if (!preferredRecoveryRoomOpened || targetIsPreferred) {
          await openHostChat(latest, candidate);
          if (targetIsPreferred) preferredRecoveryRoomOpened = true;
        } else {
          // Keep every hosted room's admission worker alive. Cordn clients can
          // request access to a room that is not currently selected in the UI.
        }
        if (pendingRecoverySession === candidate) pendingRecoverySession = null;
        const entry = buildHostedRoomEntry(latest);
        inviteUrl = entry.inviteUrl;
        qrUrl = entry.qrUrl;
      },
      discard: () => {
        pendingRecoverySession?.discard();
        pendingRecoverySession = null;
      },
    };
  }

  // Register before the first rendered Start control can be activated. Waiting
  // for onMount allowed a fast click to begin startup without any room targets.
  // svelte-ignore state_referenced_locally
  unregisterHostedRoomRecovery = coordinator.registerHostedRoomRecovery(hostedRoomRecoveryAdapter());

  function buildHostedRoomEntry(nextRoom: StoredRoom): HostedRoomEntry {
    const coordinatorKeyMode = coordinator.persistenceEnabled ? "persistent" : "ephemeral";
    const relayHintsChanged = nextRoom.relayUrls.length !== relayUrls.length
      || nextRoom.relayUrls.some((relayUrl, index) => relayUrl !== relayUrls[index]);
    const coordinatorName = config.coordinatorName || "My coordinator";
    if (nextRoom.coordinatorKeyMode !== coordinatorKeyMode || relayHintsChanged || nextRoom.coordinatorName !== coordinatorName) {
      nextRoom = { ...nextRoom, coordinatorKeyMode, coordinatorName, relayUrls: [...relayUrls] };
      saveRoom(nextRoom);
    }
    const createdInviteUrl = createInviteUrl(window.location.origin, {
      groupId: nextRoom.id,
      coordinatorPubkey: nextRoom.coordinatorPubkey,
      relayUrls: nextRoom.relayUrls,
      title: nextRoom.title,
      inviteToken: nextRoom.inviteToken,
      host: hostIdentityForRoom(nextRoom),
      coordinatorKeyMode,
      coordinatorName,
    });
    return {
      room: nextRoom,
      inviteUrl: createdInviteUrl,
      qrUrl: toSvgDataURL(generate(createdInviteUrl), { on: "#c8ffdc", off: "#101614", pad: 2, scale: 4 }),
    };
  }

  function currentHostIdentity() {
    return {
      name: userProfileStore.displayName,
      avatar: userProfileStore.avatarUrl,
      badgeLabel: config.hostBadgeLabel.trim() || "host",
      badgeEmoji: config.hostBadgeEmoji,
    };
  }

  function remoteRoomHref(nextRoom: StoredRoom): string {
    return createSameShellChatHref(window.location.origin, nextRoom);
  }

  function shortKey(pubkey: string): string {
    return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`;
  }

  function serverHost(origin: string | undefined): string {
    if (!origin) return "Remote coordinator";
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  }

  function reachabilityTargets(): Array<{ pubkey: string; relayUrls: string[] }> {
    const targets: Record<string, string[]> = {};
    const addRoom = (storedRoom: StoredRoom) => {
      if (!storedRoom.coordinatorPubkey || storedRoom.coordinatorPubkey === coordinatorPubkey) return;
      const relays = targets[storedRoom.coordinatorPubkey] ?? [];
      for (const relayUrl of storedRoom.relayUrls) {
        if (!relays.includes(relayUrl)) relays.push(relayUrl);
      }
      targets[storedRoom.coordinatorPubkey] = relays;
    };

    for (const storedRoom of remoteRooms) addRoom(storedRoom);
    for (const storedRoom of previousLocalRooms) addRoom(storedRoom);
    if (activeIntentInvite && activeIntentInvite.coordinatorPubkey !== coordinatorPubkey) {
      const relays = targets[activeIntentInvite.coordinatorPubkey] ?? [];
      for (const relayUrl of activeIntentInvite.relayUrls) {
        if (!relays.includes(relayUrl)) relays.push(relayUrl);
      }
      targets[activeIntentInvite.coordinatorPubkey] = relays;
    }

    return Object.entries(targets).map(([pubkey, relayUrls]) => ({ pubkey, relayUrls }));
  }

  function reachabilitySignature(targets = reachabilityTargets()): string {
    return targets
      .map((target) => `${target.pubkey}:${[...target.relayUrls].sort().join(",")}`)
      .sort()
      .join("|");
  }

  function probeRemoteCoordinatorsIfTargetsChanged(): void {
    const targets = reachabilityTargets();
    const signature = reachabilitySignature(targets);
    if (signature === reachabilityTargetsSignature) return;
    reachabilityTargetsSignature = signature;
    void probeRemoteCoordinators(targets);
  }

  function externalCoordinatorReachability(pubkey: string): CoordinatorReachability {
    const measured = remoteCoordinatorReachability[pubkey];
    if (embeddedChatActive && activeIntentInvite?.coordinatorPubkey === pubkey) {
      const connection = embeddedChatContext?.connection;
      if (connection === "connected") return "online";
      if (measured) return measured;
      if (connection === "connecting") return "connecting";
      if (connection === "offline" || connection === "deleted") return "offline";
    }
    return measured ?? "unknown";
  }

  function reachabilityLabel(state: CoordinatorReachability): string {
    if (state === "online") return "Coordinator online";
    if (state === "connecting") return "Checking coordinator reachability";
    if (state === "offline") return "Coordinator offline";
    return "Coordinator status unknown";
  }

  function setExternalCoordinatorReachability(pubkey: string, state: CoordinatorReachability): void {
    if (!pubkey || pubkey === coordinatorPubkey || remoteCoordinatorReachability[pubkey] === state) return;
    remoteCoordinatorReachability = { ...remoteCoordinatorReachability, [pubkey]: state };
  }

  function handleCoordinatorReachabilityEvent(event: Event, state: "online" | "offline"): void {
    const pubkey = (event as CustomEvent<{ coordinatorPubkey?: string }>).detail?.coordinatorPubkey;
    if (!pubkey) return;
    if (state === "online") {
      // A successful room sync is fresher evidence than an older heartbeat
      // request that may still be in flight.
      reachabilityProbeGeneration += 1;
      setExternalCoordinatorReachability(pubkey, "online");
      return;
    }
    // A room sync can fail while its coordinator remains reachable (for example,
    // after that room is deleted). Treat the failure as uncertainty and let the
    // coordinator heartbeat decide whether the server itself is offline.
    setExternalCoordinatorReachability(pubkey, "connecting");
    void probeRemoteCoordinators();
  }

  async function probeRemoteCoordinators(targets = reachabilityTargets()): Promise<void> {
    const generation = ++reachabilityProbeGeneration;
    const targetKeys = targets.map((target) => target.pubkey);
    const nextState: Record<string, CoordinatorReachability> = {};
    for (const target of targets) {
      nextState[target.pubkey] = remoteCoordinatorReachability[target.pubkey] ?? "connecting";
    }
    if (Object.keys(remoteCoordinatorReachability).some((pubkey) => !targetKeys.includes(pubkey))
      || targets.some((target) => remoteCoordinatorReachability[target.pubkey] === undefined)) {
      remoteCoordinatorReachability = nextState;
    }

    if (!navigator.onLine) {
      if (generation === reachabilityProbeGeneration) {
        remoteCoordinatorReachability = Object.fromEntries(targets.map((target) => [target.pubkey, "offline"]));
      }
      return;
    }

    const results = await Promise.all(targets.map(async (target) => ({
      pubkey: target.pubkey,
      online: await reachabilityProbe.isRunning(target.pubkey, target.relayUrls, []),
    })));
    if (generation !== reachabilityProbeGeneration) return;

    const previous = remoteCoordinatorReachability;
    const resolved: Record<string, CoordinatorReachability> = {};
    for (const result of results) resolved[result.pubkey] = result.online ? "online" : "offline";
    remoteCoordinatorReachability = resolved;
    for (const result of results) {
      if (result.online && previous[result.pubkey] === "offline") {
        window.dispatchEvent(new CustomEvent(SERVER_ONLINE_EVENT, {
          detail: { coordinatorPubkey: result.pubkey },
        }));
      }
    }
  }

  function refreshRemoteRooms() {
    const rooms = listRooms();
    let storedLedger: SidebarLedger;
    try {
      storedLedger = parseSidebarLedger(localStorage.getItem(SIDEBAR_LEDGER_KEY));
    } catch {
      storedLedger = sidebarLedger;
    }
    const projection = reconcileSidebarLedger(storedLedger, rooms, coordinatorPubkey, config.coordinatorName || "My coordinator");
    sidebarLedger = projection.ledger;
    sidebarHistory = projection.history;
    try {
      const ledgerHasContent = projection.ledger.coordinatorOrder.length > 0
        || projection.ledger.history.length > 0
        || Object.values(projection.ledger.roomOrder).some((order) => order.length > 0);
      if (ledgerHasContent) localStorage.setItem(SIDEBAR_LEDGER_KEY, serializeSidebarLedger(projection.ledger));
      else localStorage.removeItem(SIDEBAR_LEDGER_KEY);
    } catch { /* presentation order remains in memory */ }
    const activeRooms = projection.activeRooms;
    hostedRooms = activeRooms
      .filter((storedRoom) => storedRoom.isHost && storedRoom.coordinatorPubkey === coordinatorPubkey)
      .map(buildHostedRoomEntry);
    homeJoinedRooms = activeRooms.filter((storedRoom) =>
      storedRoom.coordinatorPubkey === coordinatorPubkey && !storedRoom.isHost
    );
    previousLocalRooms = [];
    remoteRooms = activeRooms.filter((storedRoom) =>
      !storedRoom.isHost && storedRoom.coordinatorPubkey !== coordinatorPubkey
    );
    probeRemoteCoordinatorsIfTargetsChanged();
  }

  function handleStoredRoomsChanged(event: Event): void {
    const detail = event instanceof CustomEvent
      ? event.detail as { action?: string; roomId?: string; coordinatorPubkey?: string }
      : undefined;
    const activeRoom = room;
    if (detail?.action === "removed"
      && activeRoom
      && detail.roomId === activeRoom.id
      && detail.coordinatorPubkey === activeRoom.coordinatorPubkey) {
      unsubscribeSession?.();
      unsubscribeSession = null;
      unregisterAnonymousSession?.();
      unregisterAnonymousSession = null;
      session?.discard();
      session = null;
      room = null;
      inviteUrl = "";
      qrUrl = "";
      pendingJoinRequests = [];
      roomConnection = "connecting";
      roomConnectionDetail = undefined;
    }

    refreshRemoteRooms();
  }

  async function openCreateDialog() {
    serverMenuOpen = false;
    mobileRailOpen = false;
    mobileToolsOpen = false;
    title = "";
    error = "";
    newRoomAutoApprove = true;
    createDialogOpen = true;
    await tick();
    roomNameInput?.focus();
  }

  function closeCreateDialog() {
    if (busy) return;
    createDialogOpen = false;
    title = "";
    error = "";
  }

  async function enableSounds(updatePreference = true) {
    try {
      audioContext ??= new AudioContext();
      await audioContext.resume();
      if (updatePreference) {
        channelPreferences.setGlobalSound(true);
      }
    } catch {
      if (updatePreference) {
        channelPreferences.setGlobalSound(false);
      }
    }
  }

  function playIncomingTone() {
    const activeRoomKey = room ? roomIdentityKey(room.coordinatorPubkey, room.id) : undefined;
    if ((activeRoomKey ? !channelPreferences.soundEnabled(activeRoomKey) : !channelPreferences.globalSound) || !audioContext || audioContext.state !== "running") return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.setValueAtTime(620, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.1);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.04, audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.17);
  }

  async function createInvite() {
    busy = true;
    error = "";
    void enableSounds(false);
    try {
      const created = await createHostedRoom({
        title,
        coordinatorPubkey,
        relayUrls,
        coordinatorOrigin: window.location.origin,
        coordinatorName: config.coordinatorName || "My coordinator",
        autoApprove: newRoomAutoApprove,
        identity: currentHostIdentity(),
        signer: userProfileStore.activeSigner ?? (() => { throw new Error("Local identity is not ready"); })(),
        identityOwner: userProfileStore.method === "anonymous" ? "anonymous" : "external",
        coordinatorKeyMode: coordinator.persistenceEnabled ? "persistent" : "ephemeral",
      });
      const entry = buildHostedRoomEntry(created);
      await openHostChat(created);
      refreshRemoteRooms();
      inviteUrl = entry.inviteUrl;
      qrUrl = entry.qrUrl;
      createDialogOpen = false;
      title = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not create invite";
    } finally {
      busy = false;
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(inviteUrl);
    copyState = "copied";
    window.setTimeout(() => {
      copyState = "idle";
    }, 1_800);
  }

  async function copyInviteDetail(value: string, target: "coordinator") {
    await navigator.clipboard.writeText(value);
    detailCopyState = target;
    window.setTimeout(() => {
      if (detailCopyState === target) detailCopyState = "idle";
    }, 1_800);
  }

  function openInviteDialog() {
    if (room) {
      const entry = buildHostedRoomEntry(room);
      room = entry.room;
      if (session) session.room.coordinatorKeyMode = entry.room.coordinatorKeyMode;
      hostedRooms = hostedRooms.map((candidate) => sameRoomIdentity(candidate.room, entry.room) ? entry : candidate);
      inviteUrl = entry.inviteUrl;
      qrUrl = entry.qrUrl;
    }
    copyState = "idle";
    detailCopyState = "idle";
    refreshState = "idle";
    inviteQrExpanded = false;
    inviteDialogOpen = true;
  }

  function closeInviteDialog() {
    inviteDialogOpen = false;
    inviteQrExpanded = false;
    copyState = "idle";
    detailCopyState = "idle";
    refreshState = "idle";
  }

  async function refreshInviteLink() {
    if (!room || !session || refreshState === "refreshing") return;
    refreshState = "refreshing";
    copyState = "idle";
    await tick();
    const refreshedRoom = rotateRoomInvite(session.room);
    const entry = buildHostedRoomEntry(refreshedRoom);
    room = { ...refreshedRoom };
    hostedRooms = hostedRooms.map((candidate) => sameRoomIdentity(candidate.room, refreshedRoom) ? entry : candidate);
    inviteUrl = entry.inviteUrl;
    qrUrl = entry.qrUrl;
    refreshState = "refreshed";
    window.setTimeout(() => {
      if (refreshState === "refreshed") refreshState = "idle";
    }, 2_400);
  }

  async function setAutoApprove(enabled: boolean) {
    autoApprove = enabled;
    await session?.setAutoApprove(enabled);
  }

  async function selectRoom(entry: HostedRoomEntry) {
    inviteDialogOpen = false;
    mobileRailOpen = false;
    mobileToolsOpen = false;
    selectedServerPubkey = coordinatorPubkey;
    const latest = loadRoom(entry.room.id, entry.room.coordinatorPubkey) ?? entry.room;
    const refreshedEntry = buildHostedRoomEntry(latest);
    await openHostChat(refreshedEntry.room);
    hostedRooms = hostedRooms.map((candidate) => sameRoomIdentity(candidate.room, refreshedEntry.room) ? refreshedEntry : candidate);
    inviteUrl = refreshedEntry.inviteUrl;
    qrUrl = refreshedEntry.qrUrl;
    if (hasChatIntent) onNavigate("/");
  }

  function navigateFromRail(href: string): void {
    mobileRailOpen = false;
    mobileToolsOpen = false;
    onNavigate(href);
  }

  function openStoredRoomFromRail(nextRoom: StoredRoom): void {
    rememberLastOpenRoom(nextRoom);
    navigateFromRail(remoteRoomHref(nextRoom));
  }

  function roomsForCoordinator(pubkey: string): StoredRoom[] {
    if (pubkey === coordinatorPubkey) {
      return [...hostedRooms.map((entry) => entry.room), ...homeJoinedRooms];
    }
    return remoteServers.find((server) => server.pubkey === pubkey)?.rooms
      ?? previousLocalServers.find((server) => server.pubkey === pubkey)?.rooms
      ?? [];
  }

  function coordinatorLabelFor(pubkey: string): string {
    if (pubkey === coordinatorPubkey) return config.coordinatorName || "My coordinator";
    if (previousLocalServers.some((server) => server.pubkey === pubkey)) return `Previous local ${shortKey(pubkey)}`;
    return `Coordinator ${shortKey(pubkey)}`;
  }

  async function openCoordinatorRoom(nextRoom: StoredRoom): Promise<void> {
    if (nextRoom.isHost && nextRoom.coordinatorPubkey === coordinatorPubkey) {
      const entry = hostedRooms.find((candidate) => sameRoomIdentity(candidate.room, nextRoom));
      if (entry) await selectRoom(entry);
      return;
    }
    openStoredRoomFromRail(nextRoom);
  }

  function showCoordinatorEmpty(pubkey: string): void {
    selectedServerPubkey = pubkey;
    serverMenuOpen = false;
    if (!hasChatIntent) return;
    onNavigate("/");
    // The route-context effect also reacts to the URL transition. Restore the
    // explicit coordinator selection after that transition has settled.
    window.setTimeout(() => {
      selectedServerPubkey = pubkey;
    }, 0);
  }

  function selectCoordinator(pubkey: string): void {
    selectedServerPubkey = pubkey;
    serverMenuOpen = false;
    const remembered = loadLastOpenRoom(pubkey);
    const available = roomsForCoordinator(pubkey);
    const nextRoom = (remembered && available.find((candidate) => sameRoomIdentity(candidate, remembered))) ?? available[0];
    if (nextRoom) {
      void openCoordinatorRoom(nextRoom);
      return;
    }
    if (activeIntentInvite?.coordinatorPubkey === pubkey) return;
    showCoordinatorEmpty(pubkey);
  }

  function handleEmbeddedChatContext(context: ChatPaneContext | null): void {
    embeddedChatContext = context;
  }

  function handleEmbeddedRoomStored(storedRoom: StoredRoom): void {
    refreshRemoteRooms();
    revision += 1;
    selectedServerPubkey = storedRoom.coordinatorPubkey;
  }

  function openSettings(): void {
    mobileRailOpen = false;
    mobileToolsOpen = false;
    settingsDialogOpen = true;
  }

  function toggleMobileRail(): void {
    mobileToolsOpen = false;
    mobileRailOpen = !mobileRailOpen;
  }

  function closeMobileTools(restoreFocus = true): void {
    if (!mobileToolsOpen) return;
    mobileToolsOpen = false;
    if (restoreFocus) void tick().then(() => mobileToolsTrigger?.focus());
  }

  function toggleManagement(): void {
    mobileRailOpen = false;
    mobileToolsOpen = false;
    managementOpen = !managementOpen;
  }

  async function approveWaitingInvitees() {
    try {
      await session?.approveJoinRequests();
      // Admission runs per request and reports partial failure through the
      // session, so an approval that resolves is not necessarily an approval
      // that admitted anyone.
      admissionError = session?.admissionError ?? null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not approve invitees";
    }
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
      document.getElementById(`host-add-reaction-${targetMessageId}`)?.focus();
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

  function canSendMessages(): boolean {
    return session?.status.connection === "connected" && room?.joinRequestSent !== true;
  }

  async function toggleSounds() {
    if (channelPreferences.globalSound) {
      channelPreferences.setGlobalSound(false);
      return;
    }
    await enableSounds();
  }

  function removalModeFor(target: StoredRoom): "delete" | "leave" {
    return target.isHost && target.membershipStatus !== "retired" && target.coordinatorPubkey === coordinatorPubkey ? "delete" : "leave";
  }

  async function removeCurrentStoredRoom(): Promise<boolean> {
    const target = roomRemovalTarget;
    if (!target) return false;
    const failedRecoveryTarget = coordinator.exhaustedRoomRecoveryTarget;
    const removesFailedRecoveryTarget = Boolean(
      failedRecoveryTarget
        && failedRecoveryTarget.roomId === target.id
        && failedRecoveryTarget.coordinatorPubkey === target.coordinatorPubkey,
    );
    const frozenMode = roomRemovalMode;
    const orderedRooms = roomsForCoordinator(target.coordinatorPubkey);
    const targetIndex = orderedRooms.findIndex((candidate) => sameRoomIdentity(candidate, target));
    if (targetIndex < 0) return false;
    const fallback = targetIndex > 0 ? orderedRooms[targetIndex - 1] : orderedRooms[targetIndex + 1];
    const removesLastSelectedExternalRoom = selectedServerPubkey === target.coordinatorPubkey
      && target.coordinatorPubkey !== coordinatorPubkey
      && orderedRooms.length === 1;
    try {
      const latest = loadRoom(target.id, target.coordinatorPubkey);
      if (!latest || !sameRoomIdentity(latest, target) || removalModeFor(latest) !== frozenMode) return false;
      if (frozenMode === "delete") {
        await coordinator.deleteHostedRoom({ id: latest.id, coordinatorPubkey: latest.coordinatorPubkey });
      }
      const deletingActiveHostRoom = Boolean(room && sameRoomIdentity(room, target));
      const deletingActiveEmbeddedRoom = Boolean(activeIntentInvite
        && activeIntentInvite.groupId === target.id
        && activeIntentInvite.coordinatorPubkey === target.coordinatorPubkey);
      const hostedSessionKey = roomIdentityKey(target.coordinatorPubkey, target.id);
      const hostedSession = hostedRoomSessions.get(hostedSessionKey);
      hostedSession?.discard();
      hostedRoomSessions.delete(hostedSessionKey);
      if (deletingActiveHostRoom) {
        unsubscribeSession?.();
        unsubscribeSession = null;
        unregisterAnonymousSession?.();
        unregisterAnonymousSession = null;
        session?.discard();
        session = null;
      }
      removeStoredRoom(latest, {
        reason: frozenMode === "delete" ? "deleted" : "left",
        coordinatorLabel: coordinatorLabelFor(latest.coordinatorPubkey),
      });
      hostedRooms = hostedRooms.filter((entry) => !sameRoomIdentity(entry.room, target));
      homeJoinedRooms = homeJoinedRooms.filter((candidate) => !sameRoomIdentity(candidate, target));
      remoteRooms = remoteRooms.filter((candidate) => !sameRoomIdentity(candidate, target));
      previousLocalRooms = previousLocalRooms.filter((candidate) => !sameRoomIdentity(candidate, target));

      if (removesFailedRecoveryTarget && failedRecoveryTarget) {
        await coordinator.resumeAfterRemovingFailedRoom(failedRecoveryTarget);
      }

      if (deletingActiveHostRoom) {
        room = null;
        inviteUrl = "";
        qrUrl = "";
        composer = "";
        pendingJoinRequests = [];
        roomConnection = "connecting";
        roomConnectionDetail = undefined;
      }
      if (deletingActiveHostRoom || deletingActiveEmbeddedRoom || removesLastSelectedExternalRoom) {
        const availableFallback = fallback ? loadRoom(fallback.id, fallback.coordinatorPubkey) : null;
        if (availableFallback && sameRoomIdentity(availableFallback, fallback)) {
          await openCoordinatorRoom(availableFallback);
        } else if (target.coordinatorPubkey !== coordinatorPubkey) {
          selectCoordinator(coordinatorPubkey);
        } else {
          showCoordinatorEmpty(target.coordinatorPubkey);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  function requestSidebarRoomRemoval(target: StoredRoom, origin: HTMLButtonElement | undefined): void {
    const latest = loadRoom(target.id, target.coordinatorPubkey);
    if (!latest || !sameRoomIdentity(latest, target)) return;
    roomRemovalTarget = latest;
    roomRemovalMode = removalModeFor(latest);
    roomRemovalOrigin = origin ?? null;
  }

  function closeRoomRemovalDialog(): void {
    roomRemovalTarget = null;
    const origin = roomRemovalOrigin;
    roomRemovalOrigin = null;
    roomRemovalMode = "delete";
    if (origin) void tick().then(() => origin.focus());
  }

  async function wakeCoordinator() {
    if (!config.isSetupComplete) return;
    if (config.presenceState === "offline") config.setPresenceState("invisible");
    await coordinator.start();
  }

  async function completeCoordinatorSetup(submission: CoordinatorSetupSubmission): Promise<string | null> {
    const persistenceWasEnabled = coordinator.persistenceEnabled;
    try {
      if (submission.persistence === "persistent") {
        const persisted = await coordinator.enablePersistence(submission.passphrase, submission.confirmPassphrase);
        if (!persisted) return coordinator.persistenceError ?? "Could not save the coordinator identity";
      } else if (coordinator.persistenceEnabled) {
        await coordinator.disablePersistence();
      }

      const completed = config.completeFirstRunSetup({
        name: submission.name,
        relays: submission.relays,
        announce: submission.announce,
        autostart: submission.autostart,
      });
      if (!completed) {
        if (submission.persistence === "persistent" && !persistenceWasEnabled) await coordinator.disablePersistence();
        return config.setupError ?? config.relayError ?? "Could not save coordinator setup";
      }

      await coordinator.retryCoordinatorProfilePublication();
      if (submission.autostart) {
        autostartAttempted = true;
        await coordinator.start();
      }
      return null;
    } catch {
      return "Could not finish coordinator setup. Try again.";
    }
  }

  async function send() {
    if (!session || !canSendMessages()) return;
    const message = composer;
    if (!message.trim()) return;
    void enableSounds(false);
    error = "";
    session.setIdentity(currentHostIdentity());
    composer = "";
    try {
      await session.send(message);
    } catch (cause) {
      if (!composer.trim()) composer = message;
      error = cause instanceof Error ? cause.message : "Unable to send this message";
    }
  }

  onDestroy(() => {
    reachabilityProbeGeneration += 1;
    if (reachabilityTimer !== null) window.clearInterval(reachabilityTimer);
    reachabilityTimer = null;
    unsubscribeSession?.();
    unregisterAnonymousSession?.();
    unregisterAnonymousSession = null;
    unregisterHostedRoomRecovery?.();
    pendingRecoverySession?.discard();
    for (const hostedSession of hostedRoomSessions.values()) hostedSession.stop();
    hostedRoomSessions.clear();
    session?.stop();
  });
  onMount(() => {
    setupWasCompleteOnMount = config.isSetupComplete;
    const closeDialogsOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      serverMenuOpen = false;
      managementOpen = false;
      const targetMessageId = reactionPickerMessageId;
      reactionPickerMessageId = null;
      if (targetMessageId) void tick().then(() => document.getElementById(`host-add-reaction-${targetMessageId}`)?.focus());
      mobileRailOpen = false;
      closeMobileTools();
      if (inviteDialogOpen) closeInviteDialog();
      if (createDialogOpen) closeCreateDialog();
      settingsDialogOpen = false;
    };
    refreshRemoteRooms();
    const compactQuery = window.matchMedia("(max-width: 900px)");
    const markCoordinatorOnline = (event: Event) => handleCoordinatorReachabilityEvent(event, "online");
    const markCoordinatorOffline = (event: Event) => handleCoordinatorReachabilityEvent(event, "offline");
    const markBrowserOffline = () => {
      browserOnline = false;
      reachabilityProbeGeneration += 1;
      remoteCoordinatorReachability = Object.fromEntries(
        reachabilityTargets().map((target) => [target.pubkey, "offline"] as const),
      );
    };
    const recheckBrowserOnline = () => {
      browserOnline = true;
      void probeRemoteCoordinators();
    };
    const recheckWhenVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void probeRemoteCoordinators();
    };
    const syncCompactViewport = () => {
      compactViewport = compactQuery.matches;
      if (!compactViewport) {
        mobileRailOpen = false;
        mobileToolsOpen = false;
      }
    };
    syncCompactViewport();
    compactQuery.addEventListener("change", syncCompactViewport);
    window.addEventListener(ROOMS_CHANGED_EVENT, handleStoredRoomsChanged);
    const refreshUnread = (event: Event) => {
      refreshRemoteRooms();
      revision += 1;
      const detail = event instanceof CustomEvent
        ? event.detail as { coordinatorPubkey?: string; roomId?: string; previousCount?: number; unreadCount?: number }
        : undefined;
      if (!detail || detail.previousCount !== 0 || !detail.unreadCount || !detail.coordinatorPubkey || !detail.roomId) return;
      const changedRoom = loadRoom(detail.roomId, detail.coordinatorPubkey);
      if (changedRoom) unreadAnnouncement = `New messages in # ${changedRoom.title}`;
    };
    window.addEventListener("cordn:room-unread-changed", refreshUnread);
    window.addEventListener(SERVER_ONLINE_EVENT, markCoordinatorOnline);
    window.addEventListener(SERVER_OFFLINE_EVENT, markCoordinatorOffline);
    window.addEventListener("offline", markBrowserOffline);
    window.addEventListener("online", recheckBrowserOnline);
    document.addEventListener("visibilitychange", recheckWhenVisible);
    window.addEventListener("keydown", closeDialogsOnEscape);
    const acknowledgeOnVisibility = () => acknowledgeVisibleHostRoom();
    document.addEventListener("visibilitychange", acknowledgeOnVisibility);
    reachabilityTimer = window.setInterval(() => void probeRemoteCoordinators(), 12_000);
    return () => {
      reachabilityProbeGeneration += 1;
      if (reachabilityTimer !== null) window.clearInterval(reachabilityTimer);
      reachabilityTimer = null;
      window.removeEventListener(ROOMS_CHANGED_EVENT, handleStoredRoomsChanged);
      window.removeEventListener("cordn:room-unread-changed", refreshUnread);
      window.removeEventListener(SERVER_ONLINE_EVENT, markCoordinatorOnline);
      window.removeEventListener(SERVER_OFFLINE_EVENT, markCoordinatorOffline);
      window.removeEventListener("offline", markBrowserOffline);
      window.removeEventListener("online", recheckBrowserOnline);
      document.removeEventListener("visibilitychange", recheckWhenVisible);
      window.removeEventListener("keydown", closeDialogsOnEscape);
      document.removeEventListener("visibilitychange", acknowledgeOnVisibility);
      compactQuery.removeEventListener("change", syncCompactViewport);
    };
  });
</script>

<main class="operator-field h-[100dvh] max-h-[100dvh] overflow-x-hidden overflow-y-hidden text-[#dfffe7]">
  <div class:dialog-open={dialogOpen} class="host-workspace relative grid h-full w-full min-w-0 grid-rows-[auto_minmax(0,1fr)]" data-testid="operator-shell">
    <header class="host-topbar flex shrink-0 flex-wrap items-center justify-between gap-3 px-3 py-3 sm:flex-nowrap sm:px-5">
      <WorkspaceNav
        {currentUrl}
        {homeCoordinatorPubkey}
        homeCoordinatorName={config.coordinatorName}
        coordinatorStatus={coordinator.status}
        soundsEnabled={embeddedChatActive ? embeddedChatContext?.soundsEnabled ?? false : channelPreferences.globalSound}
        activeRoomTitle={embeddedChatActive ? embeddedChatContext?.room?.title ?? activeIntentInvite?.title : room?.title}
        activeRoomCoordinatorPubkey={embeddedChatActive ? embeddedChatContext?.room?.coordinatorPubkey ?? activeIntentInvite?.coordinatorPubkey : room?.coordinatorPubkey}
        activeRoomHost={embeddedChatActive ? embeddedChatContext?.host ?? activeIntentHost : room ? hostIdentityForRoom(room) : undefined}
        roomConnectionStatus={embeddedChatActive ? embeddedChatContext?.connection ?? undefined : room && session ? roomConnection : undefined}
        showRoomBrowser={false}
        {onNavigate}
      />
      <div class:guided-setup={guidedSetupMode} class="host-commandbar">
        {#if !setupRequired}
          <button
            class:active={mobileRailOpen}
            class="mobile-rail-toggle"
            type="button"
            aria-label={mobileRailOpen ? "Close room browser" : "Open room browser"}
            aria-controls="host-room-rail"
            aria-expanded={mobileRailOpen}
            onclick={toggleMobileRail}
          >
            <span aria-hidden="true">#</span>
            <span>{embeddedChatActive ? embeddedChatContext?.room?.title ?? activeIntentInvite?.title ?? "Room" : room?.title || "Rooms"}</span>
            <strong>{selectedServerRoomCount}</strong>
          </button>
        {/if}
        {#if !guidedSetupMode && !setupRequired && !locked}
          <button
            class:active={managementOpen}
            class="manage-toggle header-manage"
            type="button"
            aria-pressed={managementOpen}
            aria-label={managementOpen ? "Close management interface" : "Open management interface"}
            onclick={toggleManagement}
          >{managementOpen ? "Host" : "Manage"}</button>
        {/if}
        {#if !setupRequired && !locked}
          <button
            class:enabled={channelPreferences.globalSound}
            class="global-sound-toggle"
            type="button"
            aria-label={channelPreferences.globalSound ? "Mute all channel sounds" : "Enable channel sounds"}
            aria-pressed={channelPreferences.globalSound}
            title={channelPreferences.globalSound ? "Global sound on" : "Global sound off"}
            onclick={() => void toggleSounds()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9h3.3L12 5.2v13.6L7.3 15H4z"></path>
              {#if channelPreferences.globalSound}<path d="M15.5 9.1a4 4 0 0 1 0 5.8M18 6.7a7.4 7.4 0 0 1 0 10.6"></path>{:else}<path d="m16 9 5 6m0-6-5 6"></path>{/if}
            </svg>
          </button>
        {/if}
      </div>
    </header>

    <div
      class:management-open={managementOpen}
      class:startup-mode={coordinator.status === "starting" || coordinator.status === "stopping"}
      class:guided-setup={guidedSetupMode}
      class:setup-required={setupRequired}
      class="host-layout grid min-h-0 min-w-0"
    >
      {#if mobileRailOpen && compactViewport}
        <button class="mobile-rail-scrim" type="button" aria-label="Close room browser" onclick={() => mobileRailOpen = false}></button>
      {/if}
      {#if !setupRequired}
      <aside
        id="host-room-rail"
        class:mobile-open={mobileRailOpen}
        class="host-rail min-h-0 min-w-0 overflow-y-auto border-b border-[#21352a] p-3 sm:p-4 lg:border-r lg:border-b-0"
        data-testid="invite-panel"
        data-local-rail-state={localRailState}
        aria-busy={localRailBusy}
        aria-hidden={compactViewport && !mobileRailOpen}
        inert={compactViewport && !mobileRailOpen}
      >
        <span class="sr-only" aria-live="polite">{unreadAnnouncement}</span>
        <div class="flex min-h-full flex-col gap-4">
            <div class="rail-join"><InviteRedeemer onNavigate={navigateFromRail} /></div>
            {#if false}
            <nav class="channel-browser" aria-label="Server and channel browser">
              <div class="channel-context">
                <div class="channel-context-row">
                  <button
                    class="channel-context-button"
                    type="button"
                    aria-label={localRailUnavailable
                      ? `Browse ${selectedServerName}. ${localRailStatusLabel}`
                      : `Browse ${selectedServerName}. ${selectedServerIsHome ? localCoordinatorStatusLabel : reachabilityLabel(externalCoordinatorReachability(selectedServerPubkey))}. ${selectedServerRoomCount} ${selectedServerRoomCount === 1 ? "room" : "rooms"}.`}
                    aria-haspopup="menu"
                    aria-expanded={serverMenuOpen}
                    onclick={() => serverMenuOpen = !serverMenuOpen}
                  >
                    {#if selectedServerIsHome}
                      <span
                        class:online={localCoordinatorStatus === "online"}
                        class:connecting={localCoordinatorStatus === "connecting"}
                        class:offline={localCoordinatorStatus === "offline"}
                        class="channel-server-dot"
                        data-testid="selected-coordinator-status"
                        data-coordinator-pubkey={coordinatorPubkey}
                        data-state={localCoordinatorStatus}
                        role="img"
                        aria-label={localCoordinatorStatusLabel}
                        title={localCoordinatorStatusLabel}
                      ></span>
                    {:else}
                      <span
                        class:online={externalCoordinatorReachability(selectedServerPubkey) === "online"}
                        class:connecting={externalCoordinatorReachability(selectedServerPubkey) === "connecting"}
                        class:offline={externalCoordinatorReachability(selectedServerPubkey) === "offline"}
                        class:unknown={externalCoordinatorReachability(selectedServerPubkey) === "unknown"}
                        class="channel-server-dot"
                        data-testid="selected-coordinator-status"
                        data-coordinator-pubkey={selectedServerPubkey}
                        data-state={externalCoordinatorReachability(selectedServerPubkey)}
                        role="img"
                        aria-label={reachabilityLabel(externalCoordinatorReachability(selectedServerPubkey))}
                        title={reachabilityLabel(externalCoordinatorReachability(selectedServerPubkey))}
                      ></span>
                    {/if}
                    <span class="channel-context-copy">
                      <strong>{selectedServerName}</strong>
                      <small>{localRailUnavailable
                        ? localRailStatusLabel
                        : selectedServerIsHome
                        ? `${relayUrls.length} relay ${relayUrls.length === 1 ? "path" : "paths"}`
                        : selectedServerIsPreviousLocal
                          ? `${reachabilityLabel(externalCoordinatorReachability(selectedServerPubkey))} · key changed`
                          : `${reachabilityLabel(externalCoordinatorReachability(selectedServerPubkey))} · ${serverHost(selectedRemoteServer?.origin ?? activeIntentInvite?.coordinatorOrigin)}`}</small>
                    </span>
                    {#if localRailActionable}
                      <span class="channel-count rail-ready-control rail-ready-count" title={`${selectedServerRoomCount} ${selectedServerRoomCount === 1 ? "room" : "rooms"}`}>{selectedServerRoomCount}</span>
                      {#if coordinatorUnreadCount(selectedServerPubkey || coordinatorPubkey) > 0}<span class="unread-badge rail-ready-control rail-ready-count" title={`${coordinatorUnreadCount(selectedServerPubkey || coordinatorPubkey)} unread messages for this coordinator`} aria-label={`${coordinatorUnreadCount(selectedServerPubkey || coordinatorPubkey)} unread messages for this coordinator`}>{displayUnreadCount(coordinatorUnreadCount(selectedServerPubkey || coordinatorPubkey))}</span>{/if}
                    {/if}
                    <span class="channel-chevron" aria-hidden="true">{serverMenuOpen ? "↑" : "↓"}</span>
                  </button>
                  {#if selectedServerIsHome && !locked}
                    <div class="coordinator-actions" role="group" aria-label="Coordinator controls">
                      {#if !guidedSetupMode}
                        <LifecyclePanel {coordinator} compact minimal onStart={wakeCoordinator} startLabel={config.presenceState === "offline" ? "Wake" : "Start"} />
                      {/if}
                      <button
                        class:pending={coordinator.restartRequired}
                        class="channel-settings"
                        type="button"
                        aria-label={`Settings for ${selectedServerName}`}
                        title={`Settings for ${selectedServerName}`}
                        onclick={openSettings}
                      >
                        <span aria-hidden="true">⚙</span>
                        {#if coordinator.restartRequired}<span class="channel-settings-pip" aria-label="Restart required"></span>{/if}
                      </button>
                    </div>
                  {/if}
                </div>
                {#if serverMenuOpen}
                  <div class="channel-server-menu" role="menu" aria-label="Choose coordinator">
                    <button
                      class:active={selectedServerIsHome}
                      type="button"
                      role="menuitem"
                        onclick={() => selectCoordinator(coordinatorPubkey)}
                    >
                      <span
                        class:online={localCoordinatorStatus === "online"}
                        class:connecting={localCoordinatorStatus === "connecting"}
                        class:offline={localCoordinatorStatus === "offline"}
                        class="channel-server-dot"
                        data-testid="local-coordinator-menu-status"
                        data-coordinator-pubkey={coordinatorPubkey}
                        data-state={localCoordinatorStatus}
                        role="img"
                        aria-label={localCoordinatorStatusLabel}
                        title={localCoordinatorStatusLabel}
                      ></span>
                      <span><strong>{config.coordinatorName || "My coordinator"}</strong><small>{localCoordinatorStatusLabel}</small></span>
                      <span>{hostedRooms.length + homeJoinedRooms.length}</span>
                      {#if coordinatorUnreadCount(coordinatorPubkey) > 0}<span class="unread-badge" title={`${coordinatorUnreadCount(coordinatorPubkey)} unread messages for this coordinator`} aria-label={`${coordinatorUnreadCount(coordinatorPubkey)} unread messages for this coordinator`}>{displayUnreadCount(coordinatorUnreadCount(coordinatorPubkey))}</span>{/if}
                    </button>
                    {#each remoteServers as server (server.pubkey)}
                      <button
                        class:active={selectedServerPubkey === server.pubkey}
                        type="button"
                        role="menuitem"
                        onclick={() => selectCoordinator(server.pubkey)}
                      >
                        <span
                          class:online={externalCoordinatorReachability(server.pubkey) === "online"}
                          class:connecting={externalCoordinatorReachability(server.pubkey) === "connecting"}
                          class:offline={externalCoordinatorReachability(server.pubkey) === "offline"}
                          class:unknown={externalCoordinatorReachability(server.pubkey) === "unknown"}
                          class="channel-server-dot"
                          data-testid={`coordinator-menu-status-${server.pubkey}`}
                          data-coordinator-pubkey={server.pubkey}
                          data-state={externalCoordinatorReachability(server.pubkey)}
                          role="img"
                          aria-label={reachabilityLabel(externalCoordinatorReachability(server.pubkey))}
                        ></span>
                        <span><strong>Coordinator {shortKey(server.pubkey)}</strong><small>{reachabilityLabel(externalCoordinatorReachability(server.pubkey))} · {serverHost(server.origin)}</small></span>
                        <span>{server.rooms.length}</span>
                        {#if coordinatorUnreadCount(server.pubkey) > 0}<span class="unread-badge" title={`${coordinatorUnreadCount(server.pubkey)} unread messages for this coordinator`} aria-label={`${coordinatorUnreadCount(server.pubkey)} unread messages for this coordinator`}>{displayUnreadCount(coordinatorUnreadCount(server.pubkey))}</span>{/if}
                      </button>
                    {/each}
                    {#if activeIntentInvite
                      && activeIntentInvite.coordinatorPubkey !== coordinatorPubkey
                      && !remoteServers.some((server) => server.pubkey === activeIntentInvite?.coordinatorPubkey)}
                      <button
                        class:active={selectedServerPubkey === activeIntentInvite.coordinatorPubkey}
                        type="button"
                        role="menuitem"
                        onclick={() => selectCoordinator(activeIntentInvite.coordinatorPubkey)}
                      >
                        <span
                          class:online={externalCoordinatorReachability(activeIntentInvite.coordinatorPubkey) === "online"}
                          class:connecting={externalCoordinatorReachability(activeIntentInvite.coordinatorPubkey) === "connecting"}
                          class:offline={externalCoordinatorReachability(activeIntentInvite.coordinatorPubkey) === "offline"}
                          class:unknown={externalCoordinatorReachability(activeIntentInvite.coordinatorPubkey) === "unknown"}
                          class="channel-server-dot"
                          data-testid={`coordinator-menu-status-${activeIntentInvite.coordinatorPubkey}`}
                          data-coordinator-pubkey={activeIntentInvite.coordinatorPubkey}
                          data-state={externalCoordinatorReachability(activeIntentInvite.coordinatorPubkey)}
                          role="img"
                          aria-label={reachabilityLabel(externalCoordinatorReachability(activeIntentInvite.coordinatorPubkey))}
                        ></span>
                        <span><strong>Coordinator {shortKey(activeIntentInvite.coordinatorPubkey)}</strong><small>{reachabilityLabel(externalCoordinatorReachability(activeIntentInvite.coordinatorPubkey))} · {serverHost(activeIntentInvite.coordinatorOrigin)}</small></span>
                        <span>1</span>
                      </button>
                    {/if}
                    {#if previousLocalServers.length > 0}
                      <p class="channel-server-group-label">Previous local sessions</p>
                      {#each previousLocalServers as server (server.pubkey)}
                        <button
                          class:active={selectedServerPubkey === server.pubkey}
                          type="button"
                          role="menuitem"
                          onclick={() => selectCoordinator(server.pubkey)}
                        >
                          <span
                            class:online={externalCoordinatorReachability(server.pubkey) === "online"}
                            class:connecting={externalCoordinatorReachability(server.pubkey) === "connecting"}
                            class:offline={externalCoordinatorReachability(server.pubkey) === "offline"}
                            class:unknown={externalCoordinatorReachability(server.pubkey) === "unknown"}
                            class="channel-server-dot"
                            data-testid={`coordinator-menu-status-${server.pubkey}`}
                            data-coordinator-pubkey={server.pubkey}
                            data-state={externalCoordinatorReachability(server.pubkey)}
                            role="img"
                            aria-label={reachabilityLabel(externalCoordinatorReachability(server.pubkey))}
                          ></span>
                          <span><strong>Previous local {shortKey(server.pubkey)}</strong><small>{reachabilityLabel(externalCoordinatorReachability(server.pubkey))} · key changed; retained on this device.</small></span>
                          <span>{server.rooms.length}</span>
                          {#if coordinatorUnreadCount(server.pubkey) > 0}<span class="unread-badge" title={`${coordinatorUnreadCount(server.pubkey)} unread messages for this coordinator`} aria-label={`${coordinatorUnreadCount(server.pubkey)} unread messages for this coordinator`}>{displayUnreadCount(coordinatorUnreadCount(server.pubkey))}</span>{/if}
                        </button>
                      {/each}
                    {/if}
                  </div>
                {/if}
              </div>
              <div class="channel-browser-header">
                <span>Channels</span>
                {#if selectedServerIsHome && localRailActionable}
                  <button class="rail-ready-control rail-ready-create" type="button" aria-label="New room" title={coordinator.status === "running" ? "New room" : "Start the coordinator to create a room"} disabled={coordinator.status !== "running"} onclick={() => void openCreateDialog()}>＋</button>
                {/if}
              </div>
              {#if localRailUnavailable && selectedServerRoomCount === 0}
                <div class="channel-loading-placeholder" aria-hidden="true"></div>
              {:else if selectedServerRoomCount === 0}
                <div class="channel-empty-state" data-testid="coordinator-empty-state">
                  <strong>No rooms for this coordinator</strong>
                  {#if selectedServerIsHome}
                    <span>Create a room or open a current invite to add one here.</span>
                    <button type="button" aria-label="Create room from coordinator sidebar" disabled={coordinator.status !== "running"} onclick={() => void openCreateDialog()}>Create room</button>
                  {:else}
                    <span>You no longer have any saved rooms on this coordinator.</span>
                    <button type="button" onclick={() => selectCoordinator(coordinatorPubkey)}>Back to my coordinator</button>
                  {/if}
                </div>
              {:else if selectedServerIsHome}
                <div class="channel-list">
                  {#each hostedRooms as entry (roomIdentityKey(entry.room.coordinatorPubkey, entry.room.id))}
                    <div class:active={localRailActionable && !embeddedChatActive && Boolean(room && sameRoomIdentity(entry.room, room))} class:unavailable={localRailUnavailable} class:busy={localRailBusy} class="channel-row" data-room-key={roomIdentityKey(entry.room.coordinatorPubkey, entry.room.id)}>
                      <button class="channel-row-primary" type="button" aria-label={`Open room ${entry.room.title}, hosted by ${hostIdentityForRoom(entry.room).name}`} disabled={localRailUnavailable} onclick={() => selectRoom(entry)}>
                        <span class="channel-active-mark" aria-hidden="true"></span>
                        <span class="channel-hash" aria-hidden="true">#</span>
                        <span class="channel-name-with-preferences"><span class="truncate" title={entry.room.title}>{entry.room.title}</span>{#if localRailActionable}<ChannelPreferenceIndicators roomKey={roomIdentityKey(entry.room.coordinatorPubkey, entry.room.id)} />{/if}</span>
                        {#if localRailActionable}<span class="rail-ready-control rail-ready-room-meta channel-owner-avatar"><RoomHostBadge host={hostIdentityForRoom(entry.room)} compact avatarOnly /></span>{/if}
                      </button>
                      {#if localRailActionable}
                        {#if roomUnreadCount(entry.room) > 0}<span class="unread-badge rail-ready-control rail-ready-room-meta" data-room-key={roomIdentityKey(entry.room.coordinatorPubkey, entry.room.id)} data-testid={`room-unread-${roomIdentityKey(entry.room.coordinatorPubkey, entry.room.id)}`} title={`${roomUnreadCount(entry.room)} unread messages`} aria-label={`${roomUnreadCount(entry.room)} unread messages`}>{displayUnreadCount(roomUnreadCount(entry.room))}</span>{/if}
                        <div class="rail-ready-control rail-ready-room-actions"><RoomActionsMenu sidebar roomTitle={entry.room.title} roomId={entry.room.id} coordinatorPubkey={entry.room.coordinatorPubkey} inviteUrl={entry.inviteUrl} removalMode="delete" onRemove={(origin) => requestSidebarRoomRemoval(entry.room, origin)} /></div>
                      {/if}
                    </div>
                  {/each}
                  {#each homeJoinedRooms as joinedRoom (`${joinedRoom.coordinatorPubkey}:${joinedRoom.id}`)}
                    <div class:active={localRailActionable && embeddedChatActive && activeIntentInvite?.groupId === joinedRoom.id && activeIntentInvite?.coordinatorPubkey === joinedRoom.coordinatorPubkey} class:unavailable={localRailUnavailable} class:busy={localRailBusy} class="channel-row" data-room-key={roomIdentityKey(joinedRoom.coordinatorPubkey, joinedRoom.id)}>
                    <button class="channel-row-primary" type="button" aria-label={`Open joined room ${joinedRoom.title}, hosted by ${hostIdentityForRoom(joinedRoom).name}`} disabled={localRailUnavailable} onclick={() => openStoredRoomFromRail(joinedRoom)}>
                      <span class="channel-active-mark" aria-hidden="true"></span>
                      <span class="channel-hash" aria-hidden="true">#</span>
                      <span class="channel-name-with-preferences"><span class="truncate">{joinedRoom.title}</span>{#if localRailActionable}<ChannelPreferenceIndicators roomKey={roomIdentityKey(joinedRoom.coordinatorPubkey, joinedRoom.id)} />{/if}</span>
                      {#if localRailActionable}<span class="rail-ready-control rail-ready-room-meta channel-owner-avatar"><RoomHostBadge host={hostIdentityForRoom(joinedRoom)} compact avatarOnly /></span>{/if}
                    </button>
                    {#if localRailActionable}
                      {#if roomUnreadCount(joinedRoom) > 0}<span class="unread-badge rail-ready-control rail-ready-room-meta" data-room-key={roomIdentityKey(joinedRoom.coordinatorPubkey, joinedRoom.id)} data-testid={`room-unread-${roomIdentityKey(joinedRoom.coordinatorPubkey, joinedRoom.id)}`} title={`${roomUnreadCount(joinedRoom)} unread messages`} aria-label={`${roomUnreadCount(joinedRoom)} unread messages`}>{displayUnreadCount(roomUnreadCount(joinedRoom))}</span>{/if}
                      <div class="rail-ready-control rail-ready-room-actions"><RoomActionsMenu sidebar roomTitle={joinedRoom.title} roomId={joinedRoom.id} coordinatorPubkey={joinedRoom.coordinatorPubkey} inviteUrl={remoteRoomHref(joinedRoom)} removalMode="leave" onRemove={(origin) => requestSidebarRoomRemoval(joinedRoom, origin)} /></div>
                    {/if}
                    </div>
                  {/each}
                </div>
              {:else if selectedRemoteServer || selectedPreviousLocalServer}
                <div class="channel-list">
                  {#if selectedServerIsPreviousLocal}
                    <p class="channel-previous-guidance">This session belongs to a previous local coordinator key. Open it to leave its saved copy; the current coordinator cannot delete it.</p>
                  {/if}
                  {#each selectedExternalServer.rooms as remoteRoom (`${remoteRoom.coordinatorPubkey}:${remoteRoom.id}`)}
                      <div class:active={embeddedChatActive && activeIntentInvite?.groupId === remoteRoom.id && activeIntentInvite?.coordinatorPubkey === remoteRoom.coordinatorPubkey} class="channel-row" data-room-key={roomIdentityKey(remoteRoom.coordinatorPubkey, remoteRoom.id)}>
                      <button class="channel-row-primary" type="button"
                        aria-label={selectedServerIsPreviousLocal
                          ? `Open previous local session ${remoteRoom.title}, hosted by ${hostIdentityForRoom(remoteRoom).name}`
                          : `Open room ${remoteRoom.title}, hosted by ${hostIdentityForRoom(remoteRoom).name}, on ${serverHost(selectedExternalServer.origin)}`}
                        onclick={() => openStoredRoomFromRail(remoteRoom)}
                      >
                        <span class="channel-active-mark" aria-hidden="true"></span>
                        <span class="channel-hash" aria-hidden="true">#</span>
                        <span class="channel-name-with-preferences"><span class="truncate">{remoteRoom.title}{remoteRoom.coordinatorKeyMode === "ephemeral" ? " · temporary key" : ""}</span>{#if localRailActionable}<ChannelPreferenceIndicators roomKey={roomIdentityKey(remoteRoom.coordinatorPubkey, remoteRoom.id)} />{/if}</span>
                        {#if localRailActionable}<span class="channel-owner-avatar"><RoomHostBadge host={hostIdentityForRoom(remoteRoom)} compact avatarOnly /></span>{/if}
                      </button>
                      {#if roomUnreadCount(remoteRoom) > 0}<span class="unread-badge" data-room-key={roomIdentityKey(remoteRoom.coordinatorPubkey, remoteRoom.id)} data-testid={`room-unread-${roomIdentityKey(remoteRoom.coordinatorPubkey, remoteRoom.id)}`} title={`${roomUnreadCount(remoteRoom)} unread messages`} aria-label={`${roomUnreadCount(remoteRoom)} unread messages`}>{displayUnreadCount(roomUnreadCount(remoteRoom))}</span>{/if}
                      <RoomActionsMenu sidebar roomTitle={remoteRoom.title} roomId={remoteRoom.id} coordinatorPubkey={remoteRoom.coordinatorPubkey} inviteUrl={remoteRoomHref(remoteRoom)} removalMode="leave" onRemove={(origin) => requestSidebarRoomRemoval(remoteRoom, origin)} />
                      </div>
                  {/each}
                </div>
              {:else if activeIntentInvite && activeIntentInvite.coordinatorPubkey === selectedServerPubkey}
                <div class="channel-list">
                  <button class="channel-row active" type="button" aria-current="page">
                    <span class="channel-active-mark" aria-hidden="true"></span>
                    <span class="channel-hash" aria-hidden="true">#</span>
                    <span class="truncate">{activeIntentInvite.title || "Invited room"}</span>
                    {#if localRailActionable}<span class="channel-owner-avatar"><RoomHostBadge host={activeIntentHost ?? { name: "Unknown host", pubkey: "" }} compact avatarOnly /></span>{/if}
                  </button>
                </div>
              {/if}
            </nav>
            {#if room && !embeddedChatActive && localRailActionable}
              <div class="room-tools rail-ready-control rail-ready-tools" aria-label={`Controls for ${room.title}`}>
                <button class="share-trigger" type="button" aria-label="Invite" aria-haspopup="dialog" onclick={openInviteDialog}>
                  <span>Invite</span>
                  <span aria-hidden="true">↗</span>
                </button>
                <button class:enabled={autoApprove} class="room-access-toggle" type="button" aria-pressed={autoApprove} aria-label={`Auto-approve invitees for ${room.title}: ${autoApprove ? "on" : "off"}`} title="Set admission behavior for this room" onclick={() => void setAutoApprove(!autoApprove)}>
                  <span>Auto-approve</span>
                  <strong>{autoApprove ? "On" : "Off"}</strong>
                </button>
              </div>
              <span class="sr-only" data-testid="invite-link">{inviteUrl}</span>
              {#if !autoApprove}
                <PendingInvitees requests={pendingJoinRequests} onApprove={approveWaitingInvitees} />
                {#if admissionError}<p class="admission-error" role="status" data-testid="admission-error">{admissionError}</p>{/if}
              {/if}
              {#if error}<p class="text-sm text-[#ffaaa3]">{error}</p>{/if}
            {/if}
            {/if}

            <div class="coordinator-runtime-stack">
            <section class="coordinator-runtime-card" data-testid="coordinator-runtime-card" aria-label={`Local coordinator ${config.coordinatorName || "My coordinator"}`}>
              <div class="coordinator-runtime-copy">
                <span
                  class:online={localCoordinatorStatus === "online"}
                  class:connecting={localCoordinatorStatus === "connecting"}
                  class:offline={localCoordinatorStatus === "offline"}
                  class="channel-server-dot"
                  data-testid="selected-coordinator-status"
                  data-coordinator-pubkey={coordinatorPubkey}
                  data-state={localCoordinatorStatus}
                  role="img"
                  aria-label={localCoordinatorStatusLabel}
                ></span>
                <span><strong>{config.coordinatorName || "My coordinator"}</strong><small>{localCoordinatorStatusLabel} · {relayUrls.length} relay {relayUrls.length === 1 ? "path" : "paths"}</small></span>
              </div>
              {#if !locked}
                <div class="coordinator-actions" role="group" aria-label="Coordinator controls">
                  {#if !guidedSetupMode}
                    <LifecyclePanel {coordinator} compact minimal onStart={wakeCoordinator} startLabel={config.presenceState === "offline" ? "Wake" : "Start"} />
                  {/if}
                  <button class:pending={coordinator.restartRequired} class="channel-settings" type="button" aria-label={`Settings for ${config.coordinatorName || "My coordinator"}`} onclick={openSettings}>
                    <span aria-hidden="true">⚙</span>
                    {#if coordinator.restartRequired}<span class="channel-settings-pip" aria-label="Restart required"></span>{/if}
                  </button>
                </div>
              {/if}
            </section>

            {#if room && localRailActionable}
              <div class="room-tools rail-ready-control rail-ready-tools" aria-label={`Controls for ${room.title}`}>
                <button class="share-trigger" type="button" aria-label="Invite" aria-haspopup="dialog" onclick={openInviteDialog}><span>Invite</span><span aria-hidden="true">↗</span></button>
                <button class:enabled={autoApprove} class="room-access-toggle" type="button" aria-pressed={autoApprove} aria-label={`Auto-approve invitees for ${room.title}: ${autoApprove ? "on" : "off"}`} onclick={() => void setAutoApprove(!autoApprove)}><span>Auto-approve</span><strong>{autoApprove ? "On" : "Off"}</strong></button>
              </div>
              <span class="sr-only" data-testid="invite-link">{inviteUrl}</span>
              {#if !autoApprove}<PendingInvitees requests={pendingJoinRequests} onApprove={approveWaitingInvitees} />{/if}
              {#if admissionError}<p class="admission-error" role="status" data-testid="admission-error">{admissionError}</p>{/if}
              {#if error}<p class="text-sm text-[#ffaaa3]">{error}</p>{/if}
            {/if}
            </div>

            <nav class="coordinator-card-list" aria-label="Server and channel browser">
              <CoordinatorRoomCard
                pubkey={coordinatorPubkey}
                label={config.coordinatorName || "My coordinator"}
                status={localCoordinatorStatus}
                statusLabel={localCoordinatorStatusLabel}
                local
                rooms={[
                  ...hostedRooms.map((entry) => ({ room: entry.room, inviteUrl: entry.inviteUrl, removalMode: "delete" as const })),
                  ...homeJoinedRooms.map((storedRoom) => ({ room: storedRoom, inviteUrl: remoteRoomHref(storedRoom), removalMode: "leave" as const })),
                ]}
                unreadCount={coordinatorUnreadCount(coordinatorPubkey)}
                activeRoomKey={activeSidebarRoomKey}
                disabled={localRailUnavailable}
                busy={localRailBusy}
                onCreate={() => void openCreateDialog()}
                onOpen={openCoordinatorRoom}
                onRemove={(target, origin) => requestSidebarRoomRemoval(target, origin)}
              />
              {#each remoteServers as server (server.pubkey)}
                <CoordinatorRoomCard
                  pubkey={server.pubkey}
                  label={`Coordinator ${shortKey(server.pubkey)}`}
                  status={externalCoordinatorReachability(server.pubkey)}
                  statusLabel={reachabilityLabel(externalCoordinatorReachability(server.pubkey))}
                  rooms={server.rooms.map((storedRoom) => ({ room: storedRoom, inviteUrl: remoteRoomHref(storedRoom), removalMode: "leave" as const }))}
                  unreadCount={coordinatorUnreadCount(server.pubkey)}
                  activeRoomKey={activeSidebarRoomKey}
                  onOpen={openCoordinatorRoom}
                  onRemove={(target, origin) => requestSidebarRoomRemoval(target, origin)}
                />
              {/each}
            </nav>
            <SidebarHistory entries={sidebarHistory} />
          {#if !locked}<div class="sidebar-account" role="group" aria-label="Personal controls">
            <UserProfile
              {config}
              {coordinatorPubkey}
              {relayUrls}
              anonymousName={config.userName}
              onAnonymousNameChange={(name) => config.setUserName(name)}
            />
            <div class="sidebar-personal-tools">
              <PresenceControl {config} {coordinatorPubkey} {relayUrls} />
              <NotificationFeed onNavigate={navigateFromRail} />
              <NotificationCenter />
            </div>
          </div>{/if}
        </div>
      </aside>
      {/if}

      <section class="host-chat min-h-0 min-w-0 overflow-hidden bg-[#101614]" data-testid="host-chat" data-revision={revision}>
        {#if locked && !embeddedChatActive}
          <PassphrasePrompt embedded {coordinator} />
        {:else if setupRequired}
          <div class="startup-stage coordinator-setup-stage">
            <CoordinatorSetup
              {setupState}
              initialRelays={config.relays.filter((relay) => relay.enabled).map((relay) => relay.url)}
              onComplete={completeCoordinatorSetup}
            />
          </div>
        {:else if embeddedChatActive}
          {#key currentUrl}
            <ChatRoute
              embedded
              {currentUrl}
              {homeCoordinatorPubkey}
              homeCoordinatorName={config.coordinatorName}
              coordinatorStatus={coordinator.status}
              {coordinator}
              {coordinatorPubkey}
              {identityReady}
              onContextChange={handleEmbeddedChatContext}
              onRoomStored={handleEmbeddedRoomStored}
              onNavigate={navigateFromRail}
            />
          {/key}
        {:else if localRoomReady}
          {@const composerEnabled = true}
          <div class="room-pane flex h-full min-h-0 flex-col">{#if roomConnectionDetail}<p class="host-connection-banner">{roomConnectionDetail}</p>{/if}
            <RoomActionsMenu
              roomTitle={room.title}
              roomId={room.id}
              coordinatorPubkey={room.coordinatorPubkey}
              {inviteUrl}
              removalMode="delete"
              onRemove={() => roomRemovalTarget = room}
            />
            <div bind:this={messageList} class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5 sm:px-6" role="log" aria-live="polite" aria-relevant="additions" data-testid="host-message-list">
              {#if room.messages.length === 0}<div class="flex h-full items-center justify-center"><p class="max-w-sm text-center text-sm leading-6 text-[#82958a]">Your room is ready. Invite someone from the left to begin.</p></div>{/if}
              {#each groupMessageStreaks(room.messages) as streak (`${streak.sender}:${streak.messages[0].id}`)}
                <MessageGroup
                  messages={streak.messages}
                  viewerPubkey={room.stablePubkey}
                  reactionsFor={(messageId) => reactionSummary(room, messageId, room.stablePubkey)}
                  pickerOpenMessageId={reactionPickerMessageId}
                  disabled={!composerEnabled}
                  idPrefix="host"
                  onTogglePicker={(messageId) => reactionPickerMessageId = reactionPickerMessageId === messageId ? null : messageId}
                  onClosePicker={(messageId) => {
                    if (reactionPickerMessageId === messageId) reactionPickerMessageId = null;
                  }}
                  onToggleReaction={toggleReaction}
                  onSetReaction={(messageId, emoji) => setReaction(messageId, emoji, true)}
                  onJoinInvite={(sharedInvite) => navigateFromRail(createSameShellAutoJoinHref(window.location.origin, sharedInvite))}
                />
              {/each}
            </div>
            <form class="shrink-0 border-t border-[#293832] p-3 sm:p-4" onsubmit={(event) => { event.preventDefault(); void send(); }}><div class="mb-2 flex gap-1 overflow-x-auto pb-1">{#each CHAT_EMOJI_SHORTCUTS as emoji (emoji)}<button type="button" class="emoji-button" aria-label={`Add ${emoji}`} disabled={!composerEnabled} onclick={() => addEmoji(emoji)}>{emoji}</button>{/each}</div><div class="flex gap-2"><input bind:this={composerInput} bind:value={composer} class="host-input min-w-0 flex-1" disabled={!composerEnabled} placeholder={roomConnection === "offline" ? "Room offline" : roomConnection === "connecting" ? "Connecting…" : "Message as host"} /><button class="host-primary px-4 sm:px-5" disabled={!composerEnabled || !composer.trim()}>Send</button></div><p class:unavailable={!composerEnabled} class="host-composer-status">{roomConnection === "offline" ? "Cached messages are read-only while this room is offline." : roomConnection === "connecting" ? "Connecting this room…" : "Connected. Messages are end-to-end encrypted."}</p>{#if reactionError}<p class="reaction-error" role="status">{reactionError}</p>{/if}</form>
          </div>
        {:else if selectedServerIsHome && (coordinator.status !== "running" || (room && session))}
          <div class="startup-stage">
            <StartupSignalField signal={startupSignal} />
            <div class="startup-content">
              <p class="startup-kicker">Private MLS coordination</p>
              <h1>{config.coordinatorName || "My coordinator"}</h1>
              {#if coordinator.status === "starting"}
                <section
                  class="startup-progress-panel"
                  data-testid="startup-progress-panel"
                  data-recovery-state={coordinator.startupProgress.roomRecovery.state}
                  data-recovery-completed={coordinator.startupProgress.roomRecovery.completed}
                  data-recovery-total={coordinator.startupProgress.roomRecovery.total}
                  aria-label="Coordinator startup"
                >
                  <header>
                    <div>
                      <span>{coordinator.startupProgress.phase === "restoring-rooms" ? "Restoring rooms" : "Current operation"}</span>
                      <strong data-testid="startup-current-status">{coordinator.startupProgress.phase === "restoring-rooms"
                        ? coordinator.startupProgress.roomRecovery.state === "exhausted"
                          ? `Couldn’t restore # ${coordinator.startupProgress.roomRecovery.roomName}`
                          : coordinator.startupProgress.roomRecovery.state === "retrying"
                            ? `Reconnecting to # ${coordinator.startupProgress.roomRecovery.roomName}`
                            : coordinator.startupProgress.roomRecovery.total === 0
                              ? "No rooms to restore"
                              : `Restoring # ${coordinator.startupProgress.roomRecovery.roomName}`
                        : coordinator.startupProgress.label}</strong>
                    </div>
                    <StartupProgressMeter
                      targetPercent={startupPanelPercent}
                      displayValue={coordinator.startupProgress.phase === "restoring-rooms"
                        ? `${coordinator.startupProgress.roomRecovery.completed}/${coordinator.startupProgress.roomRecovery.total}`
                        : undefined}
                      retrying={coordinator.startupProgress.roomRecovery.state === "retrying"}
                      ariaLabel={coordinator.startupProgress.phase === "restoring-rooms" ? "Hosted room recovery progress" : "Coordinator startup progress"}
                      ariaValueText={coordinator.startupProgress.phase === "restoring-rooms"
                        ? `${coordinator.startupProgress.roomRecovery.completed} of ${coordinator.startupProgress.roomRecovery.total} rooms restored`
                        : `${coordinator.startupProgress.label}, step ${coordinator.startupProgress.step} of ${coordinator.startupProgress.totalSteps}`}
                    />
                  </header>
                  <footer>
                    <span role="status" aria-live="polite">{coordinator.startupProgress.phase === "restoring-rooms"
                      ? coordinator.startupProgress.roomRecovery.state === "exhausted"
                        ? `Couldn’t restore # ${coordinator.startupProgress.roomRecovery.roomName}. Check your connection, then retry recovery.`
                        : coordinator.startupProgress.roomRecovery.state === "retrying"
                          ? "Trying again…"
                          : coordinator.startupProgress.roomRecovery.diagnostic || `${coordinator.startupProgress.roomRecovery.completed} of ${coordinator.startupProgress.roomRecovery.total} rooms restored`
                      : coordinator.startupProgress.detail}</span>
                    {#if coordinator.startupProgress.phase === "restoring-rooms"}
                      <span>{coordinator.startupProgress.roomRecovery.completed} of {coordinator.startupProgress.roomRecovery.total} rooms restored</span>
                    {:else}
                      <span>{coordinator.startupProgress.step}/{coordinator.startupProgress.totalSteps}</span>
                    {/if}
                  </footer>
                  {#if coordinator.startupProgress.phase === "restoring-rooms" && coordinator.startupProgress.roomRecovery.state === "exhausted"}
                    <div class="startup-recovery-actions">
                      <button class="startup-primary" type="button" onclick={() => void coordinator.retryRoomRecovery()}>Retry recovery</button>
                      {#if exhaustedRecoveryRoom}
                        <button
                          class="startup-danger"
                          type="button"
                          onclick={(event) => requestSidebarRoomRemoval(exhaustedRecoveryRoom!, event.currentTarget)}
                        >Delete failed room</button>
                      {/if}
                    </div>
                  {/if}
                  <div class="startup-stage-actions">
                    <button type="button" onclick={openSettings}>Review settings</button>
                  </div>
                </section>
              {:else if coordinator.status === "running" && room && session}
                <section
                  class="startup-progress-panel"
                  data-testid="startup-progress-panel"
                  data-recovery-state={coordinator.startupProgress.roomRecovery.state}
                  data-recovery-completed={coordinator.startupProgress.roomRecovery.completed}
                  data-recovery-total={coordinator.startupProgress.roomRecovery.total}
                  aria-label="Opening local room"
                >
                  <header>
                    <div>
                      <span>Opening room</span>
                      <strong>Reconnecting to # {room.title}</strong>
                    </div>
                    <span class="startup-progress-value">{coordinator.startupProgress.roomRecovery.completed}/{coordinator.startupProgress.roomRecovery.total}</span>
                  </header>
                  <footer>
                    <span role="status" aria-live="polite">Opening the encrypted local room. Chat remains unavailable until it reconnects.</span>
                  </footer>
                </section>
              {:else}
                {#if guidedSetupMode && coordinator.status === "idle"}
                  <section class="guided-lifecycle" data-testid="guided-start-state">
                    <p>Coordinator offline</p>
                    <button class="guided-primary" data-testid="coordinator-start" type="button" aria-label={config.presenceState === "offline" ? "Wake" : "Start"} onclick={() => void wakeCoordinator()}>
                      <strong>{config.presenceState === "offline" ? "Wake coordinator" : "Start coordinator"}</strong>
                      <small>Open relay paths and prepare your first encrypted room.</small>
                    </button>
                    <button class="guided-secondary" type="button" onclick={openSettings}>Review settings</button>
                    {#if coordinator.profilePublicationState === "publishing"}
                      <p class="guided-publication" role="status">Coordinator name saved. Publishing its public profile…</p>
                    {:else if coordinator.profilePublicationState === "failed"}
                      <p class="guided-publication-error" role="alert">Couldn’t publish the coordinator profile. The coordinator name is saved locally and the coordinator is still running. Try again.</p>
                      <button class="guided-secondary" type="button" onclick={() => void coordinator.retryCoordinatorProfilePublication()}>Retry publishing</button>
                    {/if}
                  </section>
                {:else}
                  <p class="startup-copy">
                    {coordinator.status === "idle"
                      ? (config.presenceState === "offline" ? "Sleep mode is active and will persist after reload. Wake when you want the coordinator reachable again." : "Your identity and rooms are ready. Start when you want this coordinator reachable.")
                      : "Closing relay paths and securing coordinator state."}
                  </p>
                  <div class="startup-actions">
                    <button type="button" onclick={openSettings}>Review settings</button>
                    <button class="startup-primary" type="button" disabled={coordinator.status !== "idle"} onclick={() => void wakeCoordinator()}>
                      {coordinator.status === "stopping" ? "Stopping…" : config.presenceState === "offline" ? "Wake coordinator" : "Start coordinator"}
                    </button>
                  </div>
                  <dl class="startup-facts">
                    <div><dt>Relay paths</dt><dd>{config.enabledRelayUrls.length}</dd></div>
                    <div><dt>Identity</dt><dd>{coordinator.persistenceEnabled ? "encrypted" : "ephemeral"}</dd></div>
                    <div><dt>Autostart</dt><dd>{config.autostart ? "on" : "off"}</dd></div>
                  </dl>
                {/if}
              {/if}
            </div>
          </div>
        {:else if selectedServerRoomCount === 0}
          <div class="coordinator-empty-content empty-workspace" data-testid="coordinator-empty-content">
            {#if selectedServerIsHome}
              <span class="empty-glyph" aria-hidden="true">#</span>
              <p>Coordinator online</p>
              <h2>Ready for your first room</h2>
              <small>Open an encrypted space and invite your group.</small>
              <div class="empty-actions">
                <button class="host-primary" type="button" aria-label="Create room" onclick={() => void openCreateDialog()}>Create room</button>
                {#if firstSavedExternalCoordinatorPubkey}
                  <button type="button" aria-label="Open saved chats" onclick={() => selectCoordinator(firstSavedExternalCoordinatorPubkey)}>Open saved chats</button>
                {/if}
              </div>
              <div class="guided-invite-entry">
                <InviteRedeemer onNavigate={navigateFromRail} />
              </div>
            {:else}
              <span class="empty-glyph" aria-hidden="true">#</span>
              <p>No rooms for this coordinator</p>
              <small>You no longer have any saved rooms on this coordinator.</small>
              <div class="empty-actions">
                <button class="host-primary" type="button" onclick={() => selectCoordinator(coordinatorPubkey)}>Back to my coordinator</button>
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty-workspace">
            <span class="empty-glyph" aria-hidden="true">#</span>
            <p>Coordinator online</p>
            <h2>No channel selected</h2>
            <div class="empty-actions">
              <button type="button" onclick={openSettings}>Settings</button>
              <button class="host-primary" type="button" onclick={() => void openCreateDialog()}>Create room</button>
            </div>
          </div>
        {/if}
      </section>

      {#if !setupRequired}
      <section class="management-main" data-testid="management-interface" aria-label="Coordinator management">
        <header class="management-heading">
          <div>
            <p>Coordinator</p>
            <h1>Management</h1>
          </div>
          <div>
            <button type="button" onclick={openSettings}>Settings</button>
            <button class="management-close" type="button" onclick={toggleManagement}>Back to host</button>
          </div>
        </header>
        <div class="management-dashboard">
          <section class="management-summary" data-testid="management-summary">
            <div><span>Channels</span><strong>{hostedRooms.length}</strong></div>
            <div><span>Relay paths</span><strong>{config.enabledRelayUrls.length}</strong></div>
            <div><span>Waiting</span><strong>{pendingJoinRequests.length}</strong></div>
          </section>
          <section class="management-activity">
            <header>
              <div><p>Coordinator activity</p><span>{coordinator.debugLog.length} events</span></div>
              <button type="button" onclick={() => coordinator.clearDebugLog()}>Clear</button>
            </header>
            <div class="management-log" role="log" aria-label="Coordinator activity">
              {#if coordinator.debugLog.length === 0}
                <p class="management-empty">No activity yet.</p>
              {:else}
                <ol data-testid="management-log-entries">
                  {#each coordinator.debugLog as entry (entry.id)}
                    <li><time>{entry.timeLabel}</time><span class={`level ${entry.level}`}>{entry.level}</span><p>{entry.message}{#if entry.details}<small>{entry.details}</small>{/if}</p></li>
                  {/each}
                </ol>
              {/if}
            </div>
          </section>
        </div>
      </section>
      {/if}
    </div>

    {#if settingsDialogOpen}
      <CoordinatorSettings
        {coordinator}
        {config}
        {identity}
        onClose={() => { config.exitEdit(); settingsDialogOpen = false; }}
      />
    {/if}

    {#if createDialogOpen}
      <div class="share-overlay" data-testid="create-room-dialog">
        <button class="share-backdrop" type="button" aria-label="Close create room dialog" onclick={closeCreateDialog}></button>
        <div
          class="create-room-dialog share-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-room-dialog-title"
        >
          <form onsubmit={(event) => { event.preventDefault(); void createInvite(); }}>
            <header class="share-dialog-header">
              <div>
                <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7cf59d]">New channel</p>
                <h2 id="create-room-dialog-title" class="mt-1 text-xl font-semibold text-white">Create a room</h2>
              </div>
              <button class="share-close" type="button" aria-label="Close create room dialog" onclick={closeCreateDialog}>×</button>
            </header>
            <div class="create-room-content">
              <label class="block text-sm text-[#cfe2d4]">
                Room name
                <input bind:this={roomNameInput} bind:value={title} class="host-input mt-2" placeholder="Friday plans" />
              </label>
              <label class="create-room-option">
                <input
                  type="checkbox"
                  checked={newRoomAutoApprove}
                  onchange={(event) => newRoomAutoApprove = (event.currentTarget as HTMLInputElement).checked}
                  aria-label="Auto-approve invitees"
                  class="mt-0.5 h-4 w-4 accent-[#7cf59d]"
                />
                <span>
                  <strong>Auto-approve invitees</strong>
                  <small>Enabled by default. Turn off to admit guests manually.</small>
                </span>
              </label>
              {#if !coordinator.persistenceEnabled}
                <p class="coordinator-key-warning" data-testid="ephemeral-coordinator-warning">This coordinator uses a temporary key. Reloading creates a new identity and moves this room to Previous local sessions. Save the coordinator key in Settings to keep hosting it across reloads.</p>
              {/if}
              {#if relayUrls.length === 0}<p class="text-xs text-[#ffaaa3]">Add an enabled relay before starting a room.</p>{/if}
              {#if error}<p class="text-xs text-[#ffaaa3]">{error}</p>{/if}
            </div>
            <footer class="create-room-actions">
              <button class="host-secondary" type="button" disabled={busy} onclick={closeCreateDialog}>Cancel</button>
              <button class="host-primary" type="submit" disabled={busy || relayUrls.length === 0 || title.trim().length === 0}>{busy ? "Creating…" : "Create room"}</button>
            </footer>
          </form>
        </div>
      </div>
    {/if}

    {#if inviteDialogOpen && room}
      <div class="share-overlay" data-testid="invite-dialog">
        <button class="share-backdrop" type="button" aria-label="Close invite dialog" onclick={closeInviteDialog}></button>
        <div class:qr-expanded={inviteQrExpanded} class="share-dialog invite-dialog" role="dialog" aria-modal="true" aria-labelledby="invite-dialog-title">
          <header class="share-dialog-header invite-dialog-header">
            <div class="min-w-0">
              <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7cf59d]">Invite</p>
              <h2 id="invite-dialog-title" class="mt-1 truncate text-xl font-semibold text-white"># {room.title}</h2>
            </div>
            <button class="share-close" type="button" aria-label="Close invite dialog" onclick={closeInviteDialog}>×</button>
          </header>
          <div class="share-dialog-body">
            <div class="share-dialog-content invite-dialog-content">
              <section class="invite-qr-section" aria-labelledby="invite-qr-label">
                <div class="invite-qr-heading">
                  <p id="invite-qr-label" class="invite-section-label">Scan</p>
                  <button
                    type="button"
                    class="invite-qr-expand"
                    aria-pressed={inviteQrExpanded}
                    aria-label={inviteQrExpanded ? "Restore QR code size" : "Enlarge QR code"}
                    onclick={() => inviteQrExpanded = !inviteQrExpanded}
                  >{inviteQrExpanded ? "Restore" : "Enlarge"}</button>
                </div>
                <a href={inviteUrl} aria-label="Open room invite" class="share-qr">
                  {#key inviteUrl}<img src={qrUrl} alt={`QR code to join ${room.title}`} />{/key}
                </a>
              </section>
              <div class="invite-details" aria-label="Invite details">
                <div class="invite-detail invite-detail-primary">
                  <div class="invite-detail-heading">
                    <span>Invite link</span>
                    <div class="invite-detail-actions">
                      <button type="button" aria-label="Copy invite link" onclick={copy}>{copyState === "copied" ? "Copied" : "Copy"}</button>
                      <button class="invite-refresh" type="button" aria-label="Refresh invite link" title="Replace the current invite link" disabled={refreshState === "refreshing"} onclick={() => void refreshInviteLink()}>
                        {refreshState === "refreshing" ? "…" : "↻"}
                      </button>
                    </div>
                  </div>
                  <code>{inviteUrl}</code>
                </div>
                <div class="invite-detail">
                  <div class="invite-detail-heading">
                    <span>Coordinator pubkey</span>
                    <button type="button" aria-label="Copy coordinator pubkey" onclick={() => void copyInviteDetail(room.coordinatorPubkey, "coordinator")}>{detailCopyState === "coordinator" ? "Copied" : "Copy"}</button>
                  </div>
                  <code>{room.coordinatorPubkey}</code>
                </div>
                {#if !coordinator.persistenceEnabled}
                  <p class="invite-warning" data-testid="ephemeral-invite-warning">Temporary host key — this invite changes after a reload.</p>
                {/if}
                <p class:refreshed={refreshState === "refreshed"} class="refresh-guidance" aria-live="polite">
                  {refreshState === "refreshed" ? "New invite ready. Previous links are closed." : ""}
                </p>
              </div>
            </div>
            <section class="invite-in-app" aria-label="In-app invites">
              <OnlineInvitePicker {inviteUrl} roomTitle={room.title} />
            </section>
          </div>
        </div>
      </div>
    {/if}

    {#if roomRemovalTarget}
      <RoomRemovalDialog
        mode={roomRemovalMode}
        roomTitle={roomRemovalTarget.title}
        hostLabel={hostIdentityForRoom(roomRemovalTarget).name}
        coordinatorLabel={coordinatorLabelFor(roomRemovalTarget.coordinatorPubkey)}
        messageCount={roomRemovalTarget.messages.length}
        pendingInviteCount={pendingJoinRequests.length}
        onConfirm={removeCurrentStoredRoom}
        onClose={closeRoomRemovalDialog}
      />
    {/if}
  </div>
</main>

<style>
  .host-workspace { max-width: 100vw; overflow: hidden; background: rgb(7 12 9 / .8); }
  .host-workspace > .host-topbar, .host-workspace > .host-layout { transition: filter .18s ease, opacity .18s ease; }
  .host-workspace.dialog-open > .host-topbar, .host-workspace.dialog-open > .host-layout { filter: blur(2px); opacity: .72; }
  .host-topbar { position: relative; z-index: 40; align-items: stretch; border-bottom: 1px solid #21352a; background: rgb(10 16 12 / .94); padding-block: 0; }
  .host-topbar :global(.workspace-nav) { min-height: 3.6rem; padding-block: .55rem; }
  .host-commandbar { position: relative; display: flex; width: auto; min-width: 0; flex: 0 1 auto; align-items: stretch; justify-content: flex-end; background: transparent; }
  .global-sound-toggle { display: grid; width: 2.75rem; min-height: 2.65rem; place-items: center; border: 0; background: transparent; color: #64756c; transition: background .15s ease, color .15s ease, transform .15s ease; }
  .global-sound-toggle svg { width: 1.18rem; height: 1.18rem; fill: currentColor; }
  .global-sound-toggle svg path + path { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .global-sound-toggle:hover { background: #101713; color: #bdebc8; transform: translateY(-1px); }
  .global-sound-toggle.enabled { color: #7cf59d; }
  .host-utilities { display: flex; min-width: 0; align-items: stretch; gap: .12rem; }
  .command-cluster { display: flex; min-width: 0; align-items: stretch; gap: .08rem; }
  .command-cluster-label { display: none; align-items: center; padding: 0 .42rem; color: #617268; font-size: .46rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .command-cluster-divider { width: 1px; height: 1.55rem; align-self: center; margin: 0 .28rem; background: #2b3c31; }
  .mobile-rail-toggle, .mobile-tools-toggle, .mobile-tools-scrim, .mobile-rail-scrim { display: none; }
  .host-commandbar :global(.notification-feed), .host-commandbar :global(.notification-center), .host-commandbar :global(.user-profile) { border: 0; }
  .host-commandbar :global(.notification-feed-trigger), .host-commandbar :global(.notification-trigger), .host-commandbar :global(.user-trigger) { border: 0; background: transparent; }
  .host-commandbar :global(.notification-feed-trigger:hover), .host-commandbar :global(.notification-feed-trigger[aria-expanded="true"]), .host-commandbar :global(.notification-trigger:hover), .host-commandbar :global(.notification-trigger[aria-expanded="true"]), .host-commandbar :global(.user-trigger:hover), .host-commandbar :global(.user-trigger[aria-expanded="true"]) { background: #101713; }
  .host-commandbar :global(.compact-controls) { height: 2.65rem; gap: .08rem; border: 0; background: transparent; padding: .2rem .16rem; }
  .host-commandbar :global(.lifecycle-status) { border: 0; padding-inline: .55rem; }
  .host-layout { position: relative; width: 100%; max-width: 100%; overflow: hidden; grid-template-columns: minmax(18rem, 22rem) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .host-layout.setup-required { grid-template-columns: minmax(0, 1fr); }
  .host-chat { position: relative; width: 100%; height: 100%; max-width: 100%; }
  .host-layout:not(.management-open) .management-main { display: none; }
  .host-layout.management-open { grid-template-columns: minmax(21rem, 28rem) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .host-layout.management-open .host-chat { display: none; }
  .manage-toggle { display: grid; height: 2.65rem; place-items: center; border: 0; padding: 0 .85rem; background: transparent; color: #a7b9ad; font-size: .6rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
  .header-manage { height: auto; min-height: 3.6rem; border-left: 1px solid #293832; padding-inline: 1.15rem; }
  .manage-toggle:hover, .manage-toggle.active { background: #7cf59d; color: #071009; }
  .settings-button { position: relative; display: flex; height: 2.65rem; align-items: center; gap: .45rem; border: 0; padding: 0 .65rem; color: #91a59a; font-size: .62rem; }
  .settings-button:hover, .settings-button.pending { background: #101713; color: #dfffe7; }
  .settings-pip { position: absolute; top: .35rem; right: .35rem; width: .4rem; height: .4rem; border-radius: 999px; background: #e4e78d; box-shadow: 0 0 8px rgb(228 231 141 / .4); }
  .host-rail { background: #0d1310; }
  .host-rail > div { gap: .75rem; }
  .rail-join { flex: 0 0 auto; border: 1px solid #293832; }
  .coordinator-runtime-stack { display: grid; gap: 0; }
  .coordinator-runtime-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; border: 1px solid #293832; background: #0b120d; }
  .coordinator-runtime-stack > .room-tools { margin-top: -1px; }
  .coordinator-runtime-copy { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .6rem; padding: .65rem .7rem; }
  .coordinator-runtime-copy > span:last-child, .coordinator-runtime-copy strong, .coordinator-runtime-copy small { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .coordinator-runtime-copy strong { color: #dfffe7; font-size: .7rem; font-weight: 650; }
  .coordinator-runtime-copy small { margin-top: .18rem; color: #718277; font-size: .5rem; text-transform: capitalize; }
  .coordinator-card-list { display: grid; gap: .5rem; }
  .host-input { width: 100%; border: 1px solid #34433b; background: #090d0b; padding: .7rem .8rem; color: #effff2; outline: none; }
  .host-input:focus { border-color: #7cf59d; box-shadow: 0 0 0 2px rgb(124 245 157 / .11); }
  .host-input:disabled { cursor: not-allowed; border-color: #26322c; color: #64766b; opacity: .72; }
  .host-primary { border: 1px solid #7cf59d; background: #7cf59d; padding: .72rem 1rem; color: #08110b; font-weight: 650; }
  .host-primary:hover { border-color: #c5ffcf; background: #c5ffcf; }
  .host-primary:disabled { cursor: not-allowed; opacity: .45; }
  .admission-error { margin-top: .4rem; color: #ffaaa3; font-size: .72rem; line-height: 1.4; }
  .host-secondary { border: 1px solid #496451; padding: .55rem .7rem; color: #c6eccc; font-size: .75rem; }
  .host-secondary:hover { border-color: #7cf59d; }
  .channel-browser { overflow: hidden; border: 1px solid #293832; background: #090e0b; }
  .channel-context { border-bottom: 1px solid #293832; background: #0b120d; }
  .channel-context-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  .coordinator-actions { display: flex; min-width: 0; align-items: stretch; border-left: 1px solid #202d25; }
  .coordinator-actions :global(.compact-controls) { min-height: 100%; }
  .coordinator-actions :global(.lifecycle-action), .coordinator-actions :global(.destroy-action), .coordinator-actions .channel-settings { width: 2.4rem; height: 100%; min-height: 3.65rem; }
  .coordinator-actions :global(.lifecycle-action:hover:not(:disabled)), .coordinator-actions :global(.destroy-action:hover), .coordinator-actions .channel-settings:hover { background: #17241b; }
  .channel-context-button { display: grid; width: 100%; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: .6rem; padding: .72rem .55rem .72rem .75rem; color: #dfffe7; text-align: left; }
  .channel-context-button:hover, .channel-context-button[aria-expanded="true"] { background: #111a14; }
  .channel-context-copy, .channel-context-copy strong, .channel-context-copy small { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .channel-context-copy strong { color: #dfffe7; font-size: .72rem; font-weight: 650; }
  .channel-context-copy small { margin-top: .22rem; color: #718277; font-size: .5rem; font-weight: 500; text-transform: capitalize; }
  .rail-ready-control { animation: rail-control-reveal .32s cubic-bezier(.2, .8, .2, 1) both; }
  .rail-ready-settings, .rail-ready-count { animation-delay: .04s; }
  .rail-ready-create { animation-delay: .09s; }
  .rail-ready-room-meta { animation-delay: .14s; }
  .rail-ready-room-actions { display: block; animation-name: rail-control-fade; animation-delay: .19s; }
  .rail-ready-tools { animation-delay: .24s; }
  .channel-count { display: grid; min-width: 1.25rem; height: 1.25rem; place-items: center; background: #17241b; color: #9bf6b3; font-size: .58rem; font-weight: 500; }
  .channel-chevron { color: #82958a; font-size: .58rem; }
  .channel-settings { position: relative; display: grid; width: 2.65rem; place-items: center; color: #718277; }
  .channel-settings:hover, .channel-settings.pending { background: #111a14; color: #dfffe7; }
  .channel-settings-pip { position: absolute; top: .5rem; right: .45rem; width: .35rem; height: .35rem; border-radius: 999px; background: #e4e78d; box-shadow: 0 0 7px rgb(228 231 141 / .4); }
  .channel-server-menu { display: grid; gap: .15rem; border-top: 1px solid #293832; padding: .35rem; background: #070c09; }
  .channel-server-menu > button { display: grid; width: 100%; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .6rem; border: 1px solid transparent; padding: .55rem .6rem; color: #91a59a; text-align: left; }
  .channel-server-menu > button:hover, .channel-server-menu > button.active { background: #17241b; color: #effff2; }
  .channel-server-menu strong, .channel-server-menu small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .channel-server-menu strong { font-size: .65rem; font-weight: 600; }
  .channel-server-menu small { margin-top: .18rem; color: #73867a; font-size: .52rem; }
  .channel-server-menu > button > span:last-child { color: #91a59a; font-size: .58rem; }
  .channel-server-group-label { margin: .35rem .6rem .05rem; color: #a5a66f; font-size: .48rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .channel-browser-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #202d25; padding: .5rem .55rem .5rem .75rem; color: #728378; font-size: .58rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .channel-browser-header button { display: grid; width: 1.6rem; height: 1.6rem; place-items: center; color: #82958a; font-size: .85rem; }
  .channel-browser-header button:hover { background: #17241b; color: #7cf59d; }
  .channel-browser-header button:disabled { cursor: not-allowed; opacity: .25; }
  .channel-server-dot { width: .38rem; height: .38rem; flex: 0 0 auto; border-radius: 999px; background: #39473f; box-shadow: none; }
  .channel-server-dot.online { background: #7cf59d; box-shadow: 0 0 0 3px rgb(124 245 157 / .07), 0 0 8px rgb(124 245 157 / .3); }
  .channel-server-dot.connecting { background: #d4bc69; box-shadow: 0 0 7px rgb(212 188 105 / .2); animation: coordinator-status-pulse 1.5s ease-in-out infinite; }
  .channel-server-dot.offline { background: #59675f; box-shadow: none; }
  .channel-server-dot.unknown { background: #344139; box-shadow: none; }
  .channel-list { display: grid; gap: .12rem; padding: .35rem; }
  .channel-empty-state { display: grid; gap: .45rem; padding: .9rem .85rem 1rem; color: #82958a; }
  .channel-empty-state strong { color: #dfffe7; font-size: .72rem; font-weight: 650; }
  .channel-empty-state span { font-size: .62rem; line-height: 1.5; }
  .channel-empty-state button { min-height: 2.75rem; margin-top: .25rem; border: 1px solid #405348; color: #cfe8d5; font-size: .65rem; }
  .channel-empty-state button:hover:not(:disabled), .channel-empty-state button:focus-visible { border-color: #7cf59d; color: #effff2; outline: none; }
  .channel-empty-state button:disabled { cursor: default; opacity: .45; }
  .channel-loading-placeholder { min-height: 1.35rem; background: linear-gradient(90deg, transparent, rgb(124 245 157 / .025), transparent); }
  .sidebar-account { position: sticky; z-index: 4; bottom: 0; display: grid; margin-top: auto; border-top: 1px solid #293832; background: rgb(8 13 10 / .98); box-shadow: 0 -16px 28px rgb(0 0 0 / .18); }
  .sidebar-account :global(.user-profile), .sidebar-account :global(.user-trigger) { width: 100%; min-width: 0; }
  .sidebar-account :global(.user-trigger) { height: auto; min-height: 3.25rem; border: 0; padding: .5rem .65rem; }
  .sidebar-account :global(.user-copy) { display: block; }
  .sidebar-account :global(.user-copy strong) { max-width: none; }
  .sidebar-personal-tools { display: grid; grid-template-columns: minmax(5.5rem, .8fr) 2.75rem minmax(7.5rem, 1.2fr); border-top: 1px solid #202d25; }
  .sidebar-personal-tools :global(.presence-control), .sidebar-personal-tools :global(.notification-feed), .sidebar-personal-tools :global(.notification-center), .sidebar-personal-tools :global(.notification-trigger) { width: 100%; min-width: 0; }
  .sidebar-personal-tools :global(.notification-feed-trigger), .sidebar-personal-tools :global(.notification-trigger) { height: 2.75rem; border: 0; background: transparent; }
  .sidebar-personal-tools :global(.notification-feed-trigger) { width: 2.75rem; border-inline: 1px solid #202d25; }
  .sidebar-personal-tools :global(.notification-trigger) { justify-content: flex-start; padding-inline: .65rem; }
  .sidebar-account :global(.user-menu) { top: auto; right: auto; bottom: calc(100% + .5rem); left: 0; box-sizing: border-box; width: min(22rem, calc(100vw - 1rem)); max-height: min(38rem, calc(100dvh - 5rem)); overflow-y: auto; overscroll-behavior: contain; }
  .sidebar-account :global(.presence-menu), .sidebar-account :global(.notification-feed-panel), .sidebar-account :global(.notification-menu) { top: auto; bottom: calc(100% + .5rem); }
  .channel-empty { display: flex; width: 100%; align-items: center; justify-content: space-between; border: 1px dashed #293832; padding: .65rem .7rem; color: #82958a; text-align: left; font-size: .68rem; }
  .channel-empty:hover { border-color: #7cf59d; color: #dfffe7; }
  .channel-empty:disabled { cursor: default; border-color: #202d25; color: #546159; opacity: .65; }
  .coordinator-empty-content { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; color: #82958a; }
  .coordinator-empty-content small { max-width: 27rem; margin-top: .55rem; font-size: .7rem; line-height: 1.6; }
  .coordinator-empty-content .empty-actions { margin-top: 1.15rem; }
  .coordinator-empty-content .host-primary { min-width: 9.5rem; min-height: 2.75rem; }
  .channel-previous-guidance, .coordinator-key-warning { margin: .35rem .7rem .15rem; color: #d9d68e; font-size: .58rem; line-height: 1.5; }
  .channel-row { position: relative; display: grid; width: 100%; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; border: 1px solid transparent; color: #91a59a; text-align: left; font-size: .72rem; }
  .unread-badge { display: inline-flex; min-width: 1rem; height: 1rem; align-items: center; justify-content: center; padding: 0 .25rem; border: 1px solid #3b5943; border-radius: 2px; background: #102216; color: #bfeac8; font-size: .58rem; font-variant-numeric: tabular-nums; line-height: 1; }
  .channel-row-primary { display: grid; min-width: 0; grid-template-columns: .15rem auto minmax(0, 1fr) auto; align-items: center; gap: .55rem; padding: .55rem .2rem; color: inherit; text-align: left; }
  .channel-name-with-preferences { display: flex; min-width: 0; align-items: center; gap: .35rem; }
  .channel-name-with-preferences .truncate { min-width: 0; flex: 0 1 auto; }
  .channel-owner-avatar { display: inline-grid; opacity: 0; transition: opacity .15s ease; }
  .channel-row:hover .channel-owner-avatar, .channel-row:focus-within .channel-owner-avatar { opacity: .72; }
  .channel-row.unavailable { grid-template-columns: minmax(0, 1fr); color: #728378; }
  .channel-row.unavailable .channel-row-primary { cursor: default; grid-template-columns: .15rem auto minmax(0, 1fr); }
  .channel-row.unavailable.busy .channel-row-primary { cursor: progress; }
  .channel-row.unavailable .channel-row-primary:disabled { opacity: .72; }
  .channel-row:hover, .channel-row:focus-within { background: #111a14; color: #dfffe7; }
  .channel-row.unavailable:hover, .channel-row.unavailable:focus-within { background: transparent; color: #728378; }
  .channel-row.active { background: #17241b; color: #effff2; }
  .channel-active-mark { align-self: stretch; border-radius: 0 2px 2px 0; background: transparent; }
  .channel-row.active .channel-active-mark { background: #7cf59d; box-shadow: 0 0 10px rgb(124 245 157 / .25); }
  .channel-hash { color: #52675a; font-size: .85rem; }
  .channel-row.active .channel-hash { color: #9bf6b3; }
  .channel-live { color: #7cf59d; font-size: .5rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .channel-remote { color: #9c8050; font-size: .48rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .room-tools { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid #293832; background: #0a100c; }
  .room-tools > button + button { border-left: 1px solid #293832; }
  .room-tools > button { min-width: 0; }
  .share-trigger { display: flex; width: 100%; align-items: center; justify-content: space-between; background: #0a100c; padding: .62rem .65rem; color: #bfeac8; font-size: .65rem; font-weight: 650; }
  .share-trigger:hover { border-color: #7cf59d; background: #101a13; }
  .share-trigger > span:last-child { color: #7cf59d; }
  .room-access-toggle { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: .3rem; padding: .62rem .55rem; color: #91a59a; font-size: .58rem; }
  .room-access-toggle strong { color: #82958a; font-size: .48rem; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
  .room-access-toggle:hover { background: #101713; color: #dfffe7; }
  .room-access-toggle.enabled { color: #c6eccc; }
  .room-access-toggle.enabled strong { color: #7cf59d; }
  @keyframes rail-control-reveal {
    from { opacity: 0; transform: translateY(-.18rem); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes rail-control-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .management-main { min-width: 0; min-height: 0; overflow: hidden; background: #101614; }
  .management-heading { display: flex; min-height: 5.4rem; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #293832; padding: 1rem 1.25rem; background: #0c120f; }
  .management-heading p { color: #7cf59d; font-size: .56rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  .management-heading h1 { margin-top: .35rem; color: #f0fff3; font-size: 1.25rem; font-weight: 650; }
  .management-heading > div:last-child { display: flex; gap: .5rem; }
  .management-heading button { border: 1px solid #405748; padding: .6rem .75rem; color: #b9cbbf; font-size: .64rem; }
  .management-heading button:hover { border-color: #7cf59d; color: #dfffe7; }
  .management-heading .management-close { border-color: #7cf59d; background: #7cf59d; color: #071009; font-weight: 700; }
  .management-dashboard { display: grid; height: calc(100% - 5.4rem); min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
  .management-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; border-bottom: 1px solid #293832; background: #293832; }
  .management-summary > div { min-width: 0; background: #0c120f; padding: 1rem 1.1rem; }
  .management-summary span, .management-summary strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .management-summary span { color: #718277; font-size: .54rem; letter-spacing: .12em; text-transform: uppercase; }
  .management-summary strong { margin-top: .45rem; color: #dfffe7; font-size: .9rem; font-weight: 600; text-transform: capitalize; }
  .management-activity { display: grid; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
  .management-activity > header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #293832; padding: .8rem 1.1rem; }
  .management-activity > header p { color: #dfffe7; font-size: .68rem; font-weight: 650; }
  .management-activity > header span { display: block; margin-top: .2rem; color: #718277; font-size: .52rem; }
  .management-activity > header button { border: 1px solid #34483a; padding: .4rem .55rem; color: #91a59a; font-size: .56rem; }
  .management-activity > header button:hover { border-color: #7cf59d; color: #dfffe7; }
  .management-log { min-height: 0; overflow-y: auto; }
  .management-log ol { display: grid; }
  .management-log li { display: grid; grid-template-columns: 5rem 3.5rem minmax(0, 1fr); gap: .75rem; border-bottom: 1px solid #1d2a23; padding: .7rem 1.1rem; color: #b9cbbf; font-size: .62rem; }
  .management-log time { color: #64766b; font-variant-numeric: tabular-nums; }
  .management-log .level { color: #7cf59d; font-size: .52rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .management-log .level.warn { color: #e4e78d; }
  .management-log .level.error { color: #ffaaa3; }
  .management-log li p { min-width: 0; overflow-wrap: anywhere; }
  .management-log li small { display: block; margin-top: .25rem; color: #718277; line-height: 1.5; }
  .management-empty { padding: 2rem; color: #718277; font-size: .65rem; }
  .share-overlay { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 1rem; }
  .share-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: rgb(2 7 4 / .72); cursor: default; backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
  .share-dialog { position: relative; z-index: 1; width: min(46rem, 100%); max-height: calc(100dvh - 2rem); overflow-y: auto; border: 1px solid #52705b; background: #09100c; box-shadow: 0 28px 90px rgb(0 0 0 / .72); }
  .share-dialog-body { min-height: 0; }
  .share-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #293832; padding: 1rem 1.1rem; }
  .share-close { display: grid; width: 2rem; height: 2rem; flex: 0 0 auto; place-items: center; border: 1px solid #34483a; color: #91a59a; font-size: 1.15rem; line-height: 1; }
  .share-close:hover { border-color: #7cf59d; color: white; }
  .create-room-dialog { width: min(32rem, 100%); }
  .create-room-content { display: grid; gap: 1rem; padding: 1.1rem; }
  .create-room-option { display: flex; cursor: pointer; align-items: flex-start; gap: .75rem; border: 1px solid #293832; background: #0b0e0d; padding: .85rem; color: #b9cbbf; font-size: .78rem; }
  .create-room-option strong, .create-room-option small { display: block; }
  .create-room-option strong { color: #e8f5eb; font-weight: 500; }
  .create-room-option small { margin-top: .3rem; color: #82958a; font-size: .68rem; line-height: 1.5; }
  .create-room-actions { display: flex; justify-content: flex-end; gap: .6rem; border-top: 1px solid #293832; padding: .85rem 1.1rem; }
  .share-dialog-content { display: grid; gap: 1.25rem; padding: 1.1rem; }
  .invite-dialog { width: min(50rem, 100%); border: 0; background: #09100c; }
  .invite-dialog-header { border-bottom: 0; padding: 1.15rem 1.3rem .55rem; }
  .invite-dialog-header .share-close { border: 0; background: transparent; }
  .invite-dialog-content { align-items: start; gap: 1.6rem; padding: .8rem 1.3rem 1.3rem; }
  .invite-qr-section { display: grid; justify-items: center; gap: .55rem; }
  .invite-qr-heading { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 1rem; }
  .invite-section-label { justify-self: start; color: #718277; font-size: .54rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .invite-qr-expand { border: 1px solid #34483a; padding: .28rem .48rem; color: #9bf6b3; font-size: .52rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .invite-qr-expand:hover, .invite-qr-expand:focus-visible { border-color: #7cf59d; background: #142018; color: #effff2; outline: none; }
  .share-qr { display: block; width: min(21rem, 100%); margin-inline: auto; border: .5rem solid #dfffe7; background: #dfffe7; }
  .share-qr img { display: block; width: 100%; aspect-ratio: 1; }
  .invite-details { display: grid; min-width: 0; }
  .invite-detail { display: grid; min-width: 0; gap: .28rem; padding: .8rem .1rem; border-top: 1px solid rgb(82 112 91 / .35); }
  .invite-detail:first-child { border-top: 0; padding-top: 0; }
  .invite-detail-heading { display: flex; align-items: center; justify-content: space-between; gap: .8rem; color: #dfffe7; font-size: .65rem; font-weight: 650; }
  .invite-detail-heading button { flex: 0 0 auto; border: 0; padding: .2rem .3rem; color: #7cf59d; font-size: .55rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .invite-detail-heading button:hover, .invite-detail-heading button:focus-visible { background: #142018; color: #effff2; outline: none; }
  .invite-detail-actions { display: flex; align-items: center; gap: .25rem; }
  .invite-detail-heading .invite-refresh { width: 1.55rem; height: 1.55rem; padding: 0; border-radius: 50%; color: #91a59a; font-size: .85rem; }
  .invite-detail-heading .invite-refresh:disabled { cursor: wait; opacity: .55; }
  .invite-detail code { display: -webkit-box; overflow: hidden; color: #91a59a; font-size: .56rem; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .invite-warning { margin-top: .55rem; color: #d5b26d; font-size: .56rem; line-height: 1.5; }
  .invite-in-app { margin: 0 1.3rem 1.15rem; padding-top: .2rem; }
  .refresh-guidance { min-height: .85rem; color: #718277; font-size: .55rem; line-height: 1.5; }
  .refresh-guidance.refreshed { color: #9bf6b3; }
  .share-qr img { animation: qr-refresh .24s ease-out; }
  .invite-dialog.qr-expanded { display: grid; width: calc(100vw - 2rem); height: calc(100dvh - 2rem); max-width: none; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
  .invite-dialog.qr-expanded .share-dialog-body { display: grid; min-height: 0; overflow: hidden; }
  .invite-dialog.qr-expanded .invite-dialog-content { display: grid; min-height: 0; height: 100%; grid-template-columns: minmax(0, 1fr); place-items: stretch; overflow: hidden; padding: 1rem; }
  .invite-dialog.qr-expanded .invite-qr-section { display: grid; width: 100%; min-height: 0; height: 100%; grid-template-rows: auto minmax(0, 1fr); align-items: stretch; }
  .invite-dialog.qr-expanded .invite-qr-heading { width: 100%; }
  .invite-dialog.qr-expanded .share-qr { width: auto; height: 100%; max-width: 100%; max-height: 100%; aspect-ratio: 1; box-sizing: border-box; }
  .invite-dialog.qr-expanded .share-qr img { width: 100%; height: 100%; }
  .invite-dialog.qr-expanded .invite-details, .invite-dialog.qr-expanded .invite-in-app { display: none; }
  .emoji-button { flex: 0 0 auto; border: 1px solid #293832; background: #0b0e0d; padding: .2rem .4rem; font-size: .9rem; line-height: 1; }
  .emoji-button:hover { border-color: #7cf59d; background: #112219; }
  .emoji-button:disabled { cursor: not-allowed; opacity: .28; }
  .host-connection-banner { flex: 0 0 auto; border-bottom: 1px solid #293832; background: #111814; padding: .65rem 1rem; color: #a9bbb0; font-size: .7rem; line-height: 1.5; }
  .host-connection-banner.offline { border-bottom-color: #604326; background: #21170f; color: #ffc17d; }
  .host-composer-status { margin-top: .5rem; color: #7ca087; text-align: center; font-size: .65rem; }
  .host-composer-status.unavailable { color: #a98b69; }
  .room-pane { position: relative; }
  .reaction-error { margin-top: .45rem; color: #ffaaa3; font-size: .65rem; }
  .startup-stage { position: absolute; z-index: 1; inset: 0; display: grid; width: 100%; height: 100%; place-items: center; overflow: hidden; padding: 16px; background: #101614; }
  .startup-content { position: relative; z-index: 1; width: min(512px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow-y: auto; overscroll-behavior: contain; text-align: center; }
  .startup-kicker { margin-top: 24px; color: #66786d; font-size: 12px; font-weight: 600; line-height: 1.2; letter-spacing: .2em; text-transform: uppercase; }
  .startup-content h1 { margin-top: 8px; color: #f3fff6; font-size: 48px; font-weight: 600; line-height: 1.1; letter-spacing: -.035em; }
  .startup-copy { max-width: 512px; margin: 16px auto 0; color: #91a59a; font-size: 14px; font-weight: 400; line-height: 1.5; }
  .startup-progress-panel { width: min(448px, 100%); margin: 1.25rem auto 0; background: rgb(8 14 10 / .82); padding: .8rem .9rem; text-align: left; backdrop-filter: blur(8px); }
  .startup-progress-panel header { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; align-items: flex-start; gap: 0 1rem; }
  .startup-progress-panel header > div { min-width: 0; }
  .startup-progress-panel header span, .startup-progress-panel header strong { display: block; overflow-wrap: anywhere; }
  .startup-progress-panel header span { color: #66786d; font-size: .48rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .startup-progress-panel header strong { margin-top: .28rem; color: #e8f5eb; font-size: .72rem; font-weight: 650; }
  .startup-progress-value.error { color: #ffaaa3; }
  .startup-progress-panel footer { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 1rem; margin-top: .55rem; color: #82958a; font-size: .54rem; line-height: 1.45; }
  .startup-progress-panel footer > span:first-child { min-width: 0; }
  .startup-progress-panel footer > span:last-child { flex: 0 0 auto; color: #687a6f; font-variant-numeric: tabular-nums; }
  .startup-recovery-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .45rem; margin-top: .75rem; }
  .startup-recovery-actions button { border: 1px solid #496451; padding: .55rem .7rem; color: #c6d7cb; font-size: .6rem; }
  .startup-recovery-actions button:hover, .startup-recovery-actions button:focus-visible { border-color: #7cf59d; color: #effff2; outline: none; }
  .startup-recovery-actions .startup-primary { border-color: #7cf59d; background: #7cf59d; color: #071009; font-weight: 650; }
  .startup-recovery-actions .startup-danger { border-color: #6d413d; color: #ffaaa3; }
  .startup-recovery-actions .startup-danger:hover, .startup-recovery-actions .startup-danger:focus-visible { border-color: #ff8f86; background: #21110f; color: #ffd5d1; }
  .startup-stage-actions { display: flex; justify-content: center; margin-top: .75rem; }
  .startup-stage-actions button { border: 1px solid #496451; background: rgb(8 14 10 / .78); padding: .55rem .7rem; color: #c6d7cb; font-size: .6rem; }
  .startup-stage-actions button:hover, .startup-stage-actions button:focus-visible { border-color: #7cf59d; color: #effff2; outline: none; }
  .startup-actions { display: flex; justify-content: center; gap: 8px; margin-top: 24px; }
  .startup-actions button { border: 1px solid #496451; background: rgb(8 14 10 / .78); padding: 12px 16px; color: #c6d7cb; font-size: 14px; font-weight: 600; line-height: 1.2; backdrop-filter: blur(8px); }
  .startup-actions button:hover:not(:disabled) { border-color: #5d7564; color: #effff2; }
  .startup-actions button:focus-visible { border-color: #7cf59d; outline: 2px solid #7cf59d; outline-offset: 4px; }
  .startup-actions .startup-primary { border-color: #496451; background: #1a2820; color: #e8f5eb; font-weight: 600; }
  .startup-actions button:disabled { cursor: wait; opacity: .58; }
  .guided-lifecycle { display: grid; width: min(34rem, 100%); justify-items: center; gap: .75rem; margin: 1.5rem auto 0; }
  .guided-lifecycle > p { color: #7cf59d; font-size: .58rem; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; }
  .guided-primary { display: grid; width: min(34rem, 100%); min-height: 7rem; place-content: center; gap: .45rem; border: 1px solid #7cf59d; background: #7cf59d; padding: 1.25rem 1.5rem; color: #071009; text-align: center; box-shadow: 0 0 36px rgb(124 245 157 / .08); }
  .guided-primary:hover, .guided-primary:focus-visible { border-color: #c5ffcf; background: #c5ffcf; outline: 2px solid #7cf59d; outline-offset: 4px; }
  .guided-primary strong { font-size: clamp(1.25rem, 3vw, 1.8rem); font-weight: 750; letter-spacing: -.02em; }
  .guided-primary small { color: #1b3b24; font-size: .65rem; font-weight: 550; line-height: 1.45; }
  .guided-secondary { border-bottom: 1px solid transparent; padding: .35rem .2rem; color: #82958a; font-size: .62rem; }
  .guided-secondary:hover, .guided-secondary:focus-visible { border-color: #7cf59d; color: #dfffe7; outline: none; }
  .startup-facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; max-width: 464px; margin: 24px auto 0; background: rgb(70 94 77 / .26); }
  .startup-facts div { background: rgb(8 14 10 / .78); padding: 12px; backdrop-filter: blur(8px); }
  .startup-facts dt { color: #66786d; font-size: 12px; font-weight: 600; line-height: 1.2; letter-spacing: .1em; text-transform: uppercase; }
  .startup-facts dd { margin-top: 4px; color: #b8cdbd; font-size: 14px; font-weight: 400; line-height: 1.5; }
  .empty-workspace { display: grid; height: 100%; place-content: center; justify-items: center; padding: 2rem; text-align: center; }
  .empty-glyph { display: grid; width: 3.2rem; height: 3.2rem; place-items: center; border: 1px solid #34483a; background: #0b120d; color: #617b68; font-size: 1.2rem; }
  .empty-workspace p { margin-top: 1rem; color: #7cf59d; font-size: .56rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  .empty-workspace h2 { margin-top: .45rem; color: #e8f5eb; font-size: 1.3rem; font-weight: 600; }
  .empty-actions { display: flex; gap: .5rem; margin-top: 1rem; }
  .empty-actions > button:not(.host-primary) { border: 1px solid #405748; padding: .65rem .8rem; color: #a9cbb1; font-size: .68rem; }
  .guided-invite-entry { width: min(18rem, calc(100vw - 3rem)); margin-top: .75rem; border-top: 1px solid #293832; }

  @media (min-width: 640px) {
    .share-dialog-content { grid-template-columns: minmax(15rem, 21rem) minmax(0, 1fr); align-items: center; padding: 1.35rem; }
    .invite-dialog-content { grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr); align-items: start; padding: .8rem 1.3rem 1.3rem; }
  }

  @media (min-width: 1024px) {
    .command-cluster-label { display: inline-flex; }
  }

  @media (max-width: 900px) {
    .host-topbar { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); align-items: stretch; gap: 0; padding: 0 .45rem; }
    .host-topbar :global(.workspace-nav) { width: 100%; min-width: 0; }
    .host-topbar :global(.workspace-nav > a), .host-topbar :global(.workspace-nav > button) { min-height: 2.75rem; }
    .host-commandbar { display: grid; width: 100%; grid-template-columns: minmax(3.25rem, 1fr) auto auto; align-items: stretch; justify-content: stretch; }
    .host-commandbar.guided-setup { position: absolute; top: 0; right: .45rem; width: auto; grid-template-columns: auto; justify-content: end; }
    .mobile-rail-toggle { display: grid; min-width: 0; height: 2.75rem; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .4rem; padding: 0 .55rem; color: #b9cbbf; text-align: left; font-size: .6rem; }
    .mobile-rail-toggle:hover, .mobile-rail-toggle.active { background: #142018; color: #effff2; }
    .mobile-rail-toggle > span:first-child { color: #7cf59d; font-size: .78rem; }
    .mobile-rail-toggle > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mobile-rail-toggle strong { display: grid; min-width: 1.15rem; height: 1.15rem; place-items: center; background: #17241b; color: #9bf6b3; font-size: .52rem; font-weight: 600; }
    .mobile-tools-toggle { position: relative; z-index: 61; display: grid; width: 2.75rem; height: 2.75rem; place-items: center; color: #82958a; font-size: .7rem; letter-spacing: .08em; }
    .mobile-tools-toggle:hover, .mobile-tools-toggle.active { background: #142018; color: #effff2; }
    .mobile-tools-scrim { position: fixed; z-index: 59; inset: 0; display: block; border: 0; background: rgb(0 0 0 / .38); cursor: default; backdrop-filter: blur(1px); }
    .host-utilities { position: absolute; z-index: 60; top: calc(100% + .35rem); right: 0; display: none; width: min(20rem, calc(100vw - 1.1rem)); max-height: calc(100dvh - 1.1rem); grid-template-columns: minmax(0, 1fr); overflow-y: auto; overscroll-behavior: contain; border: 1px solid #496451; background: #080d0a; box-shadow: 0 18px 48px rgb(0 0 0 / .62); }
    .host-utilities.open { display: grid; }
    .host-utilities, .command-cluster { gap: 0; }
    .command-cluster { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr); }
    .command-cluster-label { display: flex; min-height: 2rem; border-right: 0; border-bottom: 1px solid #202d25; padding-inline: .7rem; }
    .command-cluster-divider { display: block; width: 100%; height: 1px; background: #496451; }
    .host-utilities :global(.notification-feed), .host-utilities :global(.notification-center), .host-utilities :global(.user-profile), .host-utilities :global(.notification-feed-trigger), .host-utilities :global(.notification-trigger), .host-utilities :global(.user-trigger) { width: 100%; min-width: 0; }
    .host-utilities :global(.notification-feed-trigger), .host-utilities :global(.notification-trigger) { justify-content: flex-start; padding-inline: .7rem; }
    .host-utilities :global(.user-trigger) { grid-template-columns: auto minmax(0, 1fr) auto; padding-inline: .65rem; }
    .host-utilities :global(.presence-menu),
    .host-utilities :global(.notification-feed-panel),
    .host-utilities :global(.notification-menu),
    .host-utilities :global(.user-menu) {
      position: fixed;
      top: auto;
      right: .55rem;
      bottom: .55rem;
      left: .55rem;
      width: auto;
      max-height: calc(100dvh - 1.1rem);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .sidebar-account :global(.user-menu),
    .sidebar-account :global(.presence-menu),
    .sidebar-account :global(.notification-feed-panel),
    .sidebar-account :global(.notification-menu) {
      position: fixed;
      top: auto;
      right: .55rem;
      bottom: .55rem;
      left: .55rem;
      width: auto;
      max-height: calc(100dvh - 1.1rem);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .host-utilities :global(.compact-controls) { width: 100%; height: 2.75rem; gap: 0; border-inline: 0; border-bottom: 1px solid #202d25; padding: 0; }
    .host-commandbar :global(.lifecycle-status) { height: 2.75rem; gap: 0; padding: 0 .4rem; }
    .host-commandbar :global(.lifecycle-status > span:first-child) { display: none; }
    .host-commandbar :global(.lifecycle-action) { height: 2.75rem; gap: .3rem; padding: 0 .52rem; }
    .host-commandbar :global(.destroy-action) { width: 2.75rem; height: 2.75rem; }
    .manage-toggle { padding-inline: .58rem; }
    .host-layout, .host-layout:not(.management-open), .host-layout.management-open { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
    .host-rail { position: absolute; z-index: 30; inset: 0 auto 0 0; display: block !important; width: min(22rem, calc(100% - 2.65rem)); max-width: 100%; transform: translateX(-102%); border-right: 1px solid #3c5544; border-bottom: 0; padding: .65rem; box-shadow: 18px 0 42px rgb(0 0 0 / .52); opacity: 0; pointer-events: none; overscroll-behavior: contain; transition: transform .18s ease, opacity .18s ease; }
    .host-rail.mobile-open { transform: translateX(0); opacity: 1; pointer-events: auto; }
    .mobile-rail-scrim { position: absolute; z-index: 25; inset: 0; display: block; width: 100%; height: 100%; border: 0; background: rgb(0 0 0 / .46); cursor: default; backdrop-filter: blur(1px); }
    .management-heading { display: none; }
    .management-dashboard { height: 100%; }
    .management-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .management-summary > div { padding: .65rem; }
    .share-overlay { padding: .55rem; }
    .share-dialog { display: grid; max-height: calc(100dvh - 1.1rem); grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
    .share-dialog-header { padding: .7rem .75rem; }
    .share-dialog-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .share-dialog-content { padding: .75rem; }
    .invite-dialog-content { padding: .65rem .85rem 1rem; }
    .invite-dialog-header { padding-inline: .85rem; }
    .invite-in-app { margin-inline: .85rem; }
    .share-qr { width: min(100%, 15rem, 42dvh); border-width: .4rem; }
    .invite-dialog.qr-expanded { width: calc(100vw - 1.1rem); height: calc(100dvh - 1.1rem); }
    .host-composer-status:not(.unavailable) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  }

  @media (max-width: 520px) {
    .startup-stage { padding: 8px; }
    .startup-kicker { margin-top: 8px; }
    .startup-content h1 { margin-top: 4px; font-size: 28px; }
    .startup-progress-panel { margin-top: .85rem; padding: .7rem .75rem; }
    .startup-progress-panel footer { gap: .55rem; }
    .startup-facts { margin-top: 16px; }
  }

  @keyframes qr-refresh { from { opacity: .25; transform: scale(.975); } }
  @keyframes coordinator-status-pulse { 50% { opacity: .38; } }

  @media (max-height: 520px) {
    .startup-kicker { display: none; }
    .startup-progress-panel { margin-top: .65rem; }
    .startup-progress-panel footer { margin-top: .4rem; }
  }

  @media (max-width: 900px) and (max-height: 420px) and (min-width: 480px) {
    .host-topbar { gap: 0; }
    .host-topbar :global(.workspace-nav) { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .share-qr img { animation: none; }
    .host-rail { transition: none; }
    .channel-server-dot.connecting { animation: none; }
    .rail-ready-control { animation: none; }
  }
</style>
