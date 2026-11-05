# Phase 24: Chat User Interactions - Research

**Researched:** 2026-08-06
**Domain:** Signed Cordn kind-9 presentation metadata, local chat preferences, and Nostr kind-3 contact lists
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- The participant menu belongs to the visible author identity (name/avatar) and is available only for other participants, never for the viewer's own messages.
- Mentions remain editable human-readable composer text, but recipient identity is carried by signed structured metadata (`p` tags) so presentation does not depend on ambiguous names.
- A message explicitly mentioning the viewer is more prominent. A normal message mentioning someone else stays visually ordinary for the viewer.
- Invite messages use the same structured targets. Untagged invites are public to the room; tagged invites are rendered only for tagged viewers. Non-target viewers see no bubble, author row, or placeholder for that invite. This is a UX filter, not a confidentiality boundary.
- Mention tokens accompanying an invite are never rendered as chat text; the invite is represented only by its join action.
- Ignore state is private, local, persisted, and scoped to the exact `(coordinatorPubkey, roomId, participantPubkey)` identity. Each existing consecutive author streak becomes one centered disclosure with its message count and can be expanded independently.
- Invite-from-user opens a compact chooser of other active stored rooms, excluding the current room and retired history. Choosing a room sends its current canonical invite URL into the current conversation with the selected user's pubkey as the sole target.
- Follow modifies the signed-in operator's Nostr kind-3 contact list. Anonymous operators see the action disabled with sign-in guidance rather than silently creating a local-only follow.
- Contact-list ingress accepts only signature-valid kind-3 events authored by the active pubkey. Newest selection uses `created_at`, then event id as a deterministic tie-break. A live subscription keeps the selected event current.
- Follow publication is serialized, refreshes before mutation, preserves content and all unrelated tags, deduplicates `p` tags, signs a strictly newer replacement, and updates local state only after at least one relay accepts it.
- Highlight colors are private presentation preferences keyed by participant pubkey and persist locally across sessions. The palette is constrained to accessible theme-compatible accents and includes a clear/default choice.

### the agent's Discretion

No explicit discretion section was captured in CONTEXT.md.

### Deferred Ideas (OUT OF SCOPE)

- Targeted invite messages are not cryptographically hidden from other room members.
- This phase does not add blocking, reporting, moderation authority, server-side profiles, or cross-device preference synchronization.
- This phase does not rewrite historical plaintext mention text into structured targets.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| USER-01 | Non-self author context menu in both panes | Shared `MessageGroup` owns the trigger/menu; host and invitee pass the same props. [VERIFIED: codebase grep] |
| MENTION-01 | Editable text plus signed kind-9 `p` target | Add canonical recipient metadata to the envelope, Cordn tags, auth template, and `ChatRoomSession.send`. [VERIFIED: codebase grep] |
| MENTION-02 | Viewer-only accessible mention emphasis | Derive from canonical recipients at the presentation boundary. [VERIFIED: codebase grep] |
| INVMSG-01 | Public/targeted invite presentation | Filter targeted invite messages before dedupe/streak grouping. [VERIFIED: codebase grep] |
| IGNORE-01 | Exact-room persisted ignores and expandable streaks | Keep a separate local preference store keyed by exact room target and participant; expansion is UI-only per streak. [VERIFIED: codebase grep] |
| INVUSER-01 | Invite a participant to another active room | Build a current invite URL from a qualifying stored room and send it with exactly one recipient. [VERIFIED: codebase grep] |
| FOLLOW-01 | Valid newest live kind-3 state | A managed identity-lifecycle contact-list store validates and deterministically selects events. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] |
| FOLLOW-02 | Serialized safe follow publication | Queue refresh→merge→strictly-newer sign→relay acceptance and commit local state last. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] [CITED: github.com/nostr-protocol/nips/blob/master/02.md] |
| HILITE-01 | Persistent global private highlight | Persist validated palette choice by participant pubkey and render it from shared message presentation. [VERIFIED: codebase grep] |
</phase_requirements>

## Project Constraints (from AGENTS.md)

- Preserve unrelated worktree changes and own only this phase artifact. [VERIFIED: AGENTS.md]
- Use Svelte 5 runes, strict TypeScript, browser-safe APIs, and established local component/state patterns; do not add Node-only runtime dependencies. [VERIFIED: AGENTS.md]
- Do not log, fixture, snapshot, or commit private keys, invite secrets, or decrypted message material. [VERIFIED: AGENTS.md]
- Use `apply_patch` for intentional source edits and run narrow checks while iterating. [VERIFIED: AGENTS.md]
- Chat protocol and Cordn-admission changes require `pnpm check:upstream` and `pnpm test:upstream-interop`, plus existing browser invite coverage. [VERIFIED: AGENTS.md]
- The standard complete quality gate is lint, TypeScript, unit tests, E2E tests, build, and `git diff --check`. [VERIFIED: AGENTS.md]

## Summary

