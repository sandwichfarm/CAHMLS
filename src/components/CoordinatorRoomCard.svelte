<script lang="ts">
  import { hostIdentityForRoom, roomIdentityKey, roomUnreadCount, type StoredRoom } from "../chat/room-store";
  import ChannelPreferenceIndicators from "./ChannelPreferenceIndicators.svelte";
  import RoomActionsMenu from "./RoomActionsMenu.svelte";
  import RoomHostBadge from "./RoomHostBadge.svelte";

  export interface CoordinatorRoomItem {
    room: StoredRoom;
    inviteUrl: string;
    removalMode: "delete" | "leave";
  }

  interface Props {
    pubkey: string;
    label: string;
    status: "online" | "connecting" | "offline" | "unknown";
    statusLabel: string;
    local?: boolean;
    presentation?: "coordinator" | "favorites";
    rooms: CoordinatorRoomItem[];
    favoriteRoomKeys?: readonly string[];
    unreadCount?: number;
    activeRoomKey?: string;
    revealRoomKey?: string | null;
    disabled?: boolean;
    busy?: boolean;
    onCreate?: () => void;
    onOpen: (room: StoredRoom) => void | Promise<void>;
    onRemove: (room: StoredRoom, origin: HTMLButtonElement) => void;
    onFavorite?: (room: StoredRoom, origin?: HTMLButtonElement) => void;
    onRevealHandled?: (roomKey: string) => void;
  }

  let {
    pubkey,
    label,
    status,
    statusLabel,
    local = false,
    presentation = "coordinator",
    rooms,
    favoriteRoomKeys = [],
    unreadCount = 0,
    activeRoomKey,
    revealRoomKey = null,
    disabled = false,
    busy = false,
    onCreate,
    onOpen,
    onRemove,
    onFavorite,
    onRevealHandled,
  }: Props = $props();
  let expanded = $state(false);
  let offlineExpanded = $state(false);
  let pointerInside = $state(false);
  let focusInside = $state(false);
  let disclosureState = $state<"compact" | "revealed" | "exiting">("compact");
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;
  let cardElement = $state<HTMLFieldSetElement>();
  const componentId = $props.id();
  const limit = 5;
  const offlineDisclosure = $derived(presentation === "coordinator" && !local && status === "offline" && rooms.length > 0);
  const offlineDescriptionId = `${componentId}-offline-description`;
  const visibleRooms = $derived.by(() => {
    if (presentation === "favorites" || expanded || rooms.length <= limit) return rooms;
    const first = rooms.slice(0, limit);
    const active = rooms.find((item) => roomIdentityKey(item.room.coordinatorPubkey, item.room.id) === activeRoomKey);
    const revealed = rooms.find((item) => roomIdentityKey(item.room.coordinatorPubkey, item.room.id) === revealRoomKey);
    const requiredRoom = revealed ?? active;
    if (!requiredRoom || first.includes(requiredRoom)) return first;
    return [...first.slice(0, limit - 1), requiredRoom];
  });
  const hiddenCount = $derived(Math.max(0, rooms.length - visibleRooms.length));

  $effect(() => {
    if (offlineDisclosure) {
      pointerInside = cardElement?.matches(":hover") ?? false;
      focusInside = cardElement?.contains(document.activeElement) ?? false;
      if (pointerInside || focusInside) revealOfflineRooms();
    } else {
      if (collapseTimer) clearTimeout(collapseTimer);
      disclosureState = "compact";
    }
  });

  $effect(() => {
    if (presentation !== "coordinator" || !revealRoomKey) return;
    const containsRevealedRoom = rooms.some(
      (item) => roomIdentityKey(item.room.coordinatorPubkey, item.room.id) === revealRoomKey,
    );
    if (!containsRevealedRoom) return;
    revealOfflineRooms();
    expanded = true;
    onRevealHandled?.(revealRoomKey);
  });

  function revealOfflineRooms(): void {
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = undefined;
    disclosureState = "revealed";
  }

  function toggleOfflineDisclosure(): void {
    offlineExpanded = !offlineExpanded;
    if (offlineExpanded) {
      revealOfflineRooms();
    } else {
      disclosureState = "compact";
    }
  }

  function collapseOfflineRooms(): void {
    if (!offlineDisclosure || offlineExpanded || pointerInside || focusInside) return;
    if (collapseTimer) clearTimeout(collapseTimer);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      disclosureState = "compact";
      collapseTimer = undefined;
      return;
    }
    disclosureState = "exiting";
    collapseTimer = setTimeout(() => {
      if (!pointerInside && !focusInside) disclosureState = "compact";
      collapseTimer = undefined;
    }, 150);
  }

  function displayUnreadCount(count: number): string {
    return count > 99 ? "99+" : String(count);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (eligible fieldset is the approved keyboard disclosure group stop) -->
<fieldset
  bind:this={cardElement}
  class:local
  class:favorites={presentation === "favorites"}
  class:offline-disclosure={offlineDisclosure}
  class="coordinator-room-card"
  data-testid="coordinator-card"
  data-coordinator-pubkey={pubkey}
  role={offlineDisclosure || focusInside ? "group" : undefined}
  tabindex={offlineDisclosure || focusInside ? 0 : undefined}
  onpointerenter={() => {
    if (!offlineDisclosure) return;
    pointerInside = true;
    revealOfflineRooms();
  }}
  onpointerleave={() => {
    pointerInside = false;
    collapseOfflineRooms();
  }}
  onfocusin={() => {
    if (!offlineDisclosure) return;
    focusInside = true;
    revealOfflineRooms();
  }}
  onfocusout={(event) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    focusInside = false;
    collapseOfflineRooms();
  }}
