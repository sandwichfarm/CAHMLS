<script lang="ts">
  import { tick } from "svelte";
  import { viewportOverlay } from "../lib/viewport-overlay";
  import { roomIdentityKey } from "@cahmls/sdk/client";
  import { channelPreferences, type ChannelNotificationMode, type ChannelSoundMode } from "../notifications/channel-preferences.svelte";

  interface Props {
    roomTitle: string;
    roomId: string;
    coordinatorPubkey: string;
    inviteUrl: string;
    removalMode: "delete" | "leave";
    onRemove: (origin?: HTMLButtonElement) => void;
    sidebar?: boolean;
  }

  let { roomTitle, roomId, coordinatorPubkey, inviteUrl, removalMode, onRemove, sidebar = false }: Props = $props();
  const preferenceKey = $derived(roomIdentityKey(coordinatorPubkey, roomId));
  let open = $state(false);
  let trigger: HTMLButtonElement | undefined = $state();
  let copied = $state<"coordinator" | "invite" | null>(null);
  let copyTimer: number | null = null;

  function close(returnFocus = false): void {
    open = false;
    if (returnFocus) void tick().then(() => trigger?.focus());
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    close(true);
  }

  function toggle(event: MouseEvent): void {
    if (sidebar) event.stopPropagation();
    open = !open;
  }

  async function copyValue(value: string, target: "coordinator" | "invite"): Promise<void> {
    await navigator.clipboard.writeText(value);
    copied = target;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied = null;
      copyTimer = null;
    }, 1_800);
  }

</script>

<svelte:window onkeydown={handleKeydown} />

