# Phase 24: Chat User Interactions - Pattern Map

**Mapped:** 2026-08-06  
**Files analyzed:** 13  
**Analogs found:** 13 / 13

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/chat/protocol.ts` | model/protocol utility | transform | same file | exact |
| `src/chat/room-store.ts` | service/store | request-response | same file | exact |
| `src/chat/message-presentation.ts` | utility | transform | same file | exact |
| `src/chat/chat-participant-preferences.svelte.ts` | store | local-storage CRUD | `src/notifications/channel-preferences.svelte.ts` | role-match |
| `src/invites/nostr-social.svelte.ts` | service/store | pub-sub + request-response | same file | exact |
| `src/App.svelte` | provider/lifecycle | event-driven | same file | exact |
| `src/components/MessageGroup.svelte` | component | event-driven | same file / `UserProfile.svelte` | role-match |
| `src/components/HostWorkspace.svelte` | component/controller | request-response | same file | exact |
| `src/components/ChatRoute.svelte` | component/controller | request-response | same file | exact |
| `tests/unit/chat-protocol.test.ts` | test | transform | same file | exact |
| `tests/unit/chat-message-presentation.test.ts` | test | transform | `tests/unit/chat-protocol.test.ts` | partial |
| `tests/unit/chat-participant-preferences.test.ts` | test | local-storage CRUD | `tests/unit/nostr-invites.test.ts` | role-match |
| `tests/unit/nostr-invites.test.ts` | test | pub-sub + request-response | same file | exact |
| `tests/e2e/chat-user-interactions.spec.ts` | test | event-driven | new focused spec derived from `tests/e2e/workspace-lifecycle.spec.ts` fixtures and host/invitee coverage style | exact |

## Pattern Assignments

### `src/chat/protocol.ts` (protocol model, transform)

**Analog:** `src/chat/protocol.ts`

Add optional recipient metadata beside the signed user-controlled envelope fields; preserve its absence for legacy events. The conversion and compact proof must share the exact canonical recipient normalization.

**Signed conversion pattern** (`src/chat/protocol.ts:226-264`, `339-359`):

```ts
const currentCordnId = finalizeCordnMessageEvent(chatEnvelopeToCordnEvent(envelope)).id;
if (envelope.auth && (!hasValidChatEnvelopeAuth(envelope) || envelope.id !== currentCordnId)) {
  const safeEnvelope = { ...envelope };
  delete safeEnvelope.auth;
  wireEnvelope = safeEnvelope;
}

const canonicalId = finalizeCordnMessageEvent(chatEnvelopeToCordnEvent(envelope)).id;
const signed = await signer.signEvent(chatEnvelopeAuthTemplate(canonicalEnvelope));
```

**Tag/reaction separation** (`src/chat/protocol.ts:339-359`):

```ts
const tags: string[][] = [];
if (envelope.name.trim()) tags.push(["name", envelope.name.trim()]);
// Recipient `p` tags belong only to normal kind-9 messages.
if (envelope.reaction) {
  tags.push(envelope.reaction.targetPubkey
    ? ["e", envelope.reaction.targetMessageId, "", envelope.reaction.targetPubkey]
    : ["e", envelope.reaction.targetMessageId]);
  if (envelope.reaction.targetPubkey) tags.push(["p", envelope.reaction.targetPubkey]);
}
```

**Pitfalls:** Normalize 64-hex keys (lowercase, dedupe, first-seen ordering) once; emit/read normal-message `p` tags only for kind 9; include recipients in `chatEnvelopeAuthTemplate`; extend decode without making metadata required. Do not conflate these tags with NIP-25 reaction targets.

### `src/chat/room-store.ts` (session service, request-response)

**Analog:** `src/chat/room-store.ts:304-333`

Keep `ChatRoomSession.send(content, options?)` inside the existing exclusive queue so signing, MLS epoch advancement, pending persistence, and sync cannot interleave with reactions or other sends.

```ts
async send(content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;
  await this.runExclusive(async () => {
    if (this.stopped || this.status.connection !== "connected") throw new Error("...");
    const event = await signChatEnvelope({
      type: "message", id: crypto.randomUUID(), sender: this.room.stablePubkey,
      name: this.room.name, avatar: this.room.avatar, content: trimmed, createdAt: Date.now(),
    }, this.signer);
    const encrypted = await encryptMessage(decodeState(this.room.stateBase64), event);
    this.room.stateBase64 = encodeState(encrypted.state);
    this.room.messages = [...this.room.messages, { ...event, pending: true }];
    this.room.pending = [...this.room.pending, { id: event.id, opaqueBase64: encrypted.opaqueBase64 }];
    this.persist(); this.emit(); await this.syncOnce();
  });
}
```

The queue primitive is `operationQueue.then(operation, operation)` (`src/chat/room-store.ts:862-865`). Pass normalized recipient options into the envelope here; never parse composer display text later.

### `src/chat/message-presentation.ts` (projection utility, transform)

**Analog:** `src/chat/message-presentation.ts:8-39`

Extend the existing pure projection boundary, rather than filtering in `MessageGroup`. Deduplicate first, then filter targeted valid invites, then form consecutive sender streaks; add ignored-streak/disclosure information after that visible sequence.

```ts
export function groupMessageStreaks(messages: readonly StoredMessage[]): MessageStreak[] {
  const streaks: MessageStreak[] = [];
  for (const message of uniqueRenderableMessages(messages)) {
    const current = streaks.at(-1);
    if (current?.sender === message.sender) current.messages.push(message);
    else streaks.push({ sender: message.sender, messages: [message] });
  }
  return streaks;
}
```

```ts
const existingCursor = existing.cursor ?? -1;
const nextCursor = message.cursor ?? -1;
if (nextCursor > existingCursor || (existing.pending === true && message.pending !== true)) {
  unique.set(message.id, message);
}
```

**Pitfalls:** a non-target invite must leave no group/spacing; ordinary tagged messages remain visible; streak expansion keys must include `sender` plus first visible message ID, not just sender; derive mention emphasis from `recipientPubkeys.includes(viewerPubkey)`.

### `src/chat/chat-participant-preferences.svelte.ts` (private reactive store, local-storage CRUD)

**Analog:** `src/notifications/channel-preferences.svelte.ts:43-72`

Follow the versioned, defensive local-storage schema and reactive class pattern. Persist only exact-room ignore keys `(coordinatorPubkey, roomId, participantPubkey)` and global pubkey-to-palette mapping—never messages, invite URLs, or room transport records.

```ts
set(key: string, value: ChannelPreferences): void {
  const channels = { ...this.channels };
  if (value.sound === "global" && value.notifications === "all") delete channels[key];
  else channels[key] = value;
  this.channels = channels;
  localStorage.setItem(CHANNEL_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, channels }));
}

