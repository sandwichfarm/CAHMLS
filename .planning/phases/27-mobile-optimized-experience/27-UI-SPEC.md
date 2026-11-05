---
phase: 27
slug: mobile-optimized-experience
status: approved
shadcn_initialized: false
preset: none
created: 2026-08-07
---

# Phase 27 — Mobile-Optimized Experience UI Design Contract

> A touch-first contract for the existing CAHMLS operator shell. Mobile changes navigation hierarchy, containment, target sizing, and durable-storage truthfulness; it does not introduce a new visual brand or change Cordn wire behavior.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — existing Svelte 5 component-scoped CSS with Tailwind v4 base import |
| Preset | not applicable — this is a Svelte/Vite application; `components.json` is absent |
| Component library | existing local Svelte components, native `dialog`, and the existing `viewportOverlay` primitive |
| Icon library | none — retain existing compact Unicode/inline-SVG operator glyphs with explicit accessible names |
| Font | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace` |

Continue the CAHMLS visual language: `#030303` ground, near-black green-tinted surfaces, square corners, 1px muted-green hairlines, compact monospace information density, and sparse signal green. Do not add rounded-card UI, gradients, a mobile-only icon set, third-party UI packages, toast-only failures, or an independent guest visual system.

| Source | Decisions applied |
|--------|-------------------|
| `27-CONTEXT.md` | Tap-first operation; primary conversation; deliberate drawer/sheet navigation; 44px targets; keyboard/safe-area states; audited offline/favorite/reaction gaps; identity-scoped IndexedDB truthfulness. |
| `REQUIREMENTS.md` / `ROADMAP.md` | MOBILE-01 through MOBILE-07 and the complete host + two-client mobile acceptance journeys. |
| `18-UI-SPEC.md`, `19-UI-SPEC.md`, `21-UI-SPEC.md`, `22-UI-SPEC.md`, `24-UI-SPEC.md`, `25-UI-SPEC.md`, `26-UI-SPEC.md` | Existing shell ownership, coordinate-card ordering, grouped reactions, first-run flow, containment, copy, operator tokens, and motion rules. |
| Current Svelte UI | `HostWorkspace`, `ChatRoute`, `WorkspaceNav`, `CoordinatorRoomCard`, `MessageReactions`, `RoomActionsMenu`, and `viewportOverlay` establish the surfaces to consolidate rather than replace. |

---

## Spacing Scale

Declared values (all multiples of 4):

| Token | Value | Mobile usage |
|-------|-------|--------------|
| xs | 4px | Hairline-adjacent gaps, status-dot offsets, badge insets, reaction-grid gaps |
| sm | 8px | Sheet gutter, row sub-gaps, compact control padding, safe-area minimum inset |
| md | 16px | Drawer/sheet body padding, dialog/footer padding, composer row spacing |
| lg | 24px | Sheet sections and mobile empty-state rhythm |
| xl | 32px | Major setup and recovery-state separation |
| 2xl | 48px | Full-pane empty/recovery breathing room only |
| 3xl | 64px | Existing page-level shell composition only; do not introduce inside drawers |

Exceptions: every pointer-operable control at a coarse pointer has a visible or transparent hit rectangle of **at least 44 by 44 CSS px**. This includes top-bar controls, drawer rows, coordinator lifecycle/settings/create actions, favorite stars, offline disclosures, three-dot room actions, message reactions, emoji choices, all menu/sheet rows, inputs' paired actions, close buttons, destructive-dialog actions, and the composer Send action. Compact glyphs remain centred in that rectangle. Badges, status dots, separators, and passive connection indicators are not targets.

The app may retain 320px as its supported minimum width. Nothing may create horizontal document scrolling at 320px, including long room names, action columns, QR controls, sheets, or the composer.

---

## Typography

Use only these four sizes and two weights for Phase 27 additions and touched controls. Preserve legible existing copy where it already exceeds this scale.

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Metadata / status / badge | 10px | 400 | 1.4 |
| Body / control / form text | 12px | 400 | 1.5 |
| Row emphasis / sheet action | 14px | 600 | 1.4 |
| Sheet, dialog, recovery heading | 18px | 600 | 1.2 |