>
  <legend>
    {#if presentation === "favorites"}
      <span class="coordinator-card-label">{label}</span>
    {:else}
      <span class:online={status === "online"} class:connecting={status === "connecting"} class:offline={status === "offline"} class:unknown={status === "unknown"} class="coordinator-card-dot" data-testid={`coordinator-card-status-${pubkey}`} data-state={status} role="img" aria-label={statusLabel}></span>
      <span class="coordinator-card-label" title={label}>{label}</span>
      <span class="coordinator-card-status">{status}</span>
      {#if unreadCount > 0}<span class="unread-badge coordinator-unread" aria-label={`${unreadCount} unread messages for this coordinator`}>{displayUnreadCount(unreadCount)}</span>{/if}
      {#if local && onCreate}
        <button class="coordinator-create" type="button" aria-label="Create group" title="Create group" disabled={disabled} onclick={onCreate}>+</button>
      {/if}
    {/if}
  </legend>

  {#if rooms.length === 0}
    <div class="coordinator-card-empty">
      <strong>{local ? "No groups yet" : "No active groups"}</strong>
      {#if local}<span>{disabled ? "Start the coordinator, then create a group." : "Create a group when you are ready."}</span>{/if}
    </div>
  {:else}
    {#if offlineDisclosure}
      <button
        class="offline-chat-summary"
        type="button"
        aria-expanded={offlineExpanded}
        aria-controls={offlineDescriptionId}
        onclick={toggleOfflineDisclosure}
      >{offlineExpanded ? "Hide offline chats" : `Show ${rooms.length} offline ${rooms.length === 1 ? "chat" : "chats"}`}</button>
    {/if}
    {#if !offlineDisclosure || offlineExpanded || disclosureState !== "compact"}
    <div
      id={offlineDisclosure ? offlineDescriptionId : undefined}
      class:entering={offlineDisclosure && disclosureState === "revealed"}
      class:exiting={offlineDisclosure && disclosureState === "exiting"}
      class="offline-room-disclosure"
      inert={offlineDisclosure && disclosureState === "exiting" ? true : undefined}
      aria-hidden={offlineDisclosure && disclosureState === "exiting" ? "true" : undefined}
    >
    <div class="coordinator-card-rooms">
      {#each visibleRooms as item (roomIdentityKey(item.room.coordinatorPubkey, item.room.id))}
        {@const key = roomIdentityKey(item.room.coordinatorPubkey, item.room.id)}
        {@const unread = roomUnreadCount(item.room)}
        {@const favorite = favoriteRoomKeys.includes(key)}
        <div class:active={key === activeRoomKey} class:unavailable={disabled} class:busy class="channel-row" data-room-key={key}>
          <button class="channel-row-primary" type="button" aria-label={`Open room ${item.room.title}, hosted by ${hostIdentityForRoom(item.room).name}`} disabled={disabled} onclick={() => onOpen(item.room)}>
            <span class="channel-active-mark" aria-hidden="true"></span>
            <span class="channel-hash" aria-hidden="true">#</span>
            <span class="channel-name-with-preferences"><span class="truncate" title={item.room.title}>{item.room.title}</span>{#if !disabled}<ChannelPreferenceIndicators roomKey={key} />{/if}</span>
            {#if !disabled}<span class="channel-owner-avatar"><RoomHostBadge host={hostIdentityForRoom(item.room)} compact avatarOnly /></span>{/if}
          </button>
          {#if unread > 0}<span class="unread-badge" data-testid={`room-unread-${key}`} title={`${unread} unread messages`} aria-label={`${unread} unread messages`}>{displayUnreadCount(unread)}</span>{/if}
          {#if !disabled && onFavorite}
            <button class:selected={favorite} class="channel-favorite" type="button" aria-label={`${favorite ? "Unfavorite" : "Favorite"} # ${item.room.title}`} aria-pressed={favorite} title={`${favorite ? "Unfavorite" : "Favorite"} # ${item.room.title}`} onclick={(event) => onFavorite(item.room, event.currentTarget)}>★</button>
          {/if}
          {#if !disabled}<RoomActionsMenu sidebar roomTitle={item.room.title} roomId={item.room.id} coordinatorPubkey={item.room.coordinatorPubkey} inviteUrl={item.inviteUrl} removalMode={item.removalMode} {favorite} onFavorite={onFavorite ? (origin) => onFavorite(item.room, origin) : undefined} onRemove={(origin) => onRemove(item.room, origin)} />{/if}
        </div>
      {/each}
    </div>
    {#if presentation !== "favorites" && rooms.length > limit}
      <button class="coordinator-reveal" type="button" aria-expanded={expanded} onclick={() => expanded = !expanded}>
        {expanded ? (offlineDisclosure ? "Show fewer chats" : "Show less") : `Show ${hiddenCount} more`}
      </button>
    {/if}
    </div>
    {/if}
  {/if}
</fieldset>

<style>
  .coordinator-room-card { min-width: 0; border: 1px solid #293832; padding: 4px; background: transparent; }
  legend { display: flex; width: calc(100% - 8px); max-width: calc(100% - 8px); align-items: center; gap: 4px; margin-left: 4px; padding: 0 4px; background: #0d1310; color: #82958a; font-size: 8px; line-height: 1.5; }
  .coordinator-card-dot { width: 4px; height: 4px; flex: 0 0 auto; border-radius: 999px; background: #39473f; }
  .coordinator-card-dot.online { background: #7cf59d; box-shadow: 0 0 7px rgb(124 245 157 / .25); }
  .coordinator-card-dot.connecting { background: #d4bc69; }
  .coordinator-card-dot.offline, .coordinator-card-dot.unknown { background: #59675f; }
  .coordinator-card-label { min-width: 0; overflow: hidden; color: #cde4d2; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .coordinator-card-status { flex: 0 0 auto; color: #64766b; font-size: 8px; text-transform: capitalize; }
  .coordinator-create { position: relative; display: grid; width: 1.8rem; height: 1.8rem; flex: 0 0 auto; margin-left: auto; cursor: pointer; place-items: center; border: 1px solid transparent; background: transparent; color: #9bf6b3; font-size: 1.15rem; font-weight: 400; line-height: 1; transition: border-color .15s ease, background .15s ease, color .15s ease, transform .15s ease; }
  .coordinator-create::before { position: absolute; top: 4px; bottom: 4px; left: -8px; width: 1px; background: #293832; content: ""; pointer-events: none; }
  .coordinator-unread { flex: 0 0 auto; }
  .coordinator-create:hover:not(:disabled), .coordinator-create:focus-visible { border-color: #496451; outline: none; background: #142019; color: #effff2; transform: rotate(90deg) scale(1.08); }
  .coordinator-create:disabled { cursor: not-allowed; opacity: .35; }
  .coordinator-card-rooms { display: grid; gap: 4px; }
  .offline-chat-summary { display: flex; width: 100%; min-height: 44px; align-items: center; border: 1px solid transparent; padding: 8px; color: #9aac9f; font-size: 12px; font-weight: 600; text-align: left; transition: border-color .15s ease, background .15s ease; }
  .offline-chat-summary:hover, .offline-chat-summary:focus-visible { border-color: #496451; background: #111a14; color: #dfffe7; outline: none; }
  .offline-room-disclosure.entering { animation: offline-rooms-enter .15s ease both; }
  .offline-room-disclosure.exiting { pointer-events: none; animation: offline-rooms-exit .15s ease both; }
  .offline-disclosure:focus-visible { outline: 1px solid #7cf59d; outline-offset: 2px; }
  .coordinator-room-card.favorites { margin-bottom: 4px; border-color: #34483a; }
  .coordinator-room-card.favorites legend { color: #9aac9f; }
  .coordinator-card-empty { display: grid; gap: 4px; padding: 8px; color: #718277; }
  .coordinator-card-empty strong { color: #9aac9f; font-size: 10px; font-weight: 600; }
  .coordinator-card-empty span { font-size: 8px; line-height: 1.45; }
  .channel-row { position: relative; display: grid; min-width: 0; min-height: 2.75rem; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; color: #91a59a; font-size: 12px; }
  .channel-row-primary { display: grid; min-width: 0; min-height: 2.75rem; grid-template-columns: .15rem auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 4px; color: inherit; text-align: left; }
  .channel-name-with-preferences { display: flex; min-width: 0; align-items: center; gap: 4px; }
  .channel-name-with-preferences .truncate { min-width: 0; flex: 0 1 auto; }
  .channel-owner-avatar { display: inline-grid; opacity: 0; transition: opacity .15s ease; }
  .channel-row:hover .channel-owner-avatar, .channel-row:focus-within .channel-owner-avatar { opacity: .72; }
  .channel-row:hover, .channel-row:focus-within { background: #111a14; color: #dfffe7; }
  .channel-row.active { background: #17241b; color: #effff2; }
  .channel-row.unavailable { color: #617268; }
  .channel-row.unavailable.busy .channel-row-primary { cursor: progress; }
  .channel-active-mark { align-self: stretch; background: transparent; }
  .channel-row.active .channel-active-mark { background: #7cf59d; box-shadow: 0 0 9px rgb(124 245 157 / .2); }
  .channel-favorite { display: grid; width: 2.75rem; height: 2.75rem; place-items: center; border: 1px solid transparent; background: transparent; color: #64766b; cursor: pointer; font-size: 12px; opacity: 0; transition: color .15s ease, opacity .15s ease; }
  .channel-row:hover .channel-favorite, .channel-row:focus-within .channel-favorite, .channel-favorite.selected { opacity: 1; }
  .channel-favorite:hover, .channel-favorite:focus-visible { border-color: #496451; color: #dfffe7; outline: none; }
  .channel-favorite.selected { color: #7cf59d; }
  .channel-hash { color: #52675a; font-size: 12px; }
  .channel-row.active .channel-hash { color: #9bf6b3; }
  .unread-badge { display: inline-flex; min-width: 1rem; height: 1rem; align-items: center; justify-content: center; padding: 0 4px; border: 1px solid #3b5943; background: #102216; color: #bfeac8; font-size: 8px; font-variant-numeric: tabular-nums; }
  .coordinator-reveal { width: 100%; margin-top: 4px; padding: 4px 8px; color: #718277; text-align: left; font-size: 8px; }
  .coordinator-reveal:hover, .coordinator-reveal:focus-visible { background: #111a14; color: #bfeac8; outline: none; }
  @keyframes offline-rooms-enter { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  @keyframes offline-rooms-exit { from { opacity: 1; } to { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .channel-favorite, .offline-chat-summary { transition: none; }
    .offline-room-disclosure.entering, .offline-room-disclosure.exiting { animation: none; transform: none; }
  }
  @media (hover: none), (pointer: coarse) {
    .channel-favorite { opacity: 1; }
    .channel-owner-avatar { display: none; }
  }
</style>