<div class:sidebar class="room-actions">
  <button
    bind:this={trigger}
    class="more-room-actions"
    type="button"
    aria-label={sidebar ? `More actions for # ${roomTitle}` : "More room actions"}
    aria-haspopup="menu"
    aria-expanded={open}
    title="More room actions"
    onclick={toggle}
  >
    <span aria-hidden="true">•••</span>
  </button>

  {#if open}
    <button class="room-actions-scrim" type="button" aria-label="Close room actions" onclick={() => close(true)}></button>
    <div use:viewportOverlay={{ anchor: trigger, preferredSide: "below", align: "end", compactSheetBelow: 520 }} class="room-actions-menu" role="menu" aria-label={`Room actions for ${roomTitle}`}>
      <header><span>Room actions</span><strong># {roomTitle}</strong></header>
      <div class="room-connection-details">
        <button
          class="room-copy-action"
          type="button"
          role="menuitem"
          aria-label={`Copy coordinator pubkey for ${roomTitle}`}
          onclick={() => void copyValue(coordinatorPubkey, "coordinator")}
        >
          <span><small>Coordinator pubkey</small><code>{coordinatorPubkey}</code></span>
          <strong>{copied === "coordinator" ? "Copied" : "Copy"}</strong>
        </button>
        <button
          class="room-copy-action"
          type="button"
          role="menuitem"
          aria-label={`Copy invite link for ${roomTitle}`}
          onclick={() => void copyValue(inviteUrl, "invite")}
        >
          <span><small>Invite link</small><code>{inviteUrl}</code></span>
          <strong>{copied === "invite" ? "Copied" : "Copy"}</strong>
        </button>
      </div>
      <label class="room-preference"><span>Sound</span><select aria-label={`Sound setting for ${roomTitle}`} value={channelPreferences.get(preferenceKey).sound} onchange={(event) => channelPreferences.setSound(preferenceKey, (event.currentTarget as HTMLSelectElement).value as ChannelSoundMode)}><option value="global">Use global</option><option value="on">Always on</option><option value="off">Muted</option></select></label>
      <label class="room-preference"><span>Notifications</span><select aria-label={`Notification setting for ${roomTitle}`} value={channelPreferences.get(preferenceKey).notifications} onchange={(event) => channelPreferences.setNotifications(preferenceKey, (event.currentTarget as HTMLSelectElement).value as ChannelNotificationMode)}><option value="all">All</option><option value="follows">Only follows</option><option value="mutuals">Only mutuals</option><option value="mute">Mute all</option></select></label>
      <button
        class:delete={removalMode === "delete"}
        class="room-menu-action"
        type="button"
        role="menuitem"
        aria-label={`${removalMode === "delete" ? "Delete" : "Leave"} room ${roomTitle}`}
        onclick={() => { close(); onRemove(trigger); }}
      >
        <span>{removalMode === "delete" ? (sidebar ? "Delete room" : "Delete this room") : (sidebar ? "Leave room" : "Leave this room")}</span>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .room-actions { position: absolute; z-index: 96; top: .65rem; right: .65rem; }
  .room-actions.sidebar { position: relative; top: auto; right: auto; z-index: 2; }
  .more-room-actions { position: relative; z-index: 96; display: grid; width: 2.65rem; height: 2.65rem; place-items: center; border: 0; background: transparent; color: #91a59a; font-size: .68rem; font-weight: 800; letter-spacing: .08em; transition: background .15s ease, color .15s ease; }
  .sidebar .more-room-actions { width: 2.75rem; height: 2.75rem; }
  .more-room-actions:hover, .more-room-actions:focus-visible, .more-room-actions[aria-expanded="true"] { background: #111a14; color: #effff2; outline: 2px solid #7cf59d; outline-offset: -2px; }
  .room-actions-scrim { position: fixed; z-index: 94; inset: 0; border: 0; background: rgb(0 0 0 / .32); cursor: default; backdrop-filter: blur(1px); }
  .room-actions-menu { position: absolute; z-index: 95; top: calc(100% + .45rem); right: 0; display: grid; width: min(23rem, calc(100vw - 1rem)); border: 1px solid #496451; background: rgb(7 12 9 / .99); box-shadow: 0 20px 54px rgb(0 0 0 / .62); padding: .35rem; }
  .room-actions-menu header { display: grid; gap: .22rem; border-bottom: 1px solid #293832; padding: .55rem .6rem .65rem; }
  .room-actions-menu header span { color: #718277; font-size: .5rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .room-actions-menu header strong { overflow: hidden; color: #dfffe7; font-size: .68rem; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
  .room-connection-details { display: grid; gap: 1px; border-bottom: 1px solid #293832; background: #1b2820; padding-bottom: 1px; }
  .room-copy-action { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .75rem; background: #080e0a; padding: .6rem; text-align: left; }
  .room-copy-action:hover, .room-copy-action:focus-visible { background: #112018; outline: none; }
  .room-copy-action > span { display: grid; min-width: 0; gap: .2rem; }
  .room-copy-action small { color: #718277; font-size: .48rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .room-copy-action code { display: -webkit-box; overflow: hidden; color: #a8c5af; font-size: .52rem; line-height: 1.35; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .room-copy-action > strong { color: #7cf59d; font-size: .5rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .room-menu-action { display: flex; min-height: 2.55rem; align-items: center; justify-content: space-between; gap: 1rem; padding: .6rem; color: #b9cbbf; text-align: left; font-size: .65rem; }
  .room-menu-action:hover, .room-menu-action:focus-visible { background: #142018; color: #effff2; outline: none; }
  .room-menu-action > span:last-child { color: #718277; font-size: .52rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .room-menu-action.delete { color: #ffaaa3; }
  .room-menu-action.delete:hover, .room-menu-action.delete:focus-visible { background: #21110f; }
  .room-preference { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .7rem; padding: .55rem .6rem; color: #b9cbbf; font-size: .62rem; }
  .room-preference select { border: 1px solid #34483a; background: #0b110d; padding: .35rem .45rem; color: #dfffe7; font-size: .58rem; }

  @media (max-width: 520px) {
    .room-actions { top: .45rem; right: .45rem; }
  }
</style>