Use uppercase and 0.08–0.12em tracking only for compact metadata such as `ROOMS`, coordinator state, and persistence state. Use tabular numerals for unread counts and room counts. One-line controls truncate long coordinator/room/person labels with an ellipsis while retaining the full value in the accessible name and `title`; explanatory text, error text, and messages wrap with `overflow-wrap: anywhere`.

---

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `#030303` | App canvas, conversation ground, drawer scrim, and input interior |
| Secondary (30%) | `#09100c` / `#101614` | Drawer, sheets, dialogs, composer, coordinator cards, and quiet rows |
| Accent (10%) | `#7cf59d` | Active-room rail, selected favorite/reaction/presence state, primary safe action, unread badge/count, and visible keyboard focus |
| Warning | `#e4e78d` | Non-terminal storage/restart guidance and in-progress recovery only |
| Destructive | `#ffaaa3` | Confirmed destructive action and terminal user-safe storage error text only |

Accent is reserved for the active room, an intentionally selected/toggled state, the one primary action in a sheet/dialog, unread signal, and focus-visible outline. It is never the default color for all controls, all connection dots, every room row, or temporary-session status. Use `#718277` / `#82958a` for passive/offline/supporting information and `#293832` / `#496451` for structure. Offline and unavailable are neutral availability states, not destructive states.

---

## Mobile Surface and Interaction Contract

### One mobile navigation model

At widths of **900px and below**, host and guest routes use one `Open room browser` trigger and the same single-pane `Room browser` drawer model. The current host-only off-canvas rail and guest `WorkspaceNav` room switcher must converge on this one state owner; neither route may expose a second competing room chooser. The active conversation stays visible behind the drawer and remains the primary surface when it closes.

The drawer is a left-edge panel, width `min(22rem, calc(100vw - 44px))`, with a full viewport scrim. It has a 44px close control named `Close room browser`, heading `Rooms`, a vertical scroll body, and `padding-top: max(8px, env(safe-area-inset-top))` / `padding-bottom: max(8px, env(safe-area-inset-bottom))`. Its contents retain Phase 22's stable ordering:

1. `Join from invite`.
2. Local coordinator card and its start/stop/settings/create controls when the route owns a local coordinator.
3. `Favorites`, then local and remote coordinator cards with their room rows.
4. Collapsed `History`.
5. Personal controls: profile/presence, notifications, notification settings, and identity actions.

The guest route renders the same browser with only the controls/data it owns; it does not invent coordinator lifecycle controls. The host route never diverts the user into a separate desktop-style room-switcher. A selected room row immediately navigates to that exact room, closes the drawer, and moves focus to the active conversation heading (or the composer if navigation was initiated from a composer-adjacent invite action). A room action that opens another overlay first closes the drawer, then opens the requested sheet/dialog after the drawer has left the accessibility tree.

The Room browser owns explicit collection states. While local records are being restored it shows `Loading saved chats…` with no false empty state. A guest with no saved or joined rooms sees `No chats saved on this device.` and the action `Join from invite`. A host with a ready coordinator but no rooms sees `No groups yet.` and the action `Create group`; before the coordinator is ready, its existing start/recovery action remains the only primary action. A failed list restore shows `Couldn’t load saved chats. Close the room browser and try again.` with `Close room browser`. These states use the same scroll body and never remove the visible drawer close control.

At widths above 900px preserve the existing persistent rail and anchored overlays. The shared data, labels, action ordering, and selection behavior remain identical across breakpoints.

### Tap discovery and action surfaces

No necessary action may require hover, focus-within, a hidden target, or a hardware keyboard.