Phase 24 should extend the already shared message path, not fork host and invitee chat behavior. `HostWorkspace.svelte` and `ChatRoute.svelte` both render `groupMessageStreaks(...)->MessageGroup` and both call `ChatRoomSession.send`; `MessageGroup.svelte` is consequently the single visual/action surface, while protocol tags and session send options belong below it. [VERIFIED: codebase grep]

The least risky canonical encoding is an optional `recipientPubkeys` field on `ChatEnvelope`, normalized to distinct lowercase 64-hex keys and serialized as one `['p', pubkey]` tag per recipient on a kind-9 Cordn event. The existing compact `signChatEnvelope` proof must include this field; decoding absent metadata stays compatible with stored and third-party legacy messages. NIP-01 defines `p` tags as public-key references, while the current MLS envelope and signed presentation proof provide the relevant integrity boundary for this application. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] [VERIFIED: src/chat/protocol.ts]

**Primary recommendation:** Add pure message-projection and preference modules, extend the existing signed envelope/session send API, keep `MessageGroup` as the shared interaction component, and harden a single identity-lifecycle kind-3 owner before adding its UI action. [VERIFIED: codebase grep]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Canonical kind-9 recipient metadata | API / Backend-equivalent protocol layer | Browser / Client | The protocol serializer/decoder and signer determine what metadata is authenticated; UI only supplies intent. [VERIFIED: src/chat/protocol.ts] |
| MLS send of mention/targeted invite | API / Backend-equivalent session layer | Browser / Client | `ChatRoomSession.send` signs, encrypts, persists pending state, and syncs. [VERIFIED: src/chat/room-store.ts] |
| Targeted-invite visibility and streak construction | Browser / Client presentation layer | — | It is explicitly a viewer-local UX filter and must occur before component layout grouping. [VERIFIED: src/chat/message-presentation.ts] |
| Ignore/highlight preferences | Browser / Client storage | Browser / Client presentation | They are private local preferences, never room state or wire data. [VERIFIED: 24-CONTEXT.md] |
| Participant menu, chooser, disclosure, focus return | Browser / Client | CDN / Static overlay helper | The shared Svelte component and existing viewport overlay own keyboard and clipping behavior. [VERIFIED: src/components/MessageGroup.svelte] [VERIFIED: src/lib/viewport-overlay.ts] |
| Kind-3 ingress and follow publication | Browser / Client Nostr-service layer | External Nostr relays | The browser validates, orders, signs, and publishes; relays only transport accepted events. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---|---:|---|---|
| `svelte` | 5.56.3 | Runes state and shared components | Already used by all affected panes and stores. [VERIFIED: package.json] |
| `nostr-tools` | 2.23.5 | `verifyEvent`, event signing helpers/types, `SimplePool`, and NIP-19 URL support | Already provides the project’s event verification/pooling primitives; no additional package is required. [VERIFIED: package.json] [VERIFIED: src/chat/protocol.ts] |
| `@contextvm/sdk` | 0.13.10 | `NostrSigner` abstraction | Existing chat and identity code sign through this abstraction. [VERIFIED: package.json] [VERIFIED: src/chat/room-store.ts] |

### Supporting

| Library | Version | Purpose | When to Use |
|---|---:|---|---|
| `SimplePool` from `nostr-tools` | 2.23.5 | Query, live subscription, and relay publication | Reuse for the single kind-3 contact-list owner. [VERIFIED: src/invites/nostr-social.svelte.ts] |
| `viewportOverlay` | local | Top-layer menu/chooser placement and viewport containment | Use for the participant menu; use the project’s dialog/overlay pattern for the room chooser. [VERIFIED: src/lib/viewport-overlay.ts] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Shared `MessageGroup` extension | Separate host and guest participant menus | Duplicates focus, filtering, and presentation behavior across two already-parallel panes. [VERIFIED: codebase grep] |
| Existing `SimplePool` | New Nostr client package | Adds a dependency without solving any unmet requirement. [VERIFIED: package.json] |
| Local preference record | Adding ignore/highlight fields to `StoredRoom` or network messages | Violates private, global-highlight, exact-room-ignore scope and risks sharing presentation state. [VERIFIED: 24-CONTEXT.md] |

**Installation:** No external packages. [VERIFIED: package.json]

## Architecture Patterns

### System Architecture Diagram

```text
Author trigger (shared MessageGroup)
  ├─ Mention ──> host/guest composer state: visible text + recipient set
  ├─ Invite ───> active StoredRoom chooser ──> canonical invite URL + sole recipient
  ├─ Ignore ───> local exact-room preference store
  ├─ Highlight > local global participant preference store
  └─ Follow ───> serialized kind-3 contact-list service ──> social relays

host/guest send handler
  └─ ChatRoomSession.send(content, { recipientPubkeys })
       └─ signChatEnvelope ─> kind-9 p tags ─> MLS encrypt/persist/sync

stored/decrypted messages
  └─ unique renderable messages ─> targeted-invite viewer filter ─> streak grouping
       └─ ignore-disclosure projection ─> MessageGroup render
```

