---
phase: 26
slug: offline-coordinator-room-disclosure
status: approved
reviewed_at: 2026-08-07
shadcn_initialized: false
preset: none
created: 2026-08-07
---

# Phase 26 — Offline Coordinator Room Disclosure UI Design Contract

> Visual and interaction contract for SIDE-07. This contract extends the established coordinator-card system; it does not redesign the sidebar.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — existing manual Svelte component system |
| Preset | not applicable; this Svelte project has no `components.json` |
| Component library | none; reuse `CoordinatorRoomCard.svelte`, `RoomActionsMenu.svelte`, badges, and existing sidebar primitives |
| Icon library | none; retain existing text/status-dot/icon treatment |
| Font | existing `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace` stack |

No third-party component, registry, or preset is introduced. The existing manual visual system is the source of truth. (Source: `src/app.css`, `CoordinatorRoomCard.svelte`, and Phase 25 UI-SPEC.)

---

## Scope and Disclosure Rule

Apply this disclosure **only** when all conditions are true: `presentation === "coordinator"`, `local === false`, `status === "offline"`, and `rooms.length > 0`.

At rest, an eligible card retains its existing fieldset/legend, coordinator label, offline dot, status text, and unread badge, but replaces its room-row area with exactly one compact summary:

- `1 chat offline` when there is one room.
- `{N} chats offline` when there are two or more rooms.

The count is the total known active-room count, not the current five-row visible subset. The summary is informative, neutral, and not a navigation action, button, or toggle.

At rest, coordinator identity and status are the focal point. On hover or focus, revealed room rows become the actionable focal point while the offline summary recedes without disappearing from assistive technology.

All other presentations stay exactly as they are today: local coordinator (including offline local state), Favorites, `online`, `connecting`, and `unknown` remote coordinators; empty cards; unread counts; active-row styling; room order; and the selected-room/favorite reveal path. No connection state, membership, room history, favorite, ordering, or reachability data is written or changed by disclosure.

---

## Interaction and Accessibility Contract

| State | Required behavior |
|-------|-------------------|
| Rest | Eligible card shows the summary and no room row, row action, favorite control, or `Show more` control. It is compact but retains the existing card border and offline identity. |
| Pointer enter | Hovering anywhere over the card — legend, summary, revealed row, star, or room-actions trigger — reveals the preserved room list. It must not require hovering a tiny summary affordance. |
| Pointer traversal | The card stays revealed while the pointer moves from the summary to any descendant row/action. It collapses only after the pointer has left the entire card and keyboard focus is no longer inside it. |
| Keyboard entry | An eligible fieldset/card is a single `tabindex="0"` group stop with `aria-describedby` pointing to visually hidden instructional text: `Focus to reveal {N} offline historical chat(s).` Its accessible group name remains the existing coordinator label/status. Focusing this card reveals the list before the next Tab target is calculated. |
| Keyboard traversal | Moving Tab/Shift+Tab between the card and any revealed room primary button, favorite toggle, `Show more`/`Show fewer chats`, or three-dot menu keeps the list revealed through `:focus-within`/equivalent state. Existing room and menu labels, focus return, navigation, and removal behavior remain unchanged. |
| Keyboard exit | When focus leaves the card and its descendants, and the pointer is not over the card, restore the compact summary. Do not trap focus, add an Escape shortcut, or move focus on collapse. |
| Activation | Clicking the summary/card background does nothing beyond normal focus behavior. Only the existing room controls activate navigation/actions; a room primary button opens that exact historical chat just as before. |
| Screen readers | Do not use a live region and do not announce hover/focus disclosure. The revealed rows retain their existing accessible names. At rest they are absent from the accessibility tree and tab sequence; after focus disclosure they are present before the user tabs onward. |

Use one disclosure state owned by the card, driven by pointer enter/leave and focus in/out. On focus-out, inspect the new focus target and whether the card remains hovered before collapsing; this prevents the common focus/pointer race that hides a row while it is being entered. Do not implement the behavior solely with a summary `:hover` selector.