- Replace the Phase 26 passive offline summary with a 44px disclosure button. Its exact accessible/visible label is `Show {N} offline chat` or `Show {N} offline chats` while collapsed and `Hide offline chats` while expanded. It exposes `aria-expanded` and reveals the already-known rows in document flow. It must not fetch, join, or change room state. Pointer hover and keyboard focus may also reveal the rows on fine pointers, but tap is the primary mobile path.
- On coarse pointers, render favorite stars, room-actions triggers, and reaction-add triggers at all times. The current selected-state styling remains; opacity-only discovery is prohibited. A room owner avatar may remain hover-only because it is decorative and its name is retained in the room accessible name.
- Every row reserves independent 44px targets for its primary room open, favorite, and more-actions controls. The visible row height may be compact only when the independent targets do not overlap or obscure its title, badge, or active rail.
- On mobile, room actions, participant actions, targeted-invite selection, and reaction selection use a viewport-contained bottom sheet rather than a clipped anchored popover. The sheet opens with its first enabled action focused for keyboard users; touch users keep their tap location and see a heading that names the room/person/message context. Reaction sheets show one 44px emoji grid/button per supported emoji and retain aggregate reaction counts in the message log.
- Keep current desktop hover/focus polish as an enhancement only. `@media (hover: none), (pointer: coarse)` must make required controls persistently perceptible without increasing visual accent use.

### Sheets, dialogs, focus, and dismissal

At 900px and below, profile, presence, notification feed/settings, join-from-invite, room/participant/reaction actions, and compact forms use the established viewport overlay primitive in **sheet** mode. Coordinator settings may remain the full-height right sheet; destructive leave/delete/destroy/identity-reset and destructive storage-reset actions use a native modal dialog.

Only one modal drawer, sheet, or dialog is open at once. Opening a new one closes the previous surface first. Every overlay must:

- be in the top layer or a fixed layer above its scrim, use `aria-modal="true"` for modal surfaces, and make the non-overlay application inert;
- trap focus while open, set initial focus to the close button or first safe actionable control, and return focus to the exact opener on close unless that opener was removed;
- close through its visible context-specific 44px control (`Close room browser`, `Close notification settings`, `Keep this room`, or the equivalent named safe action), outside-tap scrim where abandoning the operation is safe, Escape, and a transient history-state `popstate` handler so platform Back closes the topmost transient surface before route navigation;
- be bounded to `calc(var(--app-visual-height, 100dvh) - 16px)` with 8px side gutters, internally scrollable body, fixed/sticky header and footer actions, and `overscroll-behavior: contain`;
- reposition from `visualViewport.resize` and `visualViewport.scroll` as well as window resize/scroll. Anchored desktop popovers continue to flip; mobile sheets do not rely on an anchor that may be obscured by the keyboard.

Outside tap never confirms destructive work. A destructive dialog closes only via its context-specific safe action (for example `Keep this room`, `Keep saved data`, or `Keep running`), Escape, or its explicitly named confirmation action. Visible generic `Cancel` CTAs are prohibited. Escape is a keyboard dismissal mechanism, not a visible CTA. Do not blur the conversation beneath a modal; use the existing restrained scrim and do not permit a blurred/lowered background to remain interactive.

### Phone viewport, safe area, and keyboard

Use one app-height CSS custom property, `--app-visual-height`, initialized from `100dvh` and updated from `window.visualViewport.height` when that API is available. The application shell, chat pane, drawer/sheet layers, and fixed guest route use this value rather than a fixed `100vh` or stale `innerHeight`. Preserve the desktop `100dvh` fallback when `visualViewport` is absent.

Apply `env(safe-area-inset-top)` to mobile headers and drawer/sheet tops, and `env(safe-area-inset-bottom)` to composer, sheet/dialog footer, and drawer bottom padding. The only page-level scroll lock is the application shell. The message log, drawer body, sheet body, and settings body are the named vertical scroll containers and use `overscroll-behavior: contain`.

When an input receives focus or the visual viewport shrinks, update the layout in the next animation frame and scroll the focused input and its primary action into nearest view without moving the message log unexpectedly. The composer remains visually above the keyboard, retains a 44px Send target, and its status/error text remains reachable by scrolling its own pane. Do not hide the active conversation, Send control, close control, or form submit action merely to preserve header chrome. In short-height landscape, abbreviate decorative brand/rate copy before hiding any labelled action.

Supported proof viewports are: phone portrait `390×844`, phone landscape `844×390`, short portrait `390×520`, and a reduced visual viewport of `390×430` while the composer or a form input is focused. Layout remains usable at 320px width; the named proof cases are the minimum browser-evidence set, not a maximum-device whitelist.

### Coordinator lifecycle and persistence truthfulness