### Exact Existing Call Paths

| Surface | Rendering path | Composer/send path | Planner consequence |
|---|---|---|---|
| Hosted room | `HostWorkspace.svelte` host log → `groupMessageStreaks(room.messages)` → `MessageGroup` with `idPrefix='host'` | Host form → local `send()` → `session.setIdentity(currentHostIdentity())` → `session.send(message)` | Replace only the grouping input and enrich the same shared props; preserve `currentHostIdentity`. [VERIFIED: src/components/HostWorkspace.svelte] |
| Invitee/embedded room | `ChatRoute.svelte` guest log → `groupMessageStreaks(currentRoom.messages)` → `MessageGroup` with `idPrefix='guest'` | Guest form → local `send()` → `session.setIdentity({displayName, avatarUrl})` → `session.send(next)` | Apply the same projection and sender options here; failed send must restore both text and target metadata. [VERIFIED: src/components/ChatRoute.svelte] |
| Wire/session | UI `session.send` → `ChatRoomSession.send` → `signChatEnvelope` → `encryptMessage` → persisted pending message → `syncOnce` | `decryptMessage` → Cordn event decode → `StoredMessage` → shared render | Add recipient metadata at this layer, not by parsing display names in the renderer. [VERIFIED: src/chat/room-store.ts] [VERIFIED: src/chat/protocol.ts] |

### Pattern 1: Backward-Compatible Recipient Metadata

**What:** Model recipient metadata as optional `recipientPubkeys?: string[]` on `ChatEnvelope`; normalize it once at the protocol boundary and map it to canonical `p` tags only for normal kind-9 messages. [VERIFIED: src/chat/protocol.ts]

**When to use:** Ordinary mentions and targeted room invites use the same field; reactions retain their existing NIP-25-related `p` tag path and must not accept recipient metadata. [VERIFIED: src/chat/protocol.ts]

**Required protocol changes:**

1. Add a strict `normalizeRecipientPubkeys(value)` helper: arrays only, valid 64-hex values only, lowercased, deduplicated, stable first-seen order; invalid input produces no canonical recipient metadata. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]
2. Extend `chatEnvelopeToCordnEvent` to emit one `['p', pubkey]` per normalized recipient for kind 9, preserving existing name/avatar/badge tags and reaction behavior. [VERIFIED: src/chat/protocol.ts]
3. Extend `cordnEventToChatEnvelope` to recover all valid kind-9 `p` tags into the optional field; messages without any remain legacy-compatible. [VERIFIED: src/chat/protocol.ts]
4. Include recipient metadata in `chatEnvelopeAuthTemplate`; otherwise a post-sign mutation could change mention emphasis or invite visibility. [VERIFIED: src/chat/protocol.ts]
5. Change `ChatRoomSession.send(content, options?: { recipientPubkeys?: readonly string[] })`; create the envelope and proof inside its existing `runExclusive` queue. [VERIFIED: src/chat/room-store.ts]

```ts
// Source: local protocol pattern in src/chat/protocol.ts
const recipientPubkeys = normalizeRecipientPubkeys(envelope.recipientPubkeys);
if (!envelope.reaction) {
  for (const pubkey of recipientPubkeys) tags.push(["p", pubkey]);
}
```

**Signing implication:** Existing `signChatEnvelope` signs a compact kind `24242` proof over all user-controlled envelope fields and `encryptMessage` rejects an invalid/mismatched proof before converting to the Cordn event. Recipient metadata must be included in both the proof payload and the canonical kind-9 event hash calculation. [VERIFIED: src/chat/protocol.ts]

### Pattern 2: Project First, Then Group

**What:** Promote unique rendering and targeted-invite filtering into exported pure presentation helpers, then feed the visible sequence to streak grouping. [VERIFIED: src/chat/message-presentation.ts]

**When to use:** Both chat logs call one `projectMessageStreaks(messages, viewerPubkey)` (or equivalent), not `groupMessageStreaks` directly. [VERIFIED: codebase grep]

```ts
// Source: local grouping pattern in src/chat/message-presentation.ts
const renderable = uniqueRenderableMessages(messages);
const visible = renderable.filter((message) => {
  const invite = parseInviteMessage(message.content);
  const targets = message.recipientPubkeys ?? [];
  return !invite || targets.length === 0 || targets.includes(viewerPubkey);
});
return groupConsecutiveBySender(visible);
```

**Required semantics:** A non-target tagged invite is removed before the group loop, so it contributes neither a DOM row nor inter-streak spacing. A public invite (`targets.length === 0`) remains visible. A regular message with `p` tags remains visible to everyone; only a valid invite message uses target filtering. [VERIFIED: 24-CONTEXT.md] [VERIFIED: src/chat/invite.ts]

### Pattern 3: Composer Targets Are Not Text Parsing