When revealed, keep the current `visibleRooms` rules intact: the existing five-row default, active/revealed-room substitution, and `Show {hiddenCount} more` / `Show fewer chats` control continue to apply. The offline summary replaces the initial room-row presentation; it does not silently remove historical navigation beyond the established show-more rule.

---

## Visual States and Motion

| State | Visual contract |
|-------|-----------------|
| Compact offline | Summary occupies the existing room-area width with a 44px minimum height, 4px internal gap, and 4px/8px padding. Use `#718277` supporting text and `#9aac9f` semibold count text on existing transparent/dark card surfaces. Keep the offline status dot `#59675f`; do not use green, warning yellow, or destructive red for the summary. |
| Revealed | Insert the current room-list layout in normal document flow beneath the unchanged legend. Rows retain their 44px minimum, neutral hover, active green rail, unread badge, favorite visibility behavior, and action-menu access. Do not add a second card background or an accent border. |
| Card focus | Use the existing sparse green focus treatment only as a visible focus ring/outline on the focusable card; it must meet the system's clear focus-visible convention without shifting the card or adjacent cards. |
| Enter motion | After revealed content has been placed in its final layout, animate only `opacity` from `0` to `1` and `transform` from `translateY(-4px)` to `none` over 150ms `ease`. The summary may fade out over the same duration. |
| Exit motion | On pointer/focus exit, fade the currently rendered room-list opacity to `0` over 150ms, then remove it and restore the summary. Do not leave transparent rows focusable or clickable during the fade. |
| Reduced motion | Under `prefers-reduced-motion: reduce`, use no transition or transform. Insert/remove the final state immediately; all disclosure, room navigation, focus, and actions remain available. |

Never animate `height`, `max-height`, `grid-template-rows`, width, padding, margin, border width, or positional layout. Do not use absolute positioning, overlays, clipping to fake the list, or animation that causes rows to overlap neighbouring cards. The card may grow/shrink in normal layout immediately; only the content's opacity/4px transform may animate. This preserves sidebar scroll behavior and avoids layout-thrashing on a long room history.

---

## Responsive and Content Constraints

- Preserve the current 320px minimum-viewport contract: no horizontal scrolling, no clipping of room actions, and the sidebar remains the scroll container for a long revealed list.
- The compact summary, legend label, and status share the existing `min-width: 0` layout. Coordinator labels retain ellipsis/title behavior; the numeric summary must stay on one line and must not displace the unread badge or status.
- Revealed long room names retain `.truncate`, full existing accessible room labels, and the existing action-column reservation. The summary count is not truncated at supported widths.
- The disclosure must work with the compact mobile rail after the rail is opened. It does not add a mobile-only control or rely on hover alone: hardware-keyboard focus follows the same card-then-row sequence.
- Do not change the card-list gap, coordinator ordering, Favorites position, History treatment, or the local `+` create affordance.

---

## Spacing Scale

Declared values (all multiples of 4; inherited from the existing sidebar system):

| Token | Value | Usage in this phase |
|-------|-------|---------------------|
| xs | 4px | Card padding, row/list gap, summary internal separation, 4px motion offset |
| sm | 8px | Summary horizontal padding and compact inline spacing |
| md | 16px | No new use; retain general component spacing |
| lg | 24px | No new use; retain section spacing |
| xl | 32px | No new use; retain layout spacing |
| 2xl | 48px | No new use; retain major spacing |
| 3xl | 64px | No new use; retain page spacing |

Exceptions: 44px is the existing accessible minimum height for room rows and the compact disclosure summary; it is a touch/focus-target dimension, not a spacing token.

---

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Metadata/status | 8px | 400 | 1.5 |
| Summary/label | 10px | 600 | 1.5 |
| Room/action text | 12px | 400 | 1.5 |
| Overlay/action copy | 14px | 600 | 1.45 |

