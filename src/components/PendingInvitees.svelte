<script lang="ts">
  import { nip19 } from "nostr-tools";
  import { SvelteMap } from "svelte/reactivity";
  import type { RemoteJoinRequest } from "@cahmls/sdk/client";
  import {
    createPubkeyAvatar,
    fetchNostrProfiles,
    type NostrProfile,
  } from "../identity/user-profile.svelte";

  interface Props {
    requests: RemoteJoinRequest[];
    onApprove: () => void | Promise<void>;
  }

  let { requests, onApprove }: Props = $props();
  const profiles = new SvelteMap<string, NostrProfile>();
  let loading = $state(false);
  let approving = $state(false);
  let loadedKey = "";

  const requestKey = $derived([...new Set(requests.map((request) => request.pk))].sort().join(","));

  $effect(() => {
    if (requestKey === loadedKey) return;
    loadedKey = requestKey;
    const pubkeys = requestKey ? requestKey.split(",") : [];
    if (pubkeys.length === 0) {
      profiles.clear();
      loading = false;
      return;
    }
    let current = true;
    loading = true;
    void fetchNostrProfiles(pubkeys).then((nextProfiles) => {
      if (!current || loadedKey !== requestKey) return;
      profiles.clear();
      for (const [pubkey, profile] of nextProfiles) profiles.set(pubkey, profile);
      loading = false;
    });
    return () => {
      current = false;
    };
  });

  function requesterName(pubkey: string): string {
    const profile = profiles.get(pubkey);
    return profile?.display_name?.trim() || profile?.name?.trim() || "Anonymous invitee";
  }

  function requesterAvatar(pubkey: string): string {
    return profiles.get(pubkey)?.picture?.trim() || createPubkeyAvatar(pubkey);
  }

  function requesterNpub(pubkey: string): string {
    try {
      return nip19.npubEncode(pubkey);
    } catch {
      return pubkey;
    }
  }

  async function approve(): Promise<void> {
    if (requests.length === 0 || approving) return;
    approving = true;
    try {
      await onApprove();
    } finally {
      approving = false;
    }
  }
</script>

<section class:has-requests={requests.length > 0} class="pending-invitees" data-testid="pending-invitees">
  <button
    class="pending-invitees-action"
    type="button"
    disabled={requests.length === 0 || approving}
    aria-label={requests.length === 0
      ? "Approve waiting invitees, no requests"
      : `Approve waiting invitees, ${requests.length} ${requests.length === 1 ? "request" : "requests"}`}
    onclick={() => void approve()}
  >
    <span>{approving ? "Approving…" : "Approve waiting invitees"}</span>
    <span class:empty={requests.length === 0} class="pending-invitees-count">{requests.length}</span>
  </button>

  {#if requests.length > 0}
    <div class="pending-invitees-list" aria-label="Waiting invitees">
      {#each requests as request (request.kp_ref)}
        <article class="pending-invitee">
          <img src={requesterAvatar(request.pk)} alt="" />
          <span class="pending-invitee-identity">
            <strong>{requesterName(request.pk)}</strong>
            <code title={requesterNpub(request.pk)}>{requesterNpub(request.pk)}</code>
          </span>
          <span class="pending-invitee-state">{loading ? "Looking up…" : "Waiting"}</span>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .pending-invitees {
    border: 1px solid #293832;
    background: #0b0e0d;
    transition: border-color 150ms ease, background 150ms ease;
  }

  .pending-invitees.has-requests {
    border-color: #355e43;
    background: #0c120f;
  }

  .pending-invitees-action {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: .75rem;
    padding: .8rem .9rem;
    color: #dfffe7;
    font-size: .72rem;
    letter-spacing: .01em;
    text-align: left;
    transition: color 150ms ease, background 150ms ease;
  }

  .pending-invitees-action:not(:disabled):hover {
    background: #122019;
    color: #7cf59d;
  }

  .pending-invitees-action:disabled {
    cursor: not-allowed;
    color: #5f7166;
  }

  .pending-invitees-count {
    display: grid;
    min-width: 1.45rem;
    height: 1.45rem;
    place-items: center;
    border-radius: 999px;
    background: #7cf59d;
    color: #071009;
    font-size: .66rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .pending-invitees-count.empty {
    background: #17221c;
    color: #65776b;
  }

  .pending-invitees-list {
    border-top: 1px solid #293832;
  }

  .pending-invitee {
    display: grid;
    grid-template-columns: 2rem minmax(0, 1fr) auto;
    align-items: center;
    gap: .65rem;
    min-width: 0;
    padding: .65rem .8rem;
  }

  .pending-invitee + .pending-invitee {
    border-top: 1px solid #1c2a23;
  }

  .pending-invitee img {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 1px solid #355e43;
    background: #101614;
    object-fit: cover;
  }

  .pending-invitee-identity {
    display: block;
    min-width: 0;
  }

  .pending-invitee-identity strong {
    display: block;
    overflow: hidden;
    color: #dfffe7;
    font-size: .68rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pending-invitee-identity code {
    display: block;
    overflow: hidden;
    margin-top: .15rem;
    color: #82958a;
    font-family: inherit;
    font-size: .56rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pending-invitee-state {
    color: #7cf59d;
    font-size: .5rem;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
</style>
