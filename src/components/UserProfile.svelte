<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ConfigStore, PresenceState } from "../config/config.svelte";
  import {
    createPubkeyAvatar,
    userProfileStore,
  } from "../identity/user-profile.svelte";
  import { nostrSocialStore } from "../invites/nostr-social.svelte";
  import IdentityRotationDialog from "./IdentityRotationDialog.svelte";
  import { anonymousMembershipImpact } from "../chat/room-store";
  import OperatorIdentityChoices from "./OperatorIdentityChoices.svelte";
  import { viewportOverlay } from "../lib/viewport-overlay";

  interface Props {
    config: ConfigStore;
    coordinatorPubkey: string;
    relayUrls: string[];
    anonymousName?: string;
    onAnonymousNameChange?: (name: string) => void;
  }

  let {
    config,
    coordinatorPubkey,
    relayUrls,
    anonymousName = "",
    onAnonymousNameChange,
  }: Props = $props();
  let open = $state(false);
  let rotationDialog = $state<"confirm" | "recovery" | null>(null);
  let membershipCount = $state(0);
  let completionAnnouncement = $state("");
  let trigger: HTMLButtonElement | undefined = $state();

  const shortKey = $derived(userProfileStore.pubkey
    ? `${userProfileStore.pubkey.slice(0, 8)}…${userProfileStore.pubkey.slice(-6)}`
    : "local identity"
  );
  const presenceLabel = $derived(formatPresence(config.presenceState));

  $effect(() => {
    userProfileStore.setAnonymousName(anonymousName);
  });

  $effect(() => {
    const signer = userProfileStore.activeSigner;
    if (userProfileStore.method === "anonymous" || !signer) {
      nostrSocialStore.disconnectPresence();
      return;
    }
    void nostrSocialStore.connect(signer, config.presenceState, {
      coordinatorPubkey,
      coordinatorOrigin: window.location.origin,
      relayUrls: [...relayUrls],
      coordinatorName: config.coordinatorName || "My coordinator",
    });
  });

  function updateAnonymousName(value: string): void {
    userProfileStore.setAnonymousName(value);
    onAnonymousNameChange?.(value);
  }

  function formatPresence(state: PresenceState): string {
    if (state === "online") return "Online";
    if (state === "offline") return "Offline";
    return "Invisible";
  }

  function closeMenu(): void {
    open = false;
  }

  async function openRotationDialog(): Promise<void> {
    const impact = await anonymousMembershipImpact(userProfileStore.pubkey);
    membershipCount = impact.count;
    closeMenu();
    rotationDialog = "confirm";
  }

  async function rotateIdentity(): Promise<void> {
    await userProfileStore.rotateAnonymousIdentity();
    completionAnnouncement = "Identity rotated. Local room access was removed.";
    rotationDialog = null;
    closeMenu();
  }

  async function recoverIdentity(): Promise<void> {
    await userProfileStore.recoverAnonymousIdentity();
    rotationDialog = null;
  }

  $effect(() => {
    if (userProfileStore.recoveryRequired) rotationDialog = "recovery";
  });

  async function disconnect(): Promise<void> {
    await userProfileStore.logout();
    userProfileStore.setAnonymousName(anonymousName);
  }

  function avatarFallback(event: Event): void {
    (event.currentTarget as HTMLImageElement).src = createPubkeyAvatar(userProfileStore.pubkey);
  }

  onMount(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  });
</script>