function readChannels(): Record<string, ChannelPreferences> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHANNEL_PREFERENCES_STORAGE_KEY) ?? "null") as { version?: number; channels?: Record<string, ChannelPreferences> } | null;
    if (parsed?.version !== 1 || !parsed.channels || typeof parsed.channels !== "object") return {};
    return Object.fromEntries(/* validate every stored entry */);
  } catch { return {}; }
}
```

### `src/invites/nostr-social.svelte.ts` (contact-list service/store, pub-sub + request-response)

**Analog:** `src/invites/nostr-social.svelte.ts:61-149`, `163-177`, `188-223`

Retain one `NostrSocialStore` owner and make its contact-list path injectable enough to unit test pool/query/subscribe/publish behavior. Separate kind-3 state/subscription from existing gift-wrap presence subscription if needed, but reset both on identity change.

```ts
const [ownLists, followerCandidates] = await Promise.all([
  this.pool.querySync(SOCIAL_RELAYS, { kinds: [3], authors: [this.pubkey], limit: 10 }, { maxWait: 4_000 }),
  this.pool.querySync(SOCIAL_RELAYS, { kinds: [3], "#p": [this.pubkey], limit: 500 }, { maxWait: 4_000 }),
]);
```

```ts
async sendInvite(recipient: string, inviteUrl: string, roomTitle: string): Promise<void> {
  if (!this.signer || !this.pool) throw new Error("Connect a NIP-07 or NIP-46 identity first");
  const event = await createGiftWrap(this.signer, recipient, INVITE_RUMOR_KIND, payload, 1059);
  await Promise.any(this.pool.publish(SOCIAL_RELAYS, event));
}
```

**Required hardening:** accept only `verifyEvent(event)`, `kind === 3`, and exact active pubkey; select replacements by higher `created_at`, then lexicographically lower `id`; subscribe before/with refresh and route both through one reducer; serialize refresh→merge→strictly-newer sign→`Promise.any(publish)`; preserve content and non-`p` tags; update `following` only after acceptance. Do not expose relay diagnostics or signed event content in UI errors.

### `src/App.svelte` (identity lifecycle provider, event-driven)

**Analog:** `src/App.svelte:24-31`; move the contact-list lifecycle here from the optional `UserProfile` surface (`src/components/UserProfile.svelte:45-57`).

```ts
const identityReady = $derived(userProfileStore.initialized);