Coordinator state must never use mobile copy that implies durable storage before IndexedDB has accepted a validated identity-scoped snapshot.

- Startup uses compact inline progress in the active conversation/workspace and keeps `Starting coordinator…`, room-restore progress, and persistence state visible without displacing the drawer trigger or active chat.
- A successful durable state is labelled `Saved on this device`. A temporary path is visibly labelled `Temporary session — changes will not be saved.` This label persists for the entire temporary session in the coordinator controls and settings; it is not a transient toast.
- If IndexedDB is unavailable, denied, corrupt, or quota-exhausted, open a `Storage needs attention` recovery sheet before startup can claim durable operation. The sheet explains the safe next action, never includes a pubkey, key, invite, room secret, raw exception, or browser storage dump. `Retry storage` retries a bounded operation. `Continue temporarily` is an explicit secondary decision and starts a non-durable session only after the visible temporary-session disclosure. For corrupt state only, `Remove corrupt saved data` requires the destructive confirmation below before retrying setup; it never attaches legacy/unscoped state to the current coordinator.
- During a normal stop, show `Stopping and saving…` and disable only duplicate lifecycle actions. Do not render `Stopped` or a durable-success status until the serialized snapshot flush has resolved. On flush failure, keep the failure sheet open with `Try saving again`, `Keep running`, and the destructive fallback `Stop without saving`; no path may call that result a successful durable stop.
- A new coordinator identity with an unscoped legacy snapshot starts as a fresh state. It must be told `Previous coordinator data was not used for this identity.` only when that recovery choice is relevant; it must not surface the prior identity.

### Motion and visual hierarchy

The active conversation and composer remain the primary mobile eye path. The open drawer/sheet becomes the local focal surface; coordinator cards, metadata, hairlines, and inactive controls remain quiet. Use at most the existing 150ms `opacity`/`transform` transition for drawer/sheet entry and nonessential disclosure changes. Never animate height, layout position, padding, or a list's scroll position. Under `prefers-reduced-motion: reduce`, all drawer/sheet/disclosure/reaction transitions are immediate; progress remains textually readable and functional.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Mobile navigation trigger | `Open room browser` / `Close room browser` |
| Drawer heading | `Rooms` |
| Room browser loading | `Loading saved chats…` |
| Guest room browser empty | `No chats saved on this device.` — action: `Join from invite` |
| Host room browser empty | `No groups yet.` — action: `Create group` |
| Room browser failure | `Couldn’t load saved chats. Close the room browser and try again.` — action: `Close room browser` |
| Offline disclosure | `Show {N} offline chat` / `Show {N} offline chats` / `Hide offline chats` |
| Primary safe storage CTA | `Retry storage` |
| Temporary storage choice | `Continue temporarily` |
| Temporary session indicator | `Temporary session — changes will not be saved.` |
| Durable storage indicator | `Saved on this device` |
| Storage-recovery heading | `Storage needs attention` |
| Unavailable/denied storage body | `CAHMLS could not open durable coordinator storage. Retry, or continue temporarily if you understand that changes will be lost when this session ends.` |
| Quota storage body | `This browser does not have enough space to save coordinator changes. Free up browser storage, then try again.` |
| Corrupt storage body | `Saved coordinator data could not be read safely. You can remove that saved data and set up this coordinator again.` |
| Legacy-scope guidance | `Previous coordinator data was not used for this identity.` |
| Stop pending | `Stopping and saving…` |
| Flush error | `CAHMLS could not save the latest coordinator changes. Try saving again, keep running, or stop without saving.` |
| Conversation empty state | `Say hello — messages are encrypted before they leave your device.` |
| Generic action error | `Couldn’t complete that action. Check your connection and try again.` |
| Destructive storage confirmation | `Remove corrupt saved data?` — `This removes unreadable coordinator data from this browser. It cannot be restored.` Actions: `Keep saved data` and `Remove saved data`. |
| Destructive stop confirmation | `Stop without saving?` — `The latest coordinator changes may be lost on reload.` Actions: `Keep running` and `Stop without saving`. |

Retain prior approved copy for invitations, notifications, profile/presence, identity rotation, room removal, and participant actions. No error, accessible label, live region, test-only UI, or browser alert may expose private keys, invite URLs, room secrets, decrypted message text, raw IndexedDB errors, or prior coordinator identity values.