**What:** Each pane owns a local `pendingRecipientPubkeys` set/array alongside its existing composer string. Selecting Mention inserts `@display-name` at the input selection where practical and adds the pubkey independently. [VERIFIED: src/components/ChatRoute.svelte] [VERIFIED: src/components/HostWorkspace.svelte]

**When to use:** Mention selection and invite-from-user dispatch. Clear text and targets only after `session.send` succeeds; on error restore both exact pre-send values. [VERIFIED: src/chat/room-store.ts]

**Invite dispatch:** Build the room URL with `createInviteUrl(window.location.origin, storedRoom-derived input)` at click time, using stored `id`, coordinator pubkey, relay URLs, title, origin/name/host metadata, and any current invite token. Qualify choices with `membershipStatus !== 'retired'` and `!sameRoomIdentity(candidate, currentRoom)`. `listRooms()` contains both active and retired records, so it cannot be used unfiltered. [VERIFIED: src/chat/room-store.ts] [VERIFIED: src/chat/invite.ts]

### Pattern 4: Preferences Are Separate Local Presentation State

**What:** Create a small browser-only `chat-participant-preferences.svelte.ts` (or equivalent) with a versioned localStorage record, strict parse/repair, and a reactive API. [ASSUMED]

**Exact keys:**

- Ignore: `roomIdentityKey(coordinatorPubkey, roomId) + '\u0000' + participantPubkey`; do not key only by room id because the repository explicitly treats `(coordinatorPubkey, roomId)` as the authoritative room identity. [VERIFIED: src/chat/room-store.ts]
- Highlight: participant pubkey only, normalized lowercase; this is intentionally global across rooms and both panes. [VERIFIED: 24-CONTEXT.md]

**Expansion model:** Do not persist expanded/collapsed state. Pass each post-filter streak a stable local key such as `${sender}:${messages[0].id}`; the parent pane keeps an ephemeral `Set<string>` of expanded ignored streaks, so two separate ignored streaks do not expand together. A collapsed ignored streak renders only the centered disclosure button; an expanded one renders the unchanged `MessageGroup` content. [VERIFIED: src/chat/message-presentation.ts] [VERIFIED: 24-CONTEXT.md]

**Palette:** Store only `undefined | 'lime' | 'gold' | 'cyan' | 'violet' | 'rose'`; map to the locked values (`#7cf59d`, `#f1f58f`, `#86ddff`, `#c4a6ff`, `#ffaaa3`) in CSS. Apply color only to decorative rails/author affordance, retain existing high-contrast text, expose the named choice in the menu, and never replace the explicit `Mentioned you` label. [VERIFIED: 24-UI-SPEC.md]

### Pattern 5: One Managed Kind-3 Owner

**What:** Harden `NostrSocialStore` as the single identity-scoped contact-list owner (or extract an injected `ContactListController` used by it), rather than creating a second divergent `following` cache. [VERIFIED: src/invites/nostr-social.svelte.ts]

**Lifecycle:** Add an idempotent method such as `startContactList(signer)` / `stopContactList()` and invoke it from `App.svelte` when `userProfileStore.initialized`, `activeSigner`, `pubkey`, and a non-anonymous method are all ready. Invoke stop/reset on anonymous/logout/identity replacement. `App.svelte` already starts `userProfileStore.initialize(...)`; the current social connect is a `$effect` inside `UserProfile.svelte`, which means it depends on that component being rendered. [VERIFIED: src/App.svelte] [VERIFIED: src/components/UserProfile.svelte]

**Ingress algorithm:**

1. Maintain an identity generation/token, the active pubkey, current validated event, and one live subscription; dispose and clear on identity change. [ASSUMED]
2. Start the live kind-3 subscription for `{ kinds:[3], authors:[activePubkey] }` before or alongside the initial bounded query; send every result through one `consider(event)` reducer. This covers query/subscription ordering races. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]
3. `consider` accepts only `event.kind === 3`, exact active `event.pubkey`, and `verifyEvent(event) === true`; ignore malformed, invalid-signature, foreign-author, and stale-generation events. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] [VERIFIED: package.json]
4. Select newer by higher `created_at`; on equal seconds, select lexicographically *lower* `id`, as NIP-01 specifies for replaceable events. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]
5. Derive `following` from valid `p` tags only, normalized/deduped, while retaining the selected full event for future merge. [CITED: github.com/nostr-protocol/nips/blob/master/02.md]
6. Keep the last validated state on query/subscription failure; surface a generic reconnectable status, never replace it with unvalidated or empty data merely because a refresh failed. [ASSUMED]

**Current weaknesses to close:** `refreshSocialGraph` presently accepts queried kind-3 events without `verifyEvent`, chooses by `created_at` only, has no own kind-3 live subscription, and runs only after `UserProfile` renders/connects. Its contact mutation path does not exist yet, so it has no serialization or publish-acceptance transaction. [VERIFIED: src/invites/nostr-social.svelte.ts] [VERIFIED: src/components/UserProfile.svelte]