$effect(() => {
  void userProfileStore.initialize(configStore.userName);
});
```

Start/reset kind-3 ownership based on initialized identity, active signer, pubkey, and non-anonymous method. Cleanup must invalidate stale async work and subscriptions when identity changes.

### `src/components/MessageGroup.svelte` (shared interaction component, event-driven)

**Analogs:** `src/components/MessageGroup.svelte:1-164`; overlay/focus behavior from `src/components/UserProfile.svelte:106-112,116-148` and `src/lib/viewport-overlay.ts:86-153`.

Make this the only author control/menu surface and receive host/guest behavior through callbacks/props. Non-self only. Store the exact trigger element, use a single `open` state, move focus to first enabled action, and on Escape/outside close return focus with `tick()`.

```svelte
<button bind:this={trigger} aria-haspopup="dialog" aria-expanded={open}
  onclick={() => open ? closeMenu() : open = true}>…</button>
{#if open}
  <button class="user-scrim" type="button" aria-label="Close profile menu" onclick={closeMenu}></button>
  <div use:viewportOverlay={{ anchor: trigger, preferredSide: "above", align: "start" }} role="dialog">…</div>
{/if}
```

`viewportOverlay` provides popover top-layer promotion, scroll/resize repositioning, flip and max-height (`src/lib/viewport-overlay.ts:89-148`). Use it rather than overflow-prone absolute positioning. For valid invite content, continue rendering only the join action—never raw invite/mention text in bubbles, labels, or errors.

### `src/components/HostWorkspace.svelte` and `src/components/ChatRoute.svelte` (pane controllers, request-response)

**Analogs:** host `src/components/HostWorkspace.svelte:1199-1213,1807-1827`; guest `src/components/ChatRoute.svelte:558-575,727-755`.

Both panes must own matching composer recipient state and send recovery, and both must call the same projection before rendering `MessageGroup`.

```ts
const message = composer;
session.setIdentity(currentHostIdentity());
composer = "";
try {
  await session.send(message);
} catch (cause) {
  if (!composer.trim()) composer = message;
  error = cause instanceof Error ? cause.message : "Unable to send this message";
}
```

```svelte
{#each groupMessageStreaks(room.messages) as streak (`${streak.sender}:${streak.messages[0].id}`)}
  <MessageGroup messages={streak.messages} viewerPubkey={room.stablePubkey} idPrefix="host" … />
{/each}
```

For invite-to-room reuse host canonical URL construction at `src/components/HostWorkspace.svelte:538-561` (`createInviteUrl` and current room metadata). Restrict choices to active stored rooms other than current room; send the URL via the current session with exactly the selected author pubkey. Preserve text *and* recipient metadata on send failure. Keep `idPrefix="host"`/`"guest"` for DOM uniqueness and parity.

### Tests (unit and browser)

**Unit analogs:** `tests/unit/chat-protocol.test.ts:18-176` uses real local signers plus `signChatEnvelope → encryptMessage → decryptMessage`; `tests/unit/nostr-invites.test.ts:19-108` uses `beforeEach(() => localStorage.clear())` and directly constructs stores.

```ts
beforeEach(() => localStorage.clear());

const signed = await signChatEnvelope({ /* test envelope */ }, signer);
expect(hasValidChatEnvelopeAuth(signed)).toBe(true);
for (const forged of [{ ...signed, createdAt: signed.createdAt + 1 }]) {
  expect(hasValidChatEnvelopeAuth(forged as typeof signed)).toBe(false);
}
```

Add injected fake pool/signer/clock seams for kind-3 tests: invalid/foreign ingress, equal-second ID choice, subscription/query race, serial follow mutation, all-relay failure leaves state unchanged. Add pure projection/preference test files rather than DOM-testing those concerns. Create focused `chat-user-interactions.spec.ts` coverage that reuses the fixtures and event-driven host/invitee coverage conventions from `workspace-lifecycle.spec.ts` for keyboard menu behavior, focus return, targeted invite no-node/no-space, 320px overlay containment, and reload persistence.

## Shared Patterns

### Host/invitee parity

**Sources:** `src/components/HostWorkspace.svelte:1807-1824`, `src/components/ChatRoute.svelte:727-744`.

Both already send `viewerPubkey`, reaction callbacks, join callback, and an ID prefix through the common `MessageGroup`; new participant props must follow this callback-only seam rather than fork UI logic.

### Safe persistent state

**Source:** `src/notifications/channel-preferences.svelte.ts:65-72`.

Use a versioned JSON shape, a `try/catch` parser, runtime entry validation, and a no-op/default for malformed browser state. Avoid `StoredRoom` for private preferences.

### Overlay containment and focus

**Sources:** `src/components/UserProfile.svelte:106-112,146-148`; `src/lib/viewport-overlay.ts:86-153`.

Use a close-on-Escape listener plus a viewport overlay anchored to the actual trigger. The action promotes into a manual popover, recomputes on resize/scroll, clamps width and sets internal `overflowY`; caller owns exact focus restoration.

### Protocol and relay acceptance

**Sources:** `src/chat/protocol.ts:226-289`; `src/invites/nostr-social.svelte.ts:163-177`.

User-controlled presentation additions require canonical event serialization *and* compact-auth coverage. Relay-backed success must await `Promise.any(pool.publish(...))`; contact UI state follows acceptance, never precedes it.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| None | — | — | Every required responsibility has an established local analog; participant preferences and contact-list injection are new compositions of existing local-storage/store and service patterns. |

## Metadata

**Analog search scope:** `src/chat`, `src/components`, `src/invites`, `src/lib`, `src/notifications`, `tests/unit`, `tests/e2e`  
**Files scanned:** 17  
**Pattern extraction date:** 2026-08-06
