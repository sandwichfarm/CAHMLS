<script lang="ts">
  import type { RoomHostIdentity } from "@cahmls/sdk/client";
  import { createPubkeyAvatar } from "../identity/user-profile.svelte";

  interface Props {
    host: RoomHostIdentity;
    compact?: boolean;
    avatarOnly?: boolean;
    showRole?: boolean;
    allowExternalAvatar?: boolean;
  }

  let { host, compact = false, avatarOnly = false, showRole = true, allowExternalAvatar = true }: Props = $props();
  const fallbackAvatar = $derived(createPubkeyAvatar(host.pubkey));
  const hostName = $derived(host.name.trim() || "Unknown host");
  const avatarSource = $derived(allowExternalAvatar && host.avatar ? host.avatar : fallbackAvatar);
  const roleVisible = $derived(showRole && !/\bhost\b/i.test(hostName));

  function useFallback(event: Event): void {
    (event.currentTarget as HTMLImageElement).src = fallbackAvatar;
  }
</script>

<span
  class:avatar-only={avatarOnly}
  class:compact
  class:no-role={!roleVisible}
  class="room-host-badge"
  data-testid="room-host-identity"
  title={`Hosted by ${hostName}`}
>
  <img src={avatarSource} alt="" onerror={useFallback} />
  {#if !avatarOnly}
    <span class="host-name">{hostName}</span>
    {#if roleVisible}<span class="host-role">host</span>{/if}
  {/if}
</span>

<style>
  .room-host-badge { display: inline-grid; min-width: 0; max-width: 10rem; grid-template-columns: 1.45rem minmax(0, auto) auto; align-items: center; gap: .38rem; color: #b8d9c0; vertical-align: middle; }
  img { width: 1.45rem; height: 1.45rem; border: 1px solid rgb(124 245 157 / .2); background: #0b0e0d; object-fit: cover; }
  .host-name { min-width: 0; overflow: hidden; font-size: .62rem; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
  .host-role { border: 1px solid #354e3c; background: rgb(124 245 157 / .05); padding: .1rem .25rem; color: #7fae8a; font-size: .42rem; font-weight: 750; letter-spacing: .08em; line-height: 1.1; text-transform: uppercase; }
  .compact { max-width: 8rem; grid-template-columns: 1.2rem minmax(0, auto) auto; gap: .28rem; }
  .compact img { width: 1.2rem; height: 1.2rem; }
  .compact .host-name { font-size: .56rem; }
  .compact .host-role { padding: .08rem .2rem; font-size: .38rem; }
  .no-role { grid-template-columns: 1.45rem minmax(0, auto); }
  .compact.no-role { grid-template-columns: 1.2rem minmax(0, auto); }
  .avatar-only { display: inline-grid; width: 1.65rem; height: 1.65rem; grid-template-columns: 1fr; flex: 0 0 auto; }
  .avatar-only img { width: 1.65rem; height: 1.65rem; }
  .compact.avatar-only { width: 1rem; height: 1rem; }
  .compact.avatar-only img { width: 1rem; height: 1rem; }
</style>
