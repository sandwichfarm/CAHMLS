<script lang="ts">
  import { tick } from "svelte";
  import type { ChatEmojiShortcut } from "../chat/protocol";
  import { parseInviteMessage, type ChatInvite, type RoomHostIdentity } from "../chat/invite";
  import type { ReactionSummary, StoredMessage } from "../chat/room-store";
  import { createPubkeyAvatar } from "../identity/user-profile.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import MessageTimestamp from "./MessageTimestamp.svelte";
  import { viewportOverlay } from "../lib/viewport-overlay";
  import { PARTICIPANT_HIGHLIGHT_PALETTE, type ParticipantHighlight, type ParticipantHighlightName } from "../chat/chat-participant-preferences.svelte";

  export interface ParticipantRoomChoice {
    coordinatorPubkey: string;
    roomId: string;
    title: string;
    coordinatorLabel: string;
  }

  interface Props {
    messages: StoredMessage[];
    viewerPubkey: string;
    reactionsFor: (messageId: string) => ReactionSummary[];
    pickerOpenMessageId: string | null;
    participantSurfaceKey: string;
    activeParticipantSurfaceKey: string | null;
    disabled?: boolean;
    idPrefix: "host" | "guest";
    onTogglePicker: (messageId: string) => void;
    onClosePicker: (messageId: string) => void;
    onToggleReaction: (messageId: string, emoji: ChatEmojiShortcut) => void | Promise<void>;
    onSetReaction: (messageId: string, emoji: ChatEmojiShortcut) => void | Promise<void>;
    onActivateParticipantSurface: (key: string) => void;
    onDismissParticipantSurface: (key: string) => void;
    onJoinInvite: (invite: ChatInvite) => void;
    participantRooms?: ParticipantRoomChoice[];
    onMention?: (participantPubkey: string, displayName: string) => void;
    onInviteToRoom?: (participantPubkey: string, room: ParticipantRoomChoice) => Promise<void>;
    onIgnore?: (participantPubkey: string) => void;
    onHighlight?: (participantPubkey: string, name: ParticipantHighlightName | undefined) => void;
    highlight?: ParticipantHighlight;
    followAvailable?: boolean;
    followStatus?: "idle" | "pending" | "success" | "error";
    onFollow?: (participantPubkey: string) => Promise<void>;
  }

  let {
    messages,
    viewerPubkey,
    reactionsFor,
    pickerOpenMessageId,
    participantSurfaceKey,
    activeParticipantSurfaceKey,
    disabled = false,
    idPrefix,
    onTogglePicker,
    onClosePicker,
    onToggleReaction,
    onSetReaction,
    onActivateParticipantSurface,
    onDismissParticipantSurface,
    onJoinInvite,
    participantRooms = [],
    onMention,
    onInviteToRoom,
    onIgnore,
    onHighlight,
    highlight,
    followAvailable = false,
    followStatus = "idle",
    onFollow,
  }: Props = $props();

  const first = $derived(messages[0]);
  const mine = $derived(first?.sender === viewerPubkey);
  const host = $derived(Boolean(first?.badgeLabel || first?.badgeEmoji));
  const fallbackAvatar = $derived(first ? createPubkeyAvatar(first.sender) : "");
  let actionTrigger = $state<HTMLButtonElement>();
  let menuSurface = $state<HTMLDivElement>();
  let chooserSurface = $state<HTMLDivElement>();
  let menuOpen = $state(false);
  let chooserOpen = $state(false);
  let invitePendingRoom = $state<string | null>(null);
  let actionError = $state("");
  let actionStatus = $state("");
  let highlightOpen = $state(false);

  const participantName = $derived(first?.name || "anon");
  const currentHighlightLabel = $derived(
    highlight ? `${highlight.name[0].toUpperCase()}${highlight.name.slice(1)}` : "Default",
  );
  const participantSurfaceOpen = $derived(
    activeParticipantSurfaceKey === participantSurfaceKey && (menuOpen || chooserOpen),
  );

  async function openMenu(): Promise<void> {
    if (mine || !first) return;
    chooserOpen = false;
    actionError = "";
    actionStatus = "";
    highlightOpen = false;
    menuOpen = true;
    onActivateParticipantSurface(participantSurfaceKey);
    await tick();
    document.getElementById(`${idPrefix}-participant-mention`)?.focus();
  }

  function closeSurface(restoreFocus = true): void {
    menuOpen = false;
    chooserOpen = false;
    invitePendingRoom = null;
    onDismissParticipantSurface(participantSurfaceKey);
    if (restoreFocus) void tick().then(() => actionTrigger?.focus());
  }

  async function mentionParticipant(): Promise<void> {
    if (!first || !onMention) return;
    closeSurface(false);
    onMention(first.sender, participantName);
  }

  function ignoreParticipant(): void {
    if (!first || !onIgnore) return;
    onIgnore(first.sender);
    closeSurface(false);
  }

  function chooseHighlight(name: ParticipantHighlightName | undefined): void {
    if (!first || !onHighlight) return;
    onHighlight(first.sender, name);
    highlightOpen = false;
    actionStatus = name ? `Highlight set to ${name}.` : "Highlight cleared.";
    void tick().then(() => document.getElementById(`${idPrefix}-participant-highlight`)?.focus());
  }

  async function followParticipant(): Promise<void> {
    if (!first || !onFollow || followStatus === "pending") return;
    actionError = "";
    actionStatus = "";
    try {
      await onFollow(first.sender);
      actionStatus = `Now following ${participantName}.`;
    } catch {
      actionError = "Couldn’t complete that action. Check your connection and try again.";
    }
  }

  async function openChooser(): Promise<void> {
    menuOpen = false;
    chooserOpen = true;
    actionError = "";
    await tick();
    document.getElementById(`${idPrefix}-participant-room-0`)?.focus();
  }

  async function sendRoomInvite(room: ParticipantRoomChoice): Promise<void> {
    if (!first || !onInviteToRoom || invitePendingRoom) return;
    const key = `${room.coordinatorPubkey}:${room.roomId}`;
    invitePendingRoom = key;
    actionError = "";
    actionStatus = "";
    try {
      await onInviteToRoom(first.sender, room);
      actionStatus = `Invite sent to ${participantName}.`;
      closeSurface();
    } catch {
      actionError = "Couldn’t send the invite. Check the room connection and try again.";
      invitePendingRoom = null;
    }
  }

  function handleSurfaceKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeSurface();
  }

  $effect(() => {
    if (!participantSurfaceOpen) return;
    const isInsideSurface = (target: EventTarget | null): boolean => target instanceof Node
      && (actionTrigger?.contains(target) === true
        || menuSurface?.contains(target) === true
        || chooserSurface?.contains(target) === true);
    const dismissOnPointerInteraction = (event: PointerEvent) => {
      if (!isInsideSurface(event.target)) closeSurface(false);
    };
    const dismissOnFocusInteraction = (event: FocusEvent) => {
      if (!isInsideSurface(event.target)) closeSurface(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeSurface();
    };
    document.addEventListener("pointerdown", dismissOnPointerInteraction, true);
    document.addEventListener("focusin", dismissOnFocusInteraction, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerInteraction, true);
      document.removeEventListener("focusin", dismissOnFocusInteraction, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  });

  function useFallback(event: Event): void {
    (event.currentTarget as HTMLImageElement).src = fallbackAvatar;
  }

  function useInviteFallback(event: Event, pubkey: string): void {
    (event.currentTarget as HTMLImageElement).src = createPubkeyAvatar(pubkey);
  }

  function inviteHost(invite: ChatInvite): RoomHostIdentity {
    return invite.host ?? {
      name: "Unknown host",
      pubkey: invite.coordinatorPubkey,
    };
  }

  function inviteCoordinatorName(invite: ChatInvite): string {
    return invite.coordinatorName?.trim()
      || `Coordinator ${invite.coordinatorPubkey.slice(0, 6)}…${invite.coordinatorPubkey.slice(-4)}`;
  }
</script>

{#if first}
  <section
    class:mine
    class:host
    class:highlighted={highlight !== undefined}
    class="message-streak"
    data-testid="message-streak"
    data-sender={first.sender}
    data-message-count={messages.length}
    aria-label={`${first.name || "anon"}, ${messages.length} ${messages.length === 1 ? "message" : "messages"}`}
    style:--participant-highlight={highlight?.value}
  >
    <img class="streak-avatar" data-testid="message-avatar" src={first.avatar || fallbackAvatar} alt="" onerror={useFallback} />
    <div class="streak-content">
      <div class="streak-author" data-testid="message-author">
        {#if mine}
          <strong>{participantName}</strong>
          {#if host}
            <span class="message-badge" data-testid="message-badge">
              {#if first.badgeEmoji}<span aria-hidden="true">{first.badgeEmoji}</span>{/if}
              {first.badgeLabel || "host"}
            </span>
          {/if}
        {:else}
          <button
            bind:this={actionTrigger}
            class="participant-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={participantSurfaceOpen}
            aria-label={`Actions for ${participantName}`}
            title={participantName}
            onclick={() => void openMenu()}
          >
            <strong>{participantName}</strong>
            {#if host}
              <span class="message-badge" data-testid="message-badge">
                {#if first.badgeEmoji}<span aria-hidden="true">{first.badgeEmoji}</span>{/if}
                {first.badgeLabel || "host"}
              </span>
            {/if}
          </button>
        {/if}
      </div>
      <div class="streak-messages">
        {#each messages as message (message.id)}
          {@const reactions = reactionsFor(message.id)}
          {@const sharedInvite = parseInviteMessage(message.content)}
          {@const mentionedViewer = Boolean(message.recipientPubkeys?.includes(viewerPubkey.toLowerCase()))}
          <article class:host class:mentioned={mentionedViewer} class={`message-bubble ${idPrefix === "host" ? "host-message" : "message"}`} data-testid="message-bubble" data-message-id={message.id}>
            {#if mentionedViewer}<span class="mentioned-you" data-testid="mentioned-you">Mentioned you</span>{/if}
            {#if sharedInvite}
              {@const sharedHost = inviteHost(sharedInvite)}
              {@const groupName = sharedInvite.title || "Chat"}
              {@const coordinatorName = inviteCoordinatorName(sharedInvite)}
              <button
                class="shared-invite-action"
                type="button"
                aria-label={`Join ${groupName} on ${coordinatorName} by ${sharedHost.name}`}
                onclick={() => onJoinInvite(sharedInvite)}
              >
                <span class="shared-invite-copy">Join <strong>{groupName}</strong> on <strong>{coordinatorName}</strong></span>
                <span class="shared-invite-host">
                  <span>by</span>
                  <img src={sharedHost.avatar || createPubkeyAvatar(sharedHost.pubkey)} alt="" onerror={(event) => useInviteFallback(event, sharedHost.pubkey)} />
                  <span>{sharedHost.name}</span>
                </span>
              </button>
            {:else}
              <p>{message.content}</p>
            {/if}
            <MessageTimestamp createdAt={message.createdAt} pending={message.pending} />
            <MessageReactions
              messageId={message.id}
              authorName={message.name}
              {reactions}
              pickerOpen={pickerOpenMessageId === message.id}
              canReact={message.sender !== viewerPubkey}
              {disabled}
              {idPrefix}
              onTogglePicker={() => onTogglePicker(message.id)}
              onClosePicker={() => onClosePicker(message.id)}
              onToggleReaction={(emoji) => onToggleReaction(message.id, emoji)}
              onSetReaction={(emoji) => onSetReaction(message.id, emoji)}
            />
          </article>
        {/each}
      </div>
    </div>
  </section>

  {#if participantSurfaceOpen && menuOpen && !mine}
    <div
      bind:this={menuSurface}
      class="participant-menu"
      role="dialog"
      tabindex="-1"
      aria-label={`Actions for ${participantName}`}
      use:viewportOverlay={{ anchor: actionTrigger, preferredSide: "above", align: mine ? "end" : "start", compactSheetBelow: 520, gutter: 16 }}
      onkeydown={handleSurfaceKeydown}
    >
      <button id={`${idPrefix}-participant-mention`} type="button" onclick={() => void mentionParticipant()}>Mention</button>
      <button type="button" onclick={() => void openChooser()}>Invite to room</button>
      <button type="button" disabled={!followAvailable || followStatus === "pending"} aria-busy={followStatus === "pending"} aria-describedby={!followAvailable ? `${idPrefix}-participant-follow-guidance` : undefined} onclick={() => void followParticipant()}>{followStatus === "pending" ? `Following ${participantName}…` : "Follow on Nostr"}</button>
      {#if !followAvailable}<p id={`${idPrefix}-participant-follow-guidance`} class="participant-guidance">Sign in to follow people on Nostr.</p>{/if}
      <div class="participant-divider" aria-hidden="true"></div>
      <button id={`${idPrefix}-participant-highlight`} type="button" onclick={() => highlightOpen = !highlightOpen}>Highlight: {currentHighlightLabel}</button>
      {#if highlightOpen}
        <div class="participant-highlights" aria-label="Highlight color">
          <button data-testid="participant-highlight-default" class:highlight-selected={highlight === undefined} type="button" aria-pressed={highlight === undefined} onclick={() => chooseHighlight(undefined)}>Default{#if highlight === undefined} <span class="highlight-selected-marker">Selected</span>{/if}</button>
          {#each Object.keys(PARTICIPANT_HIGHLIGHT_PALETTE) as name (name)}
            <button data-testid={`participant-highlight-${name}`} class:highlight-selected={highlight?.name === name} type="button" aria-pressed={highlight?.name === name} onclick={() => chooseHighlight(name as ParticipantHighlightName)}>{name[0].toUpperCase() + name.slice(1)}{#if highlight?.name === name} <span class="highlight-selected-marker">Selected</span>{/if}</button>
          {/each}
        </div>
      {/if}
      <button type="button" onclick={ignoreParticipant}>Ignore</button>
      {#if actionError}<p class="participant-action-error" role="status">{actionError}</p>{/if}
    </div>
  {/if}

  {#if participantSurfaceOpen && chooserOpen && !mine}
    <div
      bind:this={chooserSurface}
      class="participant-chooser"
      role="dialog"
      tabindex="-1"
      aria-label={`Invite ${participantName} to a room`}
      use:viewportOverlay={{ anchor: actionTrigger, preferredSide: "above", align: mine ? "end" : "start", compactSheetBelow: 520, gutter: 16 }}
      onkeydown={handleSurfaceKeydown}
    >
      <h2>Invite {participantName} to a room</h2>
      {#if participantRooms.length === 0}
        <strong>No other active rooms</strong>
        <p>Join or create another active room before sending an invite.</p>
      {:else}
        <div class="participant-room-list" aria-busy={invitePendingRoom !== null}>
          {#each participantRooms as room, index (`${room.coordinatorPubkey}:${room.roomId}`)}
            {@const key = `${room.coordinatorPubkey}:${room.roomId}`}
            <button
              id={`${idPrefix}-participant-room-${index}`}
              type="button"
              disabled={invitePendingRoom !== null}
              onclick={() => void sendRoomInvite(room)}
            >
              {#if invitePendingRoom === key}Sending invite…{:else}<span>{room.title}</span><small>{room.coordinatorLabel}</small>{/if}
            </button>
          {/each}
        </div>
      {/if}
      {#if actionError}<p class="participant-action-error" role="status">{actionError}</p>{/if}
    </div>
  {/if}
  {#if actionStatus}<p class="participant-action-status" role="status">{actionStatus}</p>{/if}
{/if}

<style>
  .message-streak { display: grid; width: max(60%, 18rem); max-width: min(88%, 44rem); grid-template-columns: 2rem minmax(0, 1fr); align-items: end; gap: .6rem; margin: 0 0 .8rem; }
  .message-streak.mine { margin-left: auto; grid-template-columns: minmax(0, 1fr) 2rem; }
  .streak-avatar { grid-column: 1; width: 2rem; height: 2rem; border: 1px solid rgb(124 245 157 / .16); background: #0b0e0d; object-fit: cover; }
  .mine .streak-avatar { grid-column: 2; opacity: .72; }
  .streak-content { grid-column: 2; min-width: 0; }
  .mine .streak-content { grid-column: 1; grid-row: 1; }
  .streak-author { display: flex; min-width: 0; align-items: center; gap: .4rem; margin: 0 0 .2rem; }
  .mine .streak-author { justify-content: flex-end; }
  .streak-author strong { overflow: hidden; color: #b9fac8; font-size: .7rem; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
  .mine .streak-author strong { color: #7f9387; }
  .message-badge { display: inline-flex; user-select: text; align-items: center; gap: .22rem; border: 1px solid #41664b; background: rgb(124 245 157 / .07); padding: .12rem .32rem; color: #93dba4; font-size: .48rem; font-weight: 680; letter-spacing: .09em; line-height: 1.15; text-transform: uppercase; }
  .participant-trigger { box-sizing: border-box; display: inline-flex; min-width: 44px; min-height: 44px; max-width: 100%; align-items: center; gap: 4px; border: 1px solid transparent; padding: 4px 8px; color: inherit; text-align: left; }
  .participant-trigger:hover, .participant-trigger:focus-visible, .participant-trigger[aria-expanded="true"] { border-color: #7cf59d; background: #101614; outline: 2px solid transparent; outline-offset: 2px; }
  .participant-trigger:focus-visible { outline-color: #7cf59d; }
  .participant-menu, .participant-chooser { box-sizing: border-box; display: grid; width: min(288px, calc(100vw - 32px)); gap: 8px; border: 1px solid #293832; background: #101614; padding: 16px; color: #dfffe7; box-shadow: 0 8px 32px rgb(0 0 0 / .38); }
  .participant-menu > button, .participant-room-list > button { display: grid; min-height: 44px; width: 100%; align-items: center; border: 1px solid transparent; padding: 8px 16px; color: #dfffe7; font-size: 14px; font-weight: 400; line-height: 1.5; text-align: left; }
  .participant-menu > button:hover:not(:disabled), .participant-menu > button:focus-visible, .participant-room-list > button:hover:not(:disabled), .participant-room-list > button:focus-visible { border-color: #7cf59d; background: #101614; outline: 2px solid #7cf59d; outline-offset: 2px; }
  .participant-menu > button:disabled { cursor: not-allowed; color: #82958a; opacity: .8; }
  .participant-guidance, .participant-chooser p { margin: 0; color: #82958a; font-size: 12px; font-weight: 400; line-height: 1.5; }
  .participant-divider { height: 1px; margin: 0; background: #293832; }
  .participant-highlights { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; padding: 4px; }
  .participant-highlights button { min-height: 44px; border: 1px solid #293832; color: #dfffe7; font-size: 14px; font-weight: 400; line-height: 1.5; }
  .participant-highlights button.highlight-selected { border-color: #7cf59d; box-shadow: inset 2px 0 #7cf59d; }
  .highlight-selected-marker { margin-left: 4px; font-weight: 600; }
  .participant-highlights button:hover, .participant-highlights button:focus-visible { border-color: #7cf59d; background: #101614; outline: 2px solid #7cf59d; outline-offset: 2px; }
  .participant-chooser h2 { margin: 0; color: #dfffe7; font-size: 20px; font-weight: 600; line-height: 1.2; }
  .participant-chooser > strong { color: #dfffe7; font-size: 16px; font-weight: 600; line-height: 1.2; }
  .participant-room-list { display: grid; max-height: 256px; gap: 8px; overflow-y: auto; overscroll-behavior: contain; }
  .participant-room-list > button { gap: 4px; border-color: #293832; }
  .participant-room-list small { color: #82958a; font-size: 12px; font-weight: 400; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .participant-action-error { margin: 0; color: #ffaaa3; font-size: 12px; font-weight: 400; line-height: 1.5; }
  .participant-action-status { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .streak-messages { display: grid; gap: .18rem; }
  .message-bubble { position: relative; z-index: 0; min-width: 5rem; border: 0; background: #1a241e; padding: .48rem .72rem .72rem; color: #dce8df; }
  .message-bubble:hover, .message-bubble:focus-within, .message-bubble:has(:global(.picker-open)) { z-index: 4; }
  .message-bubble:has(:global(.has-reactions)) { margin-bottom: .72rem; }
  .mine .message-bubble { background: #162019; color: #cbd7ce; }
  .message-streak.host:not(.mine) .message-bubble { background: #18291d; box-shadow: inset 2px 0 rgb(124 245 157 / .12); }
  .message-streak.highlighted:not(.mine) .message-bubble { box-shadow: inset 2px 0 var(--participant-highlight); }
  .mine .message-bubble.host { background: #162019; box-shadow: none; }
  .message-bubble p { white-space: pre-wrap; overflow-wrap: anywhere; }
  .message-bubble.mentioned { box-shadow: inset 2px 0 #f1f58f; }
  .mentioned-you { display: block; margin: 0 0 4px; color: #f1f58f; font-size: 16px; font-weight: 600; letter-spacing: .08em; line-height: 1.2; text-transform: uppercase; }
  .shared-invite-action { display: flex; width: 100%; min-height: 3.25rem; align-items: center; justify-content: space-between; gap: .8rem; border: 1px solid rgb(124 245 157 / .2); background: #101a13; padding: .65rem .7rem; color: #cfe8d5; text-align: left; transition: border-color .15s ease, background .15s ease, color .15s ease; }
  .shared-invite-action:hover, .shared-invite-action:focus-visible { border-color: #7cf59d; outline: none; background: #14241a; color: #effff2; }
  .shared-invite-copy { min-width: 0; line-height: 1.45; }
  .shared-invite-copy strong { color: #b9fac8; font-weight: 700; }
  .shared-invite-host { display: inline-flex; flex: 0 0 auto; align-items: center; gap: .3rem; color: #8fa397; font-size: .58rem; }
  .shared-invite-host img { width: 1.35rem; height: 1.35rem; border: 1px solid rgb(124 245 157 / .2); background: #0b0e0d; object-fit: cover; }
  .message-bubble :global(.message-timestamp) { min-height: .65rem; margin-top: .18rem; }
  .mine .message-bubble :global(.message-reactions) { right: .75rem; left: auto; }
  .mine .message-bubble :global(.reaction-picker) { right: 0; left: auto; }
  @media (max-width: 520px) {
    .message-streak { max-width: 88%; gap: .45rem; }
    .message-bubble { padding-inline: .65rem; }
    .shared-invite-action { align-items: flex-start; flex-direction: column; gap: .45rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .shared-invite-action { transition: none; }
  }
</style>