---

## Responsive Proof Contract

Playwright must add real touch-enabled mobile projects for Chromium and WebKit. They must use device descriptors or equivalent contexts with `isMobile: true` and `hasTouch: true`; resized Desktop Chrome contexts and mouse `.click()` alone do not satisfy this phase. All primary mobile interactions are exercised with `.tap()` or an equivalent touch input.

Required browser evidence:

1. **Host journey, both engines:** fresh identity/setup; start; create room; open/copy/use invite; admit a participant; send/receive encrypted messages; add/remove a reaction; use room actions, notifications, profile/settings, Favorites, History, offline disclosure, stop, restart, and reload. Every required action is a touch action.
2. **Two-client chat journey, both engines:** host and independent invitee enter through a real canonical invite/admission flow, exchange encrypted messages and reactions in both directions, navigate away/back through the shared room browser, and preserve the active conversation/conversation state.
3. **Overlay evidence:** drawer, each sheet/dialog category, room/participant/reaction action sheet, and notification/profile/settings surfaces open by tap, stay inside the visual viewport, scroll internally with long content, close by visible control and outside tap where safe, and restore focus after Escape. Platform Back closes the top transient overlay before navigating.
4. **Layout evidence:** run the critical journey at `390×844`, `844×390`, `390×520`, and reduced visual viewport `390×430` with a focused composer/form. Assert no document overflow, safe-area padding where the engine exposes it, and that the focused input plus primary action are visible. Maintain an explicit assertion inventory for every mobile control class: top-bar/browser controls; coordinator lifecycle/settings/create; room open/favorite/more/offline disclosure; invitation/admission; message reaction/add/emoji; composer Send; profile/presence/notification/settings; sheet/dialog close, safe, and destructive actions; and first-run/identity controls. Every inventoried class must prove a 44-by-44 CSS-pixel target rather than relying only on the controls touched incidentally by the happy-path journey.
5. **Persistence evidence:** verify identity-scoped IndexedDB restore after reload, ordered writes, flush-before-successful-stop, denied/open/write/quota failures, corrupt data, legacy unscoped data, explicit temporary session, and absence of secret-bearing UI/log diagnostics. Storage-failure recovery must terminate rather than recursively restarting coordinator startup.
6. **Motion/accessibility evidence:** run the drawer/offline disclosure/reaction path under reduced motion and assert immediate final state; verify visible focus, accessible names, inert background, and no hover-only required action.

These mobile suites supplement—not replace—the repository quality gates and `check:upstream` / `test:upstream-interop` Cordn proof.

---

## UI Considerations

