---
phase: 24
slug: chat-user-interactions
status: approved
shadcn_initialized: false
preset: none
created: 2026-08-06
---

# Phase 24 — UI Design Contract

> Visual and interaction contract for Chat User Interactions. This contract applies identically to the hosted chat pane and invitee chat route.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — retain the existing Svelte 5 + Tailwind v4 and component-scoped CSS system |
| Preset | not applicable |
| Component library | none; build small local Svelte components that follow the existing menu/popover and focus-return patterns |
| Icon library | none; use existing inline text/SVG treatment only |
| Font | existing system monospace stack from `src/app.css` |

The design remains square-edged, compact, dark, and terminal-like. Reuse existing message streak geometry, 1px hairlines, bubble surfaces, composer placement, and reaction control behavior from Phase 19. Do not add shadcn, a third-party UI package, or a third-party registry.

### Decision provenance

- **CONTEXT.md:** all participant-menu, mention, targeted-invite, ignore, follow, highlight, accessibility, and privacy decisions below are locked product decisions.
- **REQUIREMENTS.md:** USER-01, MENTION-01/02, INVMSG-01, IGNORE-01, INVUSER-01, FOLLOW-01/02, and HILITE-01 define required outcomes.
- **Existing components:** `MessageGroup.svelte`, `MessageReactions.svelte`, `HostWorkspace.svelte`, and `ChatRoute.svelte` establish the grouped bubble, inline popover, composer, status, and host/guest parity patterns.
- **Defaults:** token sizing and copy below are phase defaults chosen to match the existing system.

---

## Spacing Scale

Declared values (all multiples of 4):

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Swatch borders, icon-to-label gaps, compact menu separation |
| sm | 8px | Menu padding, stacked action gaps, small field spacing |
| md | 16px | Popover/dialog inset and normal control separation |
| lg | 24px | Invite chooser section padding |
| xl | 32px | Major chat-pane section separation |
| 2xl | 48px | Reserved for full-pane empty or failure state separation |
| 3xl | 64px | Reserved for page-level spacing; do not introduce it inside the chat log |

Exceptions: every new author trigger, context-menu action, color option, and room-choice action has a minimum 44px hit target. This is a touch and keyboard target minimum, not a new spacing token.

---

## Typography

Use exactly these four sizes and two weights for new Phase 24 UI. Keep existing Phase 19 timestamps and reaction typography unchanged.

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Compact metadata and menu supporting text | 12px | 400 | 1.5 |
| Body, action labels, and chooser rows | 14px | 400 | 1.5 |
| Menu/chooser section label and emphasized state label | 16px | 600 | 1.2 |
| Dialog/empty-state heading | 20px | 600 | 1.2 |

Long participant names, room names, and coordinator labels truncate with an ellipsis in one-line controls; retain the complete text in the accessible name or `title`. Message body text and disclosure labels wrap with `overflow-wrap: anywhere`; they must never create horizontal document overflow.

---

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `#030303` | Application canvas and chat-log backdrop; retain existing `#0b0e0d` only for input interiors |
| Secondary (30%) | `#101614` | Chat pane, composer, menus and compact chooser surfaces; retain existing `#1a241e` for received message bubbles |
| Accent (10%) | `#7cf59d` | Selected/focused participant action, primary invitation send state, keyboard focus outline, and explicit active highlight choice |
| Mention semantic | `#f1f58f` | Mentioned-you marker and its 2px inset rail only |
| Destructive | `#ffaaa3` | Irreversible/destructive action copy only; no Phase 24 participant action is destructive |

Accent reserved for: the active/focused author trigger, the selected menu row, the selected room-choice/pending-success state, visible keyboard focus, and the selected highlight swatch. Do not use accent as the default color for every menu action or message.

Highlight palette is private viewer presentation only. Offer named, accessible choices: **Default** (no highlight), **Lime** `#7cf59d`, **Gold** `#f1f58f`, **Cyan** `#86ddff`, **Violet** `#c4a6ff`, and **Rose** `#ffaaa3`. Apply the chosen color as a 2px inset rail and a named `Highlight: {color}` label in the author menu; preserve normal high-contrast message text. A swatch alone is never the only indication of the choice.

---

## Visual and Interaction Contract

### Participant author control

- Primary eye order remains: active conversation content first, composer second, contextual participant actions third. Closed author controls must stay visually quieter than message text and the composer; an opened menu may temporarily become the local focal surface.

