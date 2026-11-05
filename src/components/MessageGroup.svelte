<script lang="ts">
  import type { ChatEmojiShortcut } from "@cahmls/sdk/client";
  import { parseInviteMessage, type ChatInvite, type RoomHostIdentity } from "@cahmls/sdk/client";
  import type { ReactionSummary, StoredMessage } from "@cahmls/sdk/client";
  import { createPubkeyAvatar } from "../identity/user-profile.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import MessageTimestamp from "./MessageTimestamp.svelte";

  interface Props {
    messages: StoredMessage[];
    viewerPubkey: string;
    reactionsFor: (messageId: string) => ReactionSummary[];
    pickerOpenMessageId: string | null;
    disabled?: boolean;
    idPrefix: "host" | "guest";
    onTogglePicker: (messageId: string) => void;
    onClosePicker: (messageId: string) => void;
    onToggleReaction: (messageId: string, emoji: ChatEmojiShortcut) => void | Promise<void>;
    onSetReaction: (messageId: string, emoji: ChatEmojiShortcut) => void | Promise<void>;
    onJoinInvite: (invite: ChatInvite) => void;
  }

  let {
    messages,
    viewerPubkey,
    reactionsFor,
    pickerOpenMessageId,
    disabled = false,
    idPrefix,
    onTogglePicker,
    onClosePicker,
    onToggleReaction,
    onSetReaction,
    onJoinInvite,
  }: Props = $props();

  const first = $derived(messages[0]);
  const mine = $derived(first?.sender === viewerPubkey);
  const host = $derived(Boolean(first?.badgeLabel || first?.badgeEmoji));
  const fallbackAvatar = $derived(first ? createPubkeyAvatar(first.sender) : "");

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
    class="message-streak"
    data-testid="message-streak"
    data-sender={first.sender}
    data-message-count={messages.length}
    aria-label={`${first.name || "anon"}, ${messages.length} ${messages.length === 1 ? "message" : "messages"}`}
  >
    <img class="streak-avatar" data-testid="message-avatar" src={first.avatar || fallbackAvatar} alt="" onerror={useFallback} />
    <div class="streak-content">
      <div class="streak-author" data-testid="message-author">
        <strong>{first.name || "anon"}</strong>
        {#if host}
          <span class="message-badge" data-testid="message-badge">
            {#if first.badgeEmoji}<span aria-hidden="true">{first.badgeEmoji}</span>{/if}
            {first.badgeLabel || "host"}
          </span>
        {/if}
      </div>
      <div class="streak-messages">
        {#each messages as message (message.id)}
          {@const reactions = reactionsFor(message.id)}
          {@const sharedInvite = parseInviteMessage(message.content)}
          <article class:host class={`message-bubble ${idPrefix === "host" ? "host-message" : "message"}`} data-testid="message-bubble" data-message-id={message.id}>
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
  .streak-messages { display: grid; gap: .18rem; }
  .message-bubble { position: relative; z-index: 0; min-width: 5rem; border: 0; background: #1a241e; padding: .48rem .72rem .72rem; color: #dce8df; }
  .message-bubble:hover, .message-bubble:focus-within, .message-bubble:has(:global(.picker-open)) { z-index: 4; }
  .message-bubble:has(:global(.has-reactions)) { margin-bottom: .72rem; }
  .mine .message-bubble { background: #162019; color: #cbd7ce; }
  .message-streak.host:not(.mine) .message-bubble { background: #18291d; box-shadow: inset 2px 0 rgb(124 245 157 / .12); }
  .mine .message-bubble.host { background: #162019; box-shadow: none; }
  .message-bubble p { white-space: pre-wrap; overflow-wrap: anywhere; }
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
</style>
