<script lang="ts">
  import { onDestroy } from "svelte";
  import { generate } from "lean-qr";
  import { toSvgDataURL } from "lean-qr/extras/svg";
  import { createInviteUrl } from "@cahmls/sdk/client";
  import { ChatRoomSession, createHostedRoom, hostIdentityForRoom, requireRoomSigner, type StoredRoom } from "@cahmls/sdk/client";
  import { userProfileStore } from "../identity/user-profile.svelte";

  let { coordinatorPubkey, relayUrls }: { coordinatorPubkey: string; relayUrls: string[] } = $props();

  let title = $state("");
  let inviteUrl = $state("");
  let qrUrl = $state("");
  let error = $state("");
  let busy = $state(false);
  let autoApprove = $state(true);
  let room = $state<StoredRoom | null>(null);
  let session = $state<ChatRoomSession | null>(null);
  let composer = $state("");
  let revision = $state(0);

  function update() {
    if (session) room = { ...session.room, messages: [...session.room.messages], pending: [...session.room.pending] };
    revision += 1;
  }

  async function openHostChat(nextRoom: StoredRoom) {
    const signer = userProfileStore.activeSigner;
    if (!signer) throw new Error("The host chat signer is unavailable");
    await requireRoomSigner(nextRoom, signer);
    session?.stop();
    room = nextRoom;
    session = new ChatRoomSession(nextRoom, signer);
    session.subscribe(update);
    void session.start();
    update();
  }

  onDestroy(() => session?.stop());

  async function createInvite() {
    busy = true;
    error = "";
    try {
      const signer = userProfileStore.activeSigner;
      if (!signer) throw new Error("Local identity is not ready");
      const created = await createHostedRoom({
        title,
        coordinatorPubkey,
        relayUrls,
        autoApprove,
        signer,
        identityOwner: userProfileStore.method === "anonymous" ? "anonymous" : "external",
      });
      inviteUrl = createInviteUrl(window.location.origin, {
        groupId: created.id,
        coordinatorPubkey,
        relayUrls,
        title: created.title,
        inviteToken: created.inviteToken,
        host: hostIdentityForRoom(created),
      });
      qrUrl = toSvgDataURL(generate(inviteUrl), { on: "#103e32", off: "#f5fbf8", pad: 2, scale: 4 });
      await openHostChat(created);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not create invite";
    } finally {
      busy = false;
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(inviteUrl);
  }

  async function setAutoApprove(enabled: boolean) {
    autoApprove = enabled;
    await session?.setAutoApprove(enabled);
  }

  async function approveWaitingInvitees() {
    try {
      await session?.approveJoinRequests();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not approve invitees";
    }
  }

  async function send() {
    if (!session) return;
    const message = composer;
    composer = "";
    await session.send(message);
  }
</script>

<section class="operator-panel rounded-xl border border-[#21482b] bg-[#06150d]/85 p-5 shadow-[0_0_32px_rgba(55,255,126,0.05)]" data-testid="invite-panel">
  <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <p class="text-xs uppercase tracking-[0.18em] text-[#6f8c75]">Invite-only chat</p>
      <h2 class="mt-1 text-xl text-[#d1ffd9]">Open a small room</h2>
    </div>
    <span class="text-xs text-[#80af88]">Encrypted MLS • your coordinator • no setup for guests</span>
  </div>
  <div class="mt-4 flex flex-col gap-3 sm:flex-row">
    <label class="flex-1 text-sm text-[#b5d8bb]">
      Room name
      <input bind:value={title} class="mt-1 w-full rounded border border-[#315a3a] bg-[#031009] px-3 py-2 text-[#e5ffea] outline-none focus:border-[#87ff9f]" placeholder="Friday plans" />
    </label>
    <button class="mt-6 rounded border border-[#87ff9f] bg-[#87ff9f] px-4 py-2 text-sm font-medium text-[#071109] hover:bg-[#c3ffce] disabled:opacity-50" onclick={createInvite} disabled={busy || relayUrls.length === 0}>
      {busy ? "Creating…" : "Create invite"}
    </button>
  </div>
  <label class="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-[#315a3a] bg-[#031009] p-3 text-sm text-[#b5d8bb]">
    <input
      type="checkbox"
      checked={autoApprove}
      onchange={(event) => void setAutoApprove((event.currentTarget as HTMLInputElement).checked)}
      aria-label="Auto-approve invitees"
      class="mt-0.5 h-4 w-4 accent-[#87ff9f]"
    />
    <span><span class="block text-[#d1ffd9]">Auto-approve invitees</span>Admit each person with this room link automatically. Enabled by default.</span>
  </label>
  {#if error}<p class="mt-3 text-sm text-[#ff9f9f]">{error}</p>{/if}
  {#if inviteUrl}
    <div class="mt-5 grid gap-4 rounded-lg border border-[#315a3a] bg-[#031009] p-4 sm:grid-cols-[auto_1fr]">
      <a href={inviteUrl} aria-label="Open chat invite" class="w-fit rounded bg-[#f5fbf8] p-2"><img src={qrUrl} alt="QR code for chat invite" class="h-32 w-32" /></a>
      <div class="min-w-0">
        <p class="text-sm text-[#d1ffd9]">Your invite is ready</p>
        <p class="mt-1 text-xs leading-5 text-[#7fa987]">It contains this coordinator’s public key and relay hints. Guests see only the chat.</p>
        <code class="mt-3 block break-all rounded bg-black/30 p-2 text-xs text-[#a6ffb8]">{inviteUrl}</code>
        <div class="mt-3 flex gap-2">
          <button class="rounded border border-[#426c4b] px-3 py-2 text-xs text-[#b9ffca] hover:border-[#87ff9f]" onclick={copy}>Copy link</button>
          <a class="rounded border border-[#426c4b] px-3 py-2 text-xs text-[#b9ffca] hover:border-[#87ff9f]" href="#host-chat">Open host chat</a>
        </div>
      </div>
    </div>
  {/if}
  {#if room && session}
    {@const current = session}
    <section id="host-chat" class="mt-5 overflow-hidden rounded-lg border border-[#315a3a] bg-[#031009]" data-testid="host-chat" data-revision={revision}>
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-[#315a3a] px-4 py-3">
        <div><p class="text-xs uppercase tracking-[0.18em] text-[#6f8c75]">Host chat</p><h3 class="mt-1 text-base text-[#d1ffd9]">{room.title}</h3></div>
        <span class="rounded-full bg-[#163a24] px-2 py-1 text-xs text-[#9dffb0]">{current.status.connection === "connected" ? "Synced" : current.status.connection === "offline" ? "Offline — buffered" : "Syncing"}</span>
      </header>
      {#if !autoApprove}
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[#315a3a] bg-[#0c2114] px-4 py-3 text-sm text-[#b5d8bb]">
          <span>Manual approval is on. Approve waiting guests when you are ready.</span>
          <button class="rounded border border-[#87ff9f] px-3 py-1.5 text-xs text-[#b9ffca] hover:border-[#c3ffce]" onclick={approveWaitingInvitees}>Approve waiting invitees</button>
        </div>
      {/if}
      <div class="max-h-72 min-h-40 space-y-3 overflow-y-auto p-4">
        {#if room.messages.length === 0}<p class="pt-10 text-center text-sm text-[#7fa987]">Your chat stays here with the coordinator. Share the invite when you are ready.</p>{/if}
        {#each room.messages as message (message.id)}
          <article class:mine={message.sender === room.stablePubkey} class="host-message"><div class="flex items-baseline gap-2"><strong>{message.name}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{#if message.pending}<span>sending…</span>{/if}</div><p>{message.content}</p></article>
        {/each}
      </div>
      <form class="flex gap-2 border-t border-[#315a3a] p-3" onsubmit={(event) => { event.preventDefault(); void send(); }}><input bind:value={composer} class="min-w-0 flex-1 rounded border border-[#426c4b] bg-black/20 px-3 py-2 text-sm text-[#e5ffea] outline-none focus:border-[#87ff9f]" placeholder="Message as host" /><button class="rounded bg-[#87ff9f] px-4 py-2 text-sm font-medium text-[#071109] hover:bg-[#c3ffce]">Send</button></form>
    </section>
  {/if}
</section>

<style>
  .host-message { max-width: 78%; border-radius: .8rem; background: #12311f; padding: .65rem .8rem; color: #d1ffd9; }
  .host-message.mine { margin-left: auto; background: #1c5630; }
  .host-message strong { font-size: .8rem; color: #a6ffb8; }
  .host-message time, .host-message span { font-size: .7rem; color: #7fa987; }
  .host-message p { margin-top: .2rem; white-space: pre-wrap; word-break: break-word; }
</style>