**Follow transaction:** Serialize all follows in a single promise queue; inside the critical section refresh/merge the selected state, retain exact `content` and all non-`p` tags, dedupe valid `p` targets without reordering first occurrences, append the new target when absent, set `created_at = max(floor(Date.now()/1000), selected.created_at + 1)`, sign, verify the returned event is valid kind 3 from the active pubkey, and await `Promise.any(pool.publish(SOCIAL_RELAYS, signed))`. Update `currentEvent`/`following` only after at least one relay accepts. NIP-02 requires each new follow list to contain the full list and recommends appending new follows. [CITED: github.com/nostr-protocol/nips/blob/master/02.md] [CITED: github.com/nostr-protocol/nips/blob/master/01.md] [VERIFIED: src/invites/nostr-social.svelte.ts]

**Publication failure behavior:** Leave local selected state unchanged, clear the pending marker, retain the menu/chooser action for retry, and show the locked generic error copy. Do not log outgoing event content, invite URL, relay diagnostics, or signer material. Suppress an early echo of the pending event until relay acceptance resolves; independently received valid events from another device may still update the selected state. [VERIFIED: AGENTS.md] [ASSUMED]

### Recommended Project Structure

```text
src/
├── chat/
│   ├── protocol.ts                         # canonical recipient tags + signed envelope fields
│   ├── room-store.ts                       # send options retained through MLS/session queue
│   ├── message-presentation.ts             # visibility-first streak projection
│   └── chat-participant-preferences.svelte.ts # private exact-room/global preferences
├── invites/
│   └── nostr-social.svelte.ts              # validated, live, serialized kind-3 owner
├── components/
│   ├── MessageGroup.svelte                 # author trigger, menu, highlight/mention affordances
│   ├── HostWorkspace.svelte                # host projection/composer/chooser wiring
│   └── ChatRoute.svelte                    # invitee projection/composer/chooser wiring
└── App.svelte                              # earliest identity-ready contact-list lifecycle binding
```

### Anti-Patterns to Avoid

- **Filtering inside `MessageGroup`:** It leaves an already-created streak section and spacing for a non-target invite. Filter the message sequence first. [VERIFIED: src/chat/message-presentation.ts]
- **Inferring recipients from `@name`:** Names are editable and ambiguous; use only signed recipient pubkeys. [VERIFIED: 24-CONTEXT.md]
- **Persisting ignore/highlight inside a room record:** Room records carry transport/session state and can be shared/migrated; preferences must remain viewer-local. [VERIFIED: src/chat/room-store.ts] [VERIFIED: 24-CONTEXT.md]
- **Publishing a kind-3 from only the in-memory list:** It can overwrite another device’s newer replacement. Refresh and compare while serialized first. [CITED: github.com/nostr-protocol/nips/blob/master/02.md]
- **Treating a relay query as authentic:** An author filter is insufficient; verify the Nostr event signature before it influences following state. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]
- **Making `UserProfile.svelte` own follow correctness:** Opening/rendering a menu must not determine contact-list freshness. [VERIFIED: src/components/UserProfile.svelte]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Nostr event signature validation | Custom Schnorr/hash verification | `nostr-tools` `verifyEvent` | Canonical serialization and signature verification are security-sensitive. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] [VERIFIED: package.json] |
| Relay query/subscription/publication | Custom WebSocket protocol client | Existing `SimplePool` | The project already uses it for social query, subscription, and `Promise.any` publication. [VERIFIED: src/invites/nostr-social.svelte.ts] |
| Menu viewport placement | Absolute positioning inside scroll log | `viewportOverlay` | It promotes an anchored surface to the top layer and tracks scroll/resize/compact width. [VERIFIED: src/lib/viewport-overlay.ts] |
| Invite URL parsing/creation | New URL format | Existing `createInviteUrl` / `parseInviteMessage` | These validate canonical Cordn shape, metadata, and safe URL fields. [VERIFIED: src/chat/invite.ts] |

## Common Pitfalls

### Pitfall 1: Signed Metadata That Is Not in the Auth Template

**What goes wrong:** A recipient array changes kind-9 tags but is absent from `chatEnvelopeAuthTemplate`, allowing presentation to diverge from the signed proof. [VERIFIED: src/chat/protocol.ts]

**How to avoid:** Add the field to both the Cordn serialization and compact auth JSON; test mutation after signing fails `hasValidChatEnvelopeAuth`. [VERIFIED: src/chat/protocol.ts]

### Pitfall 2: Hidden Invite Still Changes Layout

**What goes wrong:** A non-target invite is hidden only when rendering its bubble, leaving a group, avatar, author row, or margin. [VERIFIED: src/components/MessageGroup.svelte]

**How to avoid:** Deduplicate then target-filter before grouping; regression-test `A normal, A targeted-to-B invite, A normal` as viewer C produces one two-message A streak. [VERIFIED: src/chat/message-presentation.ts]

### Pitfall 3: Invite Text Leaks Through a Secondary UI Surface

