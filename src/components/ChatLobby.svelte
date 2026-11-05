<script lang="ts">
  import { onMount } from "svelte";
  import { createSameShellChatHref } from "../chat/room-navigation";
  import { hostIdentityForRoom, listRooms, ROOMS_CHANGED_EVENT, type StoredRoom } from "@cahmls/sdk/client";
  import RoomHostBadge from "./RoomHostBadge.svelte";

  interface Props {
    coordinatorLocked: boolean;
    coordinatorStatus: string;
    homeCoordinatorPubkey?: string;
    onNavigate: (href: string) => void;
  }

  interface CoordinatorGroup {
    pubkey: string;
    origin?: string;
    rooms: StoredRoom[];
  }

  let { coordinatorLocked, coordinatorStatus, homeCoordinatorPubkey, onNavigate }: Props = $props();
  let revision = $state(0);

  const rooms = $derived(revision >= 0 ? listRooms() : []);
  const joinedRooms = $derived(rooms.filter((room) => !room.isHost));
  const currentLocalRooms = $derived(homeCoordinatorPubkey
    ? rooms.filter((room) => room.isHost && room.coordinatorPubkey === homeCoordinatorPubkey)
    : []
  );
  const previousLocalRooms = $derived(rooms.filter((room) =>
    room.isHost && (!homeCoordinatorPubkey || room.coordinatorPubkey !== homeCoordinatorPubkey)
  ));
  const coordinators = $derived.by(() => groupByCoordinator(joinedRooms));

  function groupByCoordinator(source: StoredRoom[]): CoordinatorGroup[] {
    const groups: Record<string, CoordinatorGroup> = {};
    for (const room of source) {
      const existing = groups[room.coordinatorPubkey];
      if (existing) {
        existing.rooms.push(room);
      } else {
        groups[room.coordinatorPubkey] = {
          pubkey: room.coordinatorPubkey,
          origin: room.coordinatorOrigin,
          rooms: [room],
        };
      }
    }
    return Object.values(groups);
  }

  function openRoom(room: StoredRoom): void {
    onNavigate(createSameShellChatHref(window.location.origin, room));
  }

  function shortKey(pubkey: string): string {
    return pubkey.length > 14 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-5)}` : pubkey;
  }

  function serverHost(origin: string | undefined): string {
    if (!origin) return "Remote coordinator";
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  }

  function roomPreview(room: StoredRoom): string {
    const latest = room.messages.at(-1);
    if (latest) return `${latest.name}: ${latest.content}`;
    if (room.joinRequestSent) return "Waiting for admission";
    return "Open conversation";
  }

  onMount(() => {
    const refresh = () => revision += 1;
    window.addEventListener(ROOMS_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(ROOMS_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  });
</script>

<main
  class="chat-lobby operator-field"
  data-testid="chat-lobby"
  data-coordinator-locked={coordinatorLocked}
  data-coordinator-status={coordinatorStatus}
>
  <header class="lobby-bar">
    <button class="lobby-brand" type="button" aria-label="Open chats" onclick={() => onNavigate("/chats")}>
      <strong>Cordn</strong>
      <span>Chats</span>
    </button>
    <button class="coordinator-link" type="button" data-testid="manage-coordinator" onclick={() => onNavigate("/")}>
      <span class:online={!coordinatorLocked && coordinatorStatus === "running"} class="coordinator-dot" aria-hidden="true"></span>
      <span>{coordinatorLocked ? "Unlock coordinator" : "Coordinator"}</span>
      <span aria-hidden="true">→</span>
    </button>
  </header>

  <section class="lobby-main">
    <header class="lobby-heading">
      <div>
        <p>Chat</p>
        <h1>Your rooms</h1>
      </div>
      <span>{joinedRooms.length}</span>
    </header>

    <div class="lobby-scroll" data-testid="chat-lobby-scroll">
      {#if coordinators.length > 0}
        <div class="server-list">
          {#each coordinators as server (server.pubkey)}
            <section class="server-card" aria-label={`Coordinator ${shortKey(server.pubkey)}`}>
              <header>
                <span class="server-avatar" aria-hidden="true">{server.pubkey.slice(0, 2).toUpperCase()}</span>
                <span class="server-copy">
                  <strong>Coordinator {shortKey(server.pubkey)}</strong>
                  <small>{serverHost(server.origin)}</small>
                </span>
                <span class="server-count">{server.rooms.length}</span>
              </header>
              <div class="room-list">
                {#each server.rooms as room (`${room.coordinatorPubkey}:${room.id}`)}
                  <button type="button" class="room-row" aria-label={`Open room ${room.title}, hosted by ${hostIdentityForRoom(room).name}`} onclick={() => openRoom(room)}>
                    <span class="room-mark" aria-hidden="true">#</span>
                    <span class="room-copy">
                      <strong>{room.title}</strong>
                      <small>{roomPreview(room)}{room.coordinatorKeyMode === "ephemeral" ? " · Host uses a temporary key" : ""}</small>
                    </span>
                    <RoomHostBadge host={hostIdentityForRoom(room)} compact />
                  </button>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {:else}
        <div class="lobby-empty">
          <span aria-hidden="true">#</span>
          <h2>No joined rooms yet</h2>
          <p>Open an invite link on this device and it will stay available here.</p>
        </div>
      {/if}

      {#if currentLocalRooms.length > 0}
        <details class="local-rooms">
          <summary>
            <span>Current coordinator rooms</span>
            <span>{currentLocalRooms.length}</span>
          </summary>
          <p>{coordinatorLocked || coordinatorStatus !== "running" ? "The local coordinator is offline. Cached conversations remain available." : "The local coordinator is online."}</p>
          <div class="room-list">
            {#each currentLocalRooms as room (`${room.coordinatorPubkey}:${room.id}`)}
              <button type="button" class="room-row" aria-label={`Open hosted room ${room.title}, hosted by ${hostIdentityForRoom(room).name}`} onclick={() => openRoom(room)}>
                <span class="room-mark" aria-hidden="true">#</span>
                <span class="room-copy"><strong>{room.title}</strong><small>{roomPreview(room)}{room.coordinatorKeyMode === "ephemeral" ? " · Temporary coordinator key" : ""}</small></span>
                <RoomHostBadge host={hostIdentityForRoom(room)} compact />
              </button>
            {/each}
          </div>
        </details>
      {/if}

      {#if previousLocalRooms.length > 0}
        <details class="local-rooms previous-local-rooms" open>
          <summary>
            <span>{homeCoordinatorPubkey ? "Previous local sessions" : "Saved hosted sessions"}</span>
            <span>{previousLocalRooms.length}</span>
          </summary>
          <p>{homeCoordinatorPubkey
            ? "The coordinator key changed. Open a room to leave its saved copy from this device; the current coordinator cannot delete it."
            : "Unlock the coordinator to identify which saved sessions belong to its current key."}</p>
          <div class="room-list">
            {#each previousLocalRooms as room (`${room.coordinatorPubkey}:${room.id}`)}
              <button type="button" class="room-row" aria-label={`Open previous local session ${room.title}, hosted by ${hostIdentityForRoom(room).name}`} onclick={() => openRoom(room)}>
                <span class="room-mark" aria-hidden="true">↺</span>
                <span class="room-copy"><strong>{room.title}</strong><small>Coordinator {shortKey(room.coordinatorPubkey)}{room.coordinatorKeyMode === "ephemeral" ? " · Temporary key" : ""}</small></span>
                <RoomHostBadge host={hostIdentityForRoom(room)} compact />
              </button>
            {/each}
          </div>
        </details>
      {/if}
    </div>
  </section>
</main>

<style>
  .chat-lobby { display: grid; width: 100%; height: 100dvh; max-height: 100dvh; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; color: #dfffe7; }
  .lobby-bar { position: relative; z-index: 2; display: flex; min-width: 0; align-items: stretch; justify-content: space-between; border-bottom: 1px solid #21352a; background: rgb(7 12 9 / .96); }
  .lobby-brand, .coordinator-link { min-height: 3.5rem; border: 0; color: #dfffe7; }
  .lobby-brand { display: flex; min-width: 0; align-items: baseline; gap: .65rem; padding: .65rem 1rem; text-align: left; }
  .lobby-brand strong { color: #f0fff3; font-size: 1rem; letter-spacing: .04em; }
  .lobby-brand span { color: #718277; font-size: .58rem; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; }
  .coordinator-link { display: flex; align-items: center; gap: .55rem; border-left: 1px solid #21352a; padding: .65rem 1rem; color: #9db1a4; font-size: .64rem; }
  .lobby-brand:hover, .coordinator-link:hover { background: #111a14; color: #effff2; }
  .coordinator-dot { width: .42rem; height: .42rem; flex: 0 0 auto; border-radius: 999px; background: #68756d; }
  .coordinator-dot.online { background: #7cf59d; box-shadow: 0 0 9px rgb(124 245 157 / .48); }
  .lobby-main { display: grid; width: min(58rem, 100%); min-height: 0; margin-inline: auto; grid-template-rows: auto minmax(0, 1fr); border-inline: 1px solid #1c2d23; background: rgb(7 12 9 / .8); }
  .lobby-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #21352a; padding: 1.15rem 1.25rem; }
  .lobby-heading p { color: #7cf59d; font-size: .55rem; font-weight: 750; letter-spacing: .18em; text-transform: uppercase; }
  .lobby-heading h1 { margin-top: .25rem; color: #f2fff5; font-size: 1.35rem; font-weight: 650; letter-spacing: -.02em; }
  .lobby-heading > span { display: grid; min-width: 1.8rem; height: 1.8rem; place-items: center; background: #142219; color: #9bf6b3; font-size: .7rem; }
  .lobby-scroll { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .8rem; }
  .server-list { display: grid; gap: .7rem; }
  .server-card { overflow: hidden; border: 1px solid #293832; background: #080d0a; }
  .server-card > header { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .7rem; border-bottom: 1px solid #202d25; padding: .7rem .75rem; background: #0b120d; }
  .server-avatar { display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid #38503f; background: #112018; color: #8df5aa; font-size: .58rem; font-weight: 750; }
  .server-copy, .server-copy strong, .server-copy small { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .server-copy strong { color: #dfffe7; font-size: .7rem; font-weight: 650; }
  .server-copy small { margin-top: .22rem; color: #718277; font-size: .54rem; }
  .server-count { color: #7cf59d; font-size: .6rem; }
  .room-list { display: grid; gap: 1px; background: #17231b; }
  .room-row { display: grid; width: 100%; min-width: 0; min-height: 3.3rem; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .65rem; border: 0; background: #080d0a; padding: .6rem .8rem; color: #82958a; text-align: left; }
  .room-row:hover, .room-row:focus-visible { background: #132018; color: #7cf59d; outline: none; }
  .room-mark { color: #52675a; font-size: .85rem; }
  .room-copy, .room-copy strong, .room-copy small { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .room-copy strong { color: #dcebe0; font-size: .73rem; font-weight: 550; }
  .room-copy small { margin-top: .22rem; color: #66786d; font-size: .55rem; }
  .lobby-empty { display: grid; min-height: 15rem; place-content: center; justify-items: center; padding: 2rem; text-align: center; }
  .lobby-empty > span { display: grid; width: 2.8rem; height: 2.8rem; place-items: center; border: 1px solid #293832; color: #566c5d; }
  .lobby-empty h2 { margin-top: .9rem; color: #dcebe0; font-size: .92rem; font-weight: 600; }
  .lobby-empty p { max-width: 23rem; margin-top: .45rem; color: #718277; font-size: .65rem; line-height: 1.6; }
  .local-rooms { margin-top: .8rem; border: 1px solid #24332b; background: #070b08; }
  .local-rooms summary { display: flex; cursor: pointer; list-style: none; align-items: center; justify-content: space-between; gap: 1rem; padding: .7rem .8rem; color: #82958a; font-size: .6rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .local-rooms summary::-webkit-details-marker { display: none; }
  .local-rooms summary:hover { background: #101713; color: #b9cbbf; }
  .local-rooms > p { border-top: 1px solid #202d25; padding: .55rem .8rem; color: #66786d; font-size: .55rem; line-height: 1.5; }
  .previous-local-rooms { border-color: #4d4d31; }
  .previous-local-rooms > summary { color: #d9d68e; }
  .previous-local-rooms > p { color: #9d9e7d; }

  @media (max-width: 520px) {
    .lobby-brand, .coordinator-link { min-height: 3rem; padding: .55rem .7rem; }
    .coordinator-link { gap: .4rem; }
    .coordinator-link > span:nth-child(2) { max-width: 8.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lobby-heading { padding: .8rem .75rem; }
    .lobby-heading h1 { font-size: 1.05rem; }
    .lobby-heading > span { min-width: 1.55rem; height: 1.55rem; }
    .lobby-scroll { padding: .5rem; }
    .server-list { gap: .5rem; }
    .server-card > header { padding: .55rem .6rem; }
    .room-row { min-height: 3rem; padding: .5rem .65rem; }
  }
</style>
