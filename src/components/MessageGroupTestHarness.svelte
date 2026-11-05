<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { ReactionSummary, StoredMessage } from "../chat/room-store";
  import MessageGroup, { type ParticipantRoomChoice } from "./MessageGroup.svelte";

  type Operation = "invite" | "follow";
  type Outcome = "resolve" | "reject";

  interface Props {
    pane: "host" | "guest";
  }

  let { pane }: Props = $props();
  const viewerPubkey = "e".repeat(64);
  const participantPubkey = "d".repeat(64);
  const rooms: ParticipantRoomChoice[] = [{
    coordinatorPubkey: "a".repeat(64),
    roomId: "fixture-room",
    title: "Fixture room",
    coordinatorLabel: "Fixture coordinator",
  }];
  const messages: StoredMessage[] = [{
    type: "message",
    id: "fixture-message",
    sender: participantPubkey,
    name: "Participant",
    content: "A controllable participant fixture message",
    createdAt: 1,
  }];

  let activeParticipantSurfaceKey = $state<string | null>(null);
  let followStatus = $state<"idle" | "pending" | "success" | "error">("idle");
  const pending = new SvelteMap<Operation, { resolve: () => void; reject: () => void }>();

  function notify(operation: Operation, detail: Record<string, unknown>): void {
    window.dispatchEvent(new CustomEvent("cahmls-test-interaction-started", { detail: { pane, operation, ...detail } }));
  }

  function waitForOutcome(operation: Operation): Promise<void> {
    return new Promise((resolve, reject) => pending.set(operation, { resolve, reject }));
  }

  async function invite(participant: string, room: ParticipantRoomChoice): Promise<void> {
    notify("invite", { recipientPubkeys: [participant], roomId: room.roomId });
    await waitForOutcome("invite");
  }

  async function follow(participant: string): Promise<void> {
    followStatus = "pending";
    notify("follow", { participant });
    try {
      await waitForOutcome("follow");
      followStatus = "success";
    } catch (error) {
      followStatus = "error";
      throw error;
    }
  }

  onMount(() => {
    const settle = (event: Event) => {
      const detail = (event as CustomEvent<{ operation?: Operation; outcome?: Outcome }>).detail;
      if (!detail?.operation || !detail.outcome) return;
      const deferred = pending.get(detail.operation);
      if (!deferred) return;
      pending.delete(detail.operation);
      if (detail.outcome === "resolve") deferred.resolve();
      else deferred.reject(new Error(`${detail.operation} rejected by fixture`));
    };
    window.addEventListener("cahmls-test-interaction-settle", settle);
    return () => window.removeEventListener("cahmls-test-interaction-settle", settle);
  });
</script>

<main data-testid="message-group-test-harness">
  <MessageGroup
    {messages}
    {viewerPubkey}
    reactionsFor={() => [] as ReactionSummary[]}
    pickerOpenMessageId={null}
    participantSurfaceKey={`${pane}:fixture`}
    {activeParticipantSurfaceKey}
    idPrefix={pane}
    onTogglePicker={() => undefined}
    onClosePicker={() => undefined}
    onToggleReaction={() => undefined}
    onSetReaction={() => undefined}
    onActivateParticipantSurface={(key) => activeParticipantSurfaceKey = key}
    onDismissParticipantSurface={(key) => { if (activeParticipantSurfaceKey === key) activeParticipantSurfaceKey = null; }}
    onJoinInvite={() => undefined}
    participantRooms={rooms}
    followAvailable
    {followStatus}
    onInviteToRoom={invite}
    onFollow={follow}
  />
</main>