**What goes wrong:** A valid invite’s URL or accompanying mention token reaches text, aria labels, status errors, logs, or snapshots instead of the join action only. [VERIFIED: src/components/MessageGroup.svelte] [VERIFIED: AGENTS.md]

**How to avoid:** Detect a valid invite before normal text render; use title/coordinator/host display metadata only, and use generic action errors. [VERIFIED: src/chat/invite.ts] [VERIFIED: 24-UI-SPEC.md]

### Pitfall 4: One Ignore Toggle Expands Every Streak

**What goes wrong:** Expansion is keyed only by sender/participant, so every historical streak expands together. [VERIFIED: 24-CONTEXT.md]

**How to avoid:** Use a post-filter streak-instance key containing sender and first message id; keep the expanded set ephemeral. [VERIFIED: src/chat/message-presentation.ts]

### Pitfall 5: Timestamp-Only Kind-3 Selection

**What goes wrong:** Two valid replacement events in the same second are resolved non-deterministically across reloads or relays. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]

**How to avoid:** Compare `(created_at descending, id ascending)` everywhere: initial query, live event reducer, refresh merge base, and tests. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]

### Pitfall 6: Follow Success Before Relay Acceptance

**What goes wrong:** UI says followed and updates local state even though all relays reject/fail the replacement. [VERIFIED: src/invites/nostr-social.svelte.ts]

**How to avoid:** Await one successful `SimplePool.publish` promise and commit local state only afterward; failure is retryable and leaves prior contacts intact. [VERIFIED: src/invites/nostr-social.svelte.ts]

## Code Examples

### Deterministic Valid Contact Event Selection

```ts
// Source: NIP-01 replacement rule + existing nostr-tools dependency
function isNewerContactEvent(next: NostrEvent, current: NostrEvent | null): boolean {
  if (!current) return true;
  return next.created_at > current.created_at
    || (next.created_at === current.created_at && next.id < current.id);
}

function acceptOwnKind3(event: NostrEvent, activePubkey: string): boolean {
  return event.kind === 3
    && event.pubkey === activePubkey
    && verifyEvent(event);
}
```

### Serialized Follow Mutation

```ts
// Source: local SimplePool publication pattern in nostr-social.svelte.ts
await enqueue(async () => {
  await refresh();
  const base = selectedContactEvent;
  const unsigned = mergeFollow(base, targetPubkey, strictlyNewerCreatedAt(base));
  const signed = await signer.signEvent(unsigned);
  if (!acceptOwnKind3(signed, activePubkey)) throw new Error("Signer returned an invalid contact list");
  await Promise.any(pool.publish(SOCIAL_RELAYS, signed));
  consider(signed);
});
```

### Host/Invitee-Safe Send Recovery

```ts
// Source: existing host and guest send error-restoration pattern
const sentText = composer;
const sentRecipients = [...pendingRecipientPubkeys];
composer = "";
pendingRecipientPubkeys = [];
try {
  await session.send(sentText, { recipientPubkeys: sentRecipients });
} catch (cause) {
  if (!composer) composer = sentText;
  if (pendingRecipientPubkeys.length === 0) pendingRecipientPubkeys = sentRecipients;
  throw cause;
}
```

## State of the Art

| Old Approach | Current Approach | Impact |
|---|---|---|
| Plaintext-only message interpretation | Signed kind-9 recipient tags plus editable presentation text | Allows unambiguous local mention/invite behavior without historical rewrite. [VERIFIED: 24-CONTEXT.md] |
| UI-component-owned social connection | App/identity-lifecycle-owned kind-3 contact list | Makes following current even if profile UI is not opened/rendered. [VERIFIED: src/components/UserProfile.svelte] [VERIFIED: src/App.svelte] |
| Timestamp-only own-list choice | `(created_at, id)` deterministic replaceable-event choice | Matches NIP-01 equal-timestamp rule. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | A dedicated participant-preference module is preferable to expanding an existing preference store. | Pattern 4 | Planner may choose an existing compatible store if it provides the same strict private schema. |
| A2 | A generation token plus subscription-before/alongside-refresh is the appropriate local race barrier. | Pattern 5 | A different existing lifecycle coordinator may be available during planning; invariant remains no stale identity/race overwrite. |
| A3 | Suppressing an outgoing event’s subscription echo until relay acceptance is required to honor the product’s local-state-after-acceptance rule. | Pattern 5 | Implementation detail may differ if the relay callback itself is treated as acceptance, but the UI cannot report success early. |

## Open Questions (RESOLVED)

1. **Exact component split for participant UI — resolved**
   - Decision: Keep the participant interaction UI within the shared `MessageGroup.svelte` surface for this phase. Do not add a host/guest branch or a new child component; extract later only if the shared component becomes independently reusable. [VERIFIED: 24-04-PLAN.md]