<div class="user-profile" data-testid="user-profile">
  <p class="sr-only" aria-live="polite">{completionAnnouncement}</p>
  {#if userProfileStore.initialized && !userProfileStore.recoveryRequired}
  <button
    bind:this={trigger}
    class="user-trigger"
    type="button"
    aria-label={`${open ? "Close" : "Open"} profile for ${userProfileStore.displayName}. Presence ${presenceLabel}`}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => open ? closeMenu() : open = true}
  >
    <span class="user-avatar">
      <img src={userProfileStore.avatarUrl} alt="" onerror={avatarFallback} />
      <span
        class:online={config.presenceState === "online"}
        class:offline={config.presenceState === "offline"}
        class="profile-presence-dot"
        data-testid="profile-presence-status"
        data-presence={config.presenceState}
        role="img"
        aria-label={`Presence: ${presenceLabel}`}
      ></span>
    </span>
    <span class="user-copy">
      <strong>{userProfileStore.displayName}</strong>
      <small>{userProfileStore.authLabel}</small>
    </span>
    <span class="user-chevron" aria-hidden="true">{open ? "↑" : "↓"}</span>
  </button>

  {#if open}
    <button class="user-scrim" type="button" aria-label="Close profile menu" onclick={closeMenu}></button>
    <div use:viewportOverlay={{ anchor: trigger, preferredSide: "above", align: "start", compactSheetBelow: 900 }} class="user-menu" role="dialog" aria-label="User profile">
      <header>
        <img src={userProfileStore.avatarUrl} alt="" onerror={avatarFallback} />
        <div class="min-w-0">
          <strong>{userProfileStore.displayName}</strong>
          <span>{shortKey}</span>
        </div>
        <span class:authenticated={userProfileStore.method !== "anonymous"} class="auth-chip">{userProfileStore.authLabel}</span>
      </header>

      {#if userProfileStore.method === "anonymous"}
        <div class="user-menu-section">
          <label>
            Display name
            <input
              value={anonymousName}
              placeholder="anon"
              maxlength="32"
              oninput={(event) => updateAnonymousName(event.currentTarget.value)}
            />
          </label>
          <p>Your generated avatar and identity are device-local and persist in this browser. No account is required.</p>
          <button class="rotate-identity" type="button" onclick={() => void openRotationDialog()}>Rotate identity…</button>
        </div>
        <div class="user-menu-section">
          <span class="section-label">Connect a Nostr identity</span>
          <OperatorIdentityChoices testIdPrefix="profile" qrTestId="nip46-qr-connect" onIdentityReady={closeMenu} />
        </div>
      {:else}
        <div class="user-menu-section">
          {#if userProfileStore.profile?.nip05}<p class="profile-nip05">{userProfileStore.profile.nip05}</p>{/if}
          {#if userProfileStore.profile?.about}<p class="profile-about">{userProfileStore.profile.about}</p>{/if}
          <div class="profile-actions">
            <button type="button" onclick={() => void userProfileStore.refreshProfile()}>Refresh profile</button>
            <button class="disconnect" type="button" onclick={() => void disconnect()}>Disconnect</button>
          </div>
        </div>
      {/if}

      {#if userProfileStore.status === "loading"}<p class="user-status">Looking up kind 0 on purplepag.es and relay.damus.io…</p>{/if}
      {#if userProfileStore.error}<p class="user-error">{userProfileStore.error}</p>{/if}
    </div>
  {/if}
  {/if}

  {#if rotationDialog}
    <IdentityRotationDialog
      variant={rotationDialog}
      {membershipCount}
      onConfirm={rotationDialog === "recovery" ? recoverIdentity : rotateIdentity}
      onClose={() => {
        if (rotationDialog === "confirm") {
          rotationDialog = null;
          void tick().then(() => document.querySelector<HTMLButtonElement>(".user-trigger")?.focus());
        }
      }}
    />
  {/if}
</div>

<style>
  .user-profile { position: relative; flex: 0 0 auto; }
  .user-trigger { display: grid; height: 2.65rem; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; border: 1px solid transparent; padding: 4px 8px; color: #dfffe7; }
  .user-trigger:hover { border-color: #34483a; background: #101713; }
  .user-profile > .user-trigger[aria-expanded="true"] { border: 1px solid #87ff9f; background: #101713; }
  .user-avatar { position: relative; display: block; width: 1.85rem; height: 1.85rem; }
  .user-trigger img { width: 1.85rem; height: 1.85rem; object-fit: cover; image-rendering: pixelated; }
  .profile-presence-dot { position: absolute; right: -.12rem; bottom: -.12rem; width: .62rem; height: .62rem; border: 2px solid #080d0a; border-radius: 999px; background: #82958a; }
  .profile-presence-dot.online { background: #7cf59d; box-shadow: 0 0 8px rgb(124 245 157 / .4); }
  .profile-presence-dot.offline { background: #9b6b56; }
  .user-copy { display: none; min-width: 0; text-align: left; line-height: 1; }
  .user-copy strong { display: block; max-width: 8rem; overflow: hidden; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .user-copy small { display: block; margin-top: 4px; color: #708177; font-size: 10px; font-weight: 400; line-height: 1.3; letter-spacing: .1em; text-transform: uppercase; }
  .user-chevron { color: #64766a; font-size: 10px; }
  .user-scrim { position: fixed; z-index: 69; inset: 0; border: 0; background: transparent; cursor: default; }
  .user-menu { position: absolute; z-index: 70; top: calc(100% + 8px); right: 0; width: min(22rem, calc(100vw - 1.5rem)); border: 1px solid #496451; background: rgb(8 13 10 / .99); box-shadow: 0 20px 56px rgb(0 0 0 / .62); }
  .user-menu > header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; border-bottom: 1px solid #293832; padding: 16px; }
  .user-menu > header img { width: 2.5rem; height: 2.5rem; object-fit: cover; image-rendering: pixelated; }
  .user-menu > header strong, .user-menu > header span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .user-menu > header strong { color: #effff2; font-size: 14px; font-weight: 650; line-height: 1.4; }
  .user-menu > header div > span { margin-top: 4px; color: #718277; font-size: 10px; font-weight: 400; line-height: 1.3; }
  .auth-chip { border: 1px solid #34483a; padding: 4px 8px; color: #82958a; font-size: 10px; font-weight: 400; line-height: 1.3; letter-spacing: .08em; text-transform: uppercase; }
  .auth-chip.authenticated { border-color: #477e57; color: #7cf59d; }
  .user-menu-section { display: grid; gap: 12px; border-bottom: 1px solid #202d25; padding: 16px; }
  .user-menu-section:last-of-type { border-bottom: 0; }
  .user-menu-section label, .section-label { color: #83958a; font-size: 10px; font-weight: 400; line-height: 1.3; letter-spacing: .1em; text-transform: uppercase; }
  .user-menu-section input:not([type="radio"]) { box-sizing: border-box; width: 100%; min-width: 0; margin-top: 8px; border: 1px solid #34433b; background: #070b08; padding: 12px; color: #effff2; font-size: 12px; font-weight: 400; line-height: 1.5; outline: none; text-transform: none; }
  .user-menu-section input:not([type="radio"]):focus { border-color: #7cf59d; }
  .user-menu-section p { color: #82958a; font-size: 12px; font-weight: 400; line-height: 1.5; }
  .rotate-identity { min-height: 44px; border: 1px solid #7b4843; padding: 12px; color: #ffaaa3; font-size: 12px; font-weight: 400; line-height: 1.5; text-align: left; }
  .rotate-identity:hover, .rotate-identity:focus-visible { border-color: #ffaaa3; background: #24100f; outline: 2px solid #87ff9f; outline-offset: 2px; }
  .profile-actions button { border: 1px solid #3f5a47; padding: .55rem .65rem; color: #bde7c7; font-size: .62rem; }
  .profile-actions button:hover { border-color: #7cf59d; }
  .profile-nip05 { color: #9bf6b3 !important; }
  .profile-actions { display: flex; gap: .5rem; }
  .profile-actions .disconnect { border-color: #583737; color: #d69d99; }
  .user-status, .user-error { border-top: 1px solid #293832; padding: .65rem .85rem; font-size: .6rem; }
  .user-status { color: #91a59a; }
  .user-error { color: #ffaaa3; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  @media (min-width: 720px) {
    .user-copy { display: block; }
  }
</style>