- Replace the visible non-self author identity (avatar + display name + existing host badge) with one compact button. Its accessible name is `Actions for {display name}`; it opens one participant context menu. Do not add a separate per-bubble action button.
- The viewer's own author identity remains plain, non-interactive presentation: no context trigger, hidden menu, or self-directed actions.
- The trigger preserves Phase 19 alignment: other participants' author controls align left; the viewer's own identity aligns right. It uses the existing low-noise author treatment until hover, focus-visible, or expanded, then gains the accent hairline/foreground. It must not change streak width or bubble position.
- Activating the trigger by click, Enter, or Space opens a single anchored menu. Focus moves to its first enabled action. Escape closes it and returns focus to the exact author trigger; clicking/focusing outside closes it. The menu must remain within the viewport, flip vertically when needed, and use a viewport overlay if any chat container would clip it.
- The menu visually groups actions in this order: **Mention**, **Invite to room**, **Follow on Nostr**, divider, **Highlight**, **Ignore**. Use a 1px `#293832` divider and 8px group gap. Do not use destructive red for Ignore, because it is reversible and private.
- Menu actions expose pending state with a disabled control, `aria-busy="true"`, and an adjacent live status. They retain focus and never log message text, invite URLs, room secrets, or key material in an error.
- Anonymous viewers see `Follow on Nostr` visibly unavailable with the supporting line `Sign in to follow people on Nostr.` It is announced as unavailable; it does not silently create a local follow or open an unrelated sign-in flow.

### Mention and mention emphasis

- Selecting **Mention** closes the menu, focuses the current host or invitee composer, and inserts the editable visible token `@{display name}` at the caret, adding surrounding whitespace only when required. The action retains the selected participant pubkey as structured signed metadata even if the human-readable token is edited before Send.
- Existing emoji shortcuts and the existing Send action remain in place. Do not introduce a second composer, a recipient chip, or raw pubkey UI.
- A message that explicitly targets the active viewer retains its normal bubble content and gains a 2px `#f1f58f` inset rail plus a compact visible label `Mentioned you` before metadata. The label is present in the accessibility tree. Messages that target someone else are visually and semantically ordinary to the viewer.
- Structured mention tokens accompanying an invite are presentation metadata, never rendered as chat text.

### Targeted invite chooser and message presentation

- Selecting **Invite to room** opens a compact modal/viewport-contained chooser titled `Invite {name} to a room`. It lists only active stored rooms other than the current room; retired History entries and the current room are excluded.
- A room row shows the room title as its primary label and the coordinator name as supporting text. Choosing a row immediately sends that room's current canonical invite to the current conversation targeted solely to the selected participant; the selected row becomes `Sending invite…` and all rows are disabled until completion.
- On success, close the chooser, restore focus to the originating author trigger, and announce `Invite sent to {name}.` On failure, retain the chooser and show the documented error state with a retryable room row.
- An untagged valid invite continues to render the existing named join action for every viewer. A tagged valid invite renders that same join action only for a tagged viewer. For every non-target viewer, render **no message bubble, author row, timestamp, reaction control, log entry, placeholder, or spacing**. This visibility rule is a local UX filter, not a confidentiality claim.
- The join action remains the only invite presentation; raw invite capability text and accompanying mention text never appear in visible text, attributes, errors, telemetry, or diagnostic logs.

### Ignore disclosures

- Selecting **Ignore** immediately persists the private exact-room preference and closes the participant menu. It is reversible; do not show a confirmation dialog.
- Each existing consecutive ignored-author streak is replaced by one centered, full-width disclosure button: `{display name} posted {N} message` or `{display name} posted {N} messages`. The default is collapsed. The button has `aria-expanded` and changes its visible action to `Show messages` / `Hide messages`.
- Expanding affects only that disclosure instance; multiple ignored streaks can be expanded independently. Expanded messages retain their normal ordering, timestamps, invite filtering, mention treatment, and reaction rules. No collapse or expansion state changes shared room data.
- The disclosure uses the secondary surface, subdued `#82958a` copy, and a 1px `#293832` hairline. It must preserve the log's vertical rhythm without implying deletion or moderation.

### Follow and highlight feedback

- **Follow on Nostr** reports `Following {name}…` while publication is pending, `Now following {name}.` after relay acceptance, and the documented error state on failure. Do not report success before publication succeeds.
- **Highlight** opens a compact labelled color sub-menu/popover adjacent to the participant menu. Selecting a color immediately updates the local presentation and persists it; selecting **Default** clears it. After selection, return focus to the participant menu action and announce `Highlight set to {color}.` or `Highlight cleared.`
- A chosen highlight applies consistently to the participant's author control and all of that participant's visible streaks in both host and invitee panes. It never replaces the `Mentioned you` label or reduces message text contrast.