Applicable state considerations resolved: 19 covered, 7 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| populated | Room browser navigation | ✅ covered | The shared host/guest drawer presents stable Join, coordinator, Favorites, History, and personal-control content in the prescribed order while keeping the active conversation behind it. |
| empty | Room browser, coordinator, and Favorites collections | ✅ covered | Guest uses `No chats saved on this device.` / `Join from invite`; host uses `No groups yet.` / `Create group` once ready; Favorites remains absent when empty. |
| loading | Room browser collection | ✅ covered | `Loading saved chats…` prevents a false empty state while local records restore; the 44px close control remains available. |
| error | Room browser collection | ✅ covered | `Couldn’t load saved chats. Close the room browser and try again.` supplies a bounded recovery path through `Close room browser`. |
| zero-one-many | Offline disclosure and room collections | ✅ covered | One offline room uses singular copy; two or more use plural copy; collections retain the existing five-row/show-more rule and no rooms retain their existing empty state. |
| overflow | Drawer, coordinator card, History, and long room list | 🧪 backstop | Touch suites must prove internal vertical scrolling, no document horizontal overflow, 44px action columns, and containment at portrait, landscape, and short height. |
| long-text | Navigation rows, headings, and recovery copy | ✅ covered | One-line labels truncate with full accessible names/title; explanatory/error copy wraps anywhere without masking action targets. |
| loading | Startup/stop persistence status | ✅ covered | Starting and stopping present explicit progress/pending copy, retain reachable navigation, and prohibit durable-success copy until the async boundary settles. |
| error | Storage recovery surface | 🧪 backstop | Browser coverage must prove denied, unavailable, corrupt, and quota paths offer the documented bounded retry/temporary/destructive choices with no raw diagnostics or startup recursion. |
| populated | Message log and reaction aggregates | ✅ covered | Existing grouped messages and aggregate reaction counts remain in the primary pane; mobile reaction selection uses a contained sheet without changing wire semantics. |
| empty | Message log | ✅ covered | The documented encrypted-message empty state remains centered in the log while the 44px composer and navigation remain reachable. |
| partial | History/Favorites/room lists | ✅ covered | Five-row initial display, active/revealed-room substitution, and collapsed History retain their explicit show-more/history controls instead of silently omitting items. |
| overflow | Message log, composer, keyboard-reduced viewport | 🧪 backstop | Chromium and WebKit tests must prove the focused input and Send action remain reachable at the reduced visual viewport without document scrolling or obscured composer. |
| long-text | Composer and storage error/action controls | ✅ covered | Message text and recovery detail wrap; a long message never changes the fixed composer action geometry or reveals secret data. |
| loading | Send, reaction, invite, and admission actions | ✅ covered | Pending actions retain existing disabled/`aria-busy` states and truthful status while avoiding duplicate touch submissions. |
| error | Chat action and admission surfaces | ✅ covered | Existing safe retry copy persists in the relevant contained surface and retains the action needed to retry. |
| populated | Sheets, dialogs, notification/profile/settings forms | ✅ covered | Each surface has a heading, scroll body, sticky action area where required, visible close control, and a single modal owner. |
| overflow | Sheets, dialogs, and anchored overlay replacement | 🧪 backstop | Tests must prove viewport bounds, internal scroll, safe-area insets, outside-tap dismissal where safe, Escape/back closure, focus trap/return, and inert background. |
| long-text | Sheet/dialog titles and menu rows | ✅ covered | Titles wrap or truncate safely according to role and retain their full accessible text; all 44px controls remain exposed. |
| loading | Drawer navigation after room selection | ✅ covered | Selecting a room closes the drawer immediately, establishes the exact-room pending state in the primary pane, and does not leave an inert/hidden interactive rail. |
| error | Room navigation / unavailable coordinator | ✅ covered | Existing offline/unavailable state remains neutral and retains historical navigation; no unavailable CTA implies a join or storage success. |
| overflow | Coarse-pointer target system | 🧪 backstop | Automated rectangle assertions cover every touched class of control—including previously hover-only disclosure, favorite, reaction, and room actions—at all mandated phone states. |
| long-text | Primary navigation trigger and personal controls | ✅ covered | Room title text in the trigger truncates independently of the count; personal controls retain their explicit accessible names at every breakpoint. |
| loading | First-run and coordinator setup forms | ✅ covered | Saving/starting visibly disables duplicate submit actions but leaves the current field and recovery status understandable. |
| error | Setup and temporary-session choice | 🧪 backstop | Touch coverage must prove a storage failure can be retried or explicitly converted to a temporary session without a false persistence claim. |
| zero-one-many | Notification and invitation collections | ✅ covered | Preserve prior zero/unread/plural notification copy and invitation action semantics inside a contained mobile sheet. |
| overflow | QR/invite and settings forms | 🧪 backstop | Short-height and landscape tests must prove scan/copy/form actions remain scrollable and tappable within the visual viewport. |
| populated | Reduced-motion navigation and overlays | ✅ covered | Reduced motion renders each final drawer/sheet/disclosure state immediately without removing functionality. |

---

## Non-Goals

- No native iOS/Android package, push backend, gesture-only shortcut, new visual identity, or new component framework.
- No Cordn, MLS, ContextVM, Nostr, invitation, admission, or encrypted-wire contract change.
- No persistence fallback that silently uses synchronous whole-snapshot `localStorage` while claiming mobile-safe durability.
- No assertion of mobile support from desktop-resize tests, mouse-only tests, screenshots alone, hover-only affordances, or focus-only disclosures.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable — shadcn is not initialized |
| Third-party | none | not applicable — no registry code enters the phase |

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved by independent UI checker on 2026-08-07