2. **Contact-list ownership refactor breadth — resolved**
   - Decision: Retain `NostrSocialStore` as the single public owner of `following` and follow mutation. Any injected controller, pool, signer, or clock seams remain internal implementation details used to prove relay/signature race behavior. [VERIFIED: 24-03-PLAN.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---:|---|---|
| Node.js | Type check, unit tests, build | ✓ | v25.2.1 | — [VERIFIED: local environment] |
| pnpm | Project scripts | ✓ | 10.17.1 | — [VERIFIED: local environment] |
| Configured Nostr social relays | Live kind-3 query/subscription/publication | Not probed | `SOCIAL_RELAYS` derives from project profile relays | Unit tests use injected/mocked pool; browser/interop runs require connectivity. [VERIFIED: src/invites/nostr-social.svelte.ts] |

**Missing dependencies with no fallback:** None detected for implementation; live relay acceptance remains an integration environment prerequisite. [VERIFIED: local environment]

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Vitest 4.1.9, jsdom; Playwright 1.61.0 Chromium | [VERIFIED: package.json] [VERIFIED: vite.config.ts] [VERIFIED: playwright.config.ts] |
| Config file | `vite.config.ts`, `playwright.config.ts` | [VERIFIED: vite.config.ts] [VERIFIED: playwright.config.ts] |
| Quick run command | `pnpm test -- tests/unit/chat-protocol.test.ts tests/unit/nostr-invites.test.ts` | [VERIFIED: package.json] |
| Full suite command | `pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm build && pnpm test:e2e && git diff --check` | [VERIFIED: AGENTS.md] [VERIFIED: package.json] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| USER-01 | Non-self only trigger, keyboard opening, Escape focus return, host/guest parity | Playwright component-flow | `pnpm test:e2e -- workspace-lifecycle.spec.ts` | Extend existing E2E file. [VERIFIED: tests/e2e/workspace-lifecycle.spec.ts] |
| MENTION-01 | p-tag round trip, recipient dedupe, auth mutation rejection, legacy decode | Unit MLS protocol | `pnpm test -- tests/unit/chat-protocol.test.ts` | Extend existing. [VERIFIED: tests/unit/chat-protocol.test.ts] |
| MENTION-02 | Viewer gets label/rail only for own pubkey target | Unit projection + E2E | `pnpm test` / `pnpm test:e2e` | Add message-presentation unit file; extend E2E. [VERIFIED: tests/unit] |
| INVMSG-01 | Public invite visible; targeted invite absent for non-target with no streak/spacing | Unit projection + E2E | `pnpm test` / `pnpm test:e2e` | Add message-presentation unit file; extend E2E. [VERIFIED: src/chat/message-presentation.ts] |
| IGNORE-01 | Exact key persistence, independent per-streak expansion, hidden invite retained hidden after expansion | Unit preferences/projection + E2E | `pnpm test` / `pnpm test:e2e` | Wave 0 test files needed. [VERIFIED: 24-CONTEXT.md] |
| INVUSER-01 | Active-other room choices only, sole p target, chooser pending/error/focus return | Unit invite build + E2E | `pnpm test` / `pnpm test:e2e` | Extend invite/room tests and E2E. [VERIFIED: src/chat/invite.ts] |
| FOLLOW-01 | Invalid/foreign rejected, equal-second lowest-id selection, live replacement, lifecycle independent of profile opening | Unit with fake pool/store | `pnpm test -- tests/unit/nostr-invites.test.ts` | Extend/rename existing social test. [VERIFIED: tests/unit/nostr-invites.test.ts] |
| FOLLOW-02 | Serialized refresh/merge, preserve content/unrelated tags, p dedupe, strictly newer signed event, no state on all-relay failure | Unit with deferred fake query/publish | `pnpm test -- tests/unit/nostr-invites.test.ts` | Extend existing. [VERIFIED: tests/unit/nostr-invites.test.ts] |
| HILITE-01 | Valid palette persists/reloads and remains readable/consistent in host/guest | Unit preferences + E2E | `pnpm test` / `pnpm test:e2e` | Wave 0 unit file; extend E2E. [VERIFIED: 24-UI-SPEC.md] |

### Required Security and Privacy Invariants

- Recipient tags are normalized and included in the signed compact auth proof; tampering any recipient after signing fails validation. [VERIFIED: src/chat/protocol.ts]
- Only valid, self-authored kind-3 events can affect following; a forged event, foreign author, or invalid signature changes nothing. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]
- Targeted invite suppression is presentation-only; tests must not claim confidentiality, and raw invite capability must never appear in non-target DOM, accessible names, status/error text, or logs. [VERIFIED: 24-CONTEXT.md] [VERIFIED: AGENTS.md]
- Ignore/highlight never alter `StoredRoom.messages`, serialized room state, or outbound envelopes. [VERIFIED: src/chat/room-store.ts] [VERIFIED: 24-CONTEXT.md]
- Follow does not report success or modify local selected state until one relay accepts; failure retains safe retry behavior. [VERIFIED: 24-CONTEXT.md]

### Upstream Parity and Interop Relevance