### Responsive and motion behavior

- At 520px and below, menus and chooser panels are bounded to `calc(100vw - 32px)`; their content scrolls internally if needed and no horizontal document overflow is allowed. The 44px target minimum remains in effect.
- Honor `prefers-reduced-motion`: menu/chooser open-close and highlight changes are immediate or use only opacity; no positional animation may obscure the selected participant or composer.
- New focus-visible outlines use the existing 2px accent outline with an offset. Do not rely on hover for action discovery.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | `Mention {name}` |
| Participant menu actions | `Mention`, `Invite to room`, `Follow on Nostr`, `Highlight`, `Ignore` |
| Invite chooser heading | `Invite {name} to a room` |
| Invite chooser empty heading | `No other active rooms` |
| Invite chooser empty body | `Join or create another active room before sending an invite.` |
| Invite pending / success | `Sending invite…` / `Invite sent to {name}.` |
| Mention emphasis | `Mentioned you` |
| Ignore disclosure | `{name} posted {N} message(s)` with `Show messages` / `Hide messages` |
| Anonymous follow guidance | `Sign in to follow people on Nostr.` |
| Follow pending / success | `Following {name}…` / `Now following {name}.` |
| Error state | `Couldn’t complete that action. Check your connection and try again.` |
| Invite-specific error | `Couldn’t send the invite. Check the room connection and try again.` |
| Destructive confirmation | None. Ignore and highlight clear are local, immediately reversible preferences; no destructive participant action exists in this phase. |

---

## UI Considerations

Applicable state considerations resolved: 14 covered, 2 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| populated | Participant author control | ✅ covered | Every non-self visible streak exposes exactly one author-identity trigger; self streaks expose none. |
| long-text | Participant author control and menu items | ✅ covered | Long names truncate in one-line controls with complete accessible names/title; menu labels remain readable. |
| empty | Invite-room chooser | ✅ covered | When no qualifying active room exists, show the documented empty heading/body and no disabled room rows. |
| loading | Invite-room chooser | ✅ covered | While invite dispatch is pending, selected row reads `Sending invite…`, all choices are disabled, and status is announced. |
| error | Invite-room chooser | ✅ covered | Failure retains the chooser, presents the documented actionable error, and keeps a retryable row. |
| populated | Invite-room chooser | ✅ covered | Each eligible active room is one title/coordinator row; current and historical rooms are excluded. |
| partial | Invite-room chooser | ✅ covered | A room with unavailable secondary coordinator label falls back to its stable shortened coordinator label without losing the selectable room title. |
| overflow | Invite-room chooser | 🧪 backstop | Browser coverage must prove chooser/menu viewport containment, internal scrolling, and no horizontal overflow at 320px width and short height. |
| zero-one-many | Invite-room chooser | ✅ covered | Zero uses empty state, one is directly selectable, many use an internally scrollable list without changing action semantics. |
| populated | Ignored message streak disclosure | ✅ covered | Each ignored consecutive streak becomes one centred count disclosure; independent expansion restores the original bubbles in-place. |
| overflow | Message body, disclosure label, and hidden target filtering | ✅ covered | Bodies wrap anywhere, disclosure labels wrap, and non-target tagged invites contribute no rendered/log-layout node. |
| zero-one-many | Ignored message streak disclosure | ✅ covered | Copy uses singular/plural count; one or many disclosures retain independent expanded state. |
| long-text | Composer mention form | ✅ covered | Editable visible mention text remains in the existing composer and wraps/scrolls under its existing input behavior; no raw pubkey is rendered. |
| loading | Follow action | ✅ covered | Pending follow action is disabled and announced as `Following {name}…` until relay acceptance/failure. |
| error | Follow action | ✅ covered | Failure uses the documented safe retry copy and does not expose event content, keys, or raw relay diagnostics. |
| overflow | Participant menu | 🧪 backstop | Browser coverage must prove keyboard opening, Escape focus return, vertical flip/overlay containment, and 44px targets in host and invitee panes. |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| none | none | not applicable — no shadcn initialization and no third-party registry |

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS — primary eye order explicitly preserves conversation and composer priority
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved 2026-08-06