Use only regular (400) and semibold (600). The compact summary uses the 10px summary/label role; it does not introduce a new type scale or uppercase treatment.

---

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `#0d1310` | Existing legend/base dark surface and surrounding sidebar background |
| Secondary (30%) | `#293832` | Existing card border and neutral sidebar structure |
| Accent (10%) | `#7cf59d` | Active-room rail, selected favorite star, and visible keyboard focus only |
| Destructive | `#ffaaa3` | Existing destructive confirmation/actions only; never disclosure |

Accent reserved for: active-room rail, selected favorite star, and the eligible card's visible keyboard-focus indicator. Offline is an availability condition, not an error: use existing neutral offline/supporting colors (`#59675f`, `#718277`, `#9aac9f`) rather than accent, yellow, or destructive red. The existing approximate 60/30/10 distribution remains unchanged.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Compact singular summary | `1 chat offline` |
| Compact plural summary | `{N} chats offline` |
| Keyboard instruction (visually hidden) | `Focus to reveal {N} offline historical chat(s).` Use normal singular/plural grammar in the rendered string. |
| Existing continuation CTA | `Show {N} more` / `Show fewer chats` after disclosure only when the established five-room limit applies |
| Empty state | No new empty state. Preserve existing `No active groups` for remote cards with zero rooms; those cards never receive the disclosure. |
| Error state | No new load/error surface. The offline status and existing room data remain the only presentation; do not add retry/error copy. |
| Destructive confirmation | None added. Existing exact-room `Leave room` confirmation remains unchanged. |

---

## UI Considerations

Applicable state considerations resolved: 8 covered, 0 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| populated | Revealed historical-room list | ✅ covered | An eligible offline remote card reveals the current `visibleRooms` collection, retaining exact row navigation/actions and the established five-room/show-more behavior. |
| zero-one-many | Compact summary and room collection | ✅ covered | Zero rooms preserve `No active groups`; one room renders `1 chat offline`; two or more render `{N} chats offline`; disclosure retains the existing five-room threshold. |
| empty | Remote coordinator card | ✅ covered | Empty remote cards use the existing empty state and are excluded from disclosure. |
| partial | Room collection | ✅ covered | The active/revealed-room substitution and `Show {N} more` behavior remain unchanged when only a subset is initially visible. |
| overflow | Summary, room collection, and card navigation | ✅ covered | The sidebar remains the vertical scroll container; card/list width stays bounded at 320px with no horizontal document overflow, and current action-column reservation remains intact. |
| long-text | Coordinator label, summary instruction, and room controls | ✅ covered | Coordinator and room labels retain existing ellipsis/title and full accessible names; numeric summary is one line and does not displace status or unread content. |
| loading | Card navigation | ✅ covered | Disclosure creates no loading state and does not initiate synchronization; it only presents already-known room history. |
| error | Card navigation | ✅ covered | Disclosure creates no failure/retry state; offline remains a neutral reachability presentation and preserves existing data/actions. |

---

## Non-Goals

- No click-to-toggle, persistence, pinning, auto-expansion, or explicit disclosure button is added.
- No remote room is removed, reordered, fetched, synchronized, joined, left, favorited, or otherwise mutated by this interaction.
- No changes are made to local, Favorites, online, connecting, unknown, History, unread, selected-room, or room-actions behavior.
- No new icon package, shadcn initialization, third-party registry, design-token framework, or overlay is introduced.
- No accessibility workaround depends on pointer hover; no focus trap, live-region announcement, or automatic focus movement is permitted.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable — shadcn is not initialized |
| Third-party | none | not applicable — no registry code enters the phase |

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: approved after making the continuation CTA noun-specific
- [x] Dimension 2 Visuals: approved after recording the compact/revealed focal hierarchy
- [x] Dimension 3 Color: approved
- [x] Dimension 4 Typography: approved
- [x] Dimension 5 Spacing: approved
- [x] Dimension 6 Registry Safety: approved

**Approval:** approved by independent UI checker on 2026-08-07