The recipient-tag change touches `src/chat/protocol.ts` and the encrypted chat wire path. Run `pnpm check:upstream` and `pnpm test:upstream-interop`; preserve the existing direct CAHMLS↔Cordn invite and encrypted-message scenarios. Add a protocol unit that an upstream-shaped kind-9 event with ordinary/unknown `p` tags still decodes as a normal message, because recipients are optional metadata rather than a required new wire envelope. [VERIFIED: AGENTS.md] [VERIFIED: tests/unit/cordn-upstream-interop.test.ts]

### Wave 0 Gaps

- [ ] `tests/unit/chat-message-presentation.test.ts` — the requested file does not exist; cover visibility-first grouping, mention emphasis projection, and ignored-streak keys. [VERIFIED: local filesystem]
- [ ] `tests/unit/chat-participant-preferences.test.ts` — cover strict storage parsing, exact-room ignores, global highlights, clear/default, and no message data persistence. [ASSUMED]
- [ ] Extend `tests/unit/chat-protocol.test.ts` — recipient tag/auth/MLS cases. [VERIFIED: tests/unit/chat-protocol.test.ts]
- [ ] Extend `tests/unit/nostr-invites.test.ts` or add `tests/unit/nostr-contact-list.test.ts` — fake pool lifecycle, validation, ordering, queue, and failure cases. [VERIFIED: tests/unit/nostr-invites.test.ts]
- [ ] Extend `tests/e2e/workspace-lifecycle.spec.ts` — both pane actions, overlay containment at 320px, keyboard/focus, no target spacing, and reload persistence. [VERIFIED: tests/e2e/workspace-lifecycle.spec.ts]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | Yes | Bind kind-3 acceptance to active pubkey and verify its event signature. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] |
| V3 Session Management | Yes | Identity generation/reset must stop old subscriptions and ignore stale async completions. [ASSUMED] |
| V4 Access Control | Yes | Render participant actions only for non-self; targeted invites filter only local presentation, not authorization. [VERIFIED: 24-CONTEXT.md] |
| V5 Input Validation | Yes | Strict pubkey/tag/event/storage schemas; use existing invite parsing and event verification. [VERIFIED: src/chat/invite.ts] [CITED: github.com/nostr-protocol/nips/blob/master/01.md] |
| V6 Cryptography | Yes | Reuse `NostrSigner`, `verifyEvent`, existing MLS encryption, and existing envelope proof; never hand-roll signing. [VERIFIED: src/chat/protocol.ts] |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Forged/foreign kind-3 relay event | Spoofing/Tampering | Require exact active pubkey and `verifyEvent` before reducer admission. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] |
| Stale or simultaneous follow replacement | Tampering/Repudiation | Deterministic comparator, live reducer, serialized refresh/merge, strictly newer replacement. [CITED: github.com/nostr-protocol/nips/blob/master/01.md] |
| Capability URL exposed to unintended UI | Information disclosure | Filter before render and never emit raw invite strings through normal text/errors/logs. [VERIFIED: 24-UI-SPEC.md] [VERIFIED: AGENTS.md] |
| Preference-key collision across coordinators | Tampering | Use the established composite room identity plus participant pubkey. [VERIFIED: src/chat/room-store.ts] |

## Sources

### Primary (HIGH confidence)

- [Local protocol implementation](../../../src/chat/protocol.ts) - existing kind-9 conversion, signed envelope proof, and decode path. [VERIFIED: codebase grep]
- [Local session/store implementation](../../../src/chat/room-store.ts) - serialized send queue, room identity, storage, and active/retired records. [VERIFIED: codebase grep]
- [Shared message UI](../../../src/components/MessageGroup.svelte) - sole shared streak rendering surface. [VERIFIED: codebase grep]
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) - event signatures, p tags, replaceable kinds, subscriptions, deterministic equal-timestamp rule. [CITED: github.com/nostr-protocol/nips/blob/master/01.md]
- [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) - kind-3 full follow-list replacement and append recommendation. [CITED: github.com/nostr-protocol/nips/blob/master/02.md]

### Secondary (MEDIUM confidence)

- [NIP-10](https://github.com/nostr-protocol/nips/blob/master/10.md) - p-tag social-reference context; phase use remains a local kind-9 extension. [CITED: github.com/nostr-protocol/nips/blob/master/10.md]

### Tertiary (LOW confidence)

- None; implementation-shape assumptions are isolated in the Assumptions Log. [VERIFIED: this research]

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - all dependencies and existing primitives are present in the repository. [VERIFIED: package.json]
- Architecture: HIGH - both render/send call paths and required product constraints were inspected. [VERIFIED: codebase grep]
- Pitfalls: HIGH - wire, layout, storage, and kind-3 race paths are directly evidenced; lifecycle implementation shape has explicit assumptions. [VERIFIED: codebase grep]

**Research date:** 2026-08-06
**Valid until:** 2026-09-05 for codebase findings; re-check NIP/current library APIs before execution if delayed.
