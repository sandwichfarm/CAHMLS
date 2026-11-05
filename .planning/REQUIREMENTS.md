# Requirements: CAHMLS Quality of Life & Polish

**Defined:** 2026-08-02
**Core Value:** A single browser tab acts as a fully functional, self-sovereign Cordn coordinator reachable over Nostr relays — no backend, no account, no installation.

## v1.1 Requirements

### Identity Continuity & Membership Integrity

- [x] **IDEN-01**: An anonymous identity, including its signing key and local profile, survives ordinary page reloads and browser restarts on the same device.
- [x] **IDEN-02**: An anonymous user can deliberately rotate to a fresh identity from the identity menu after a confirmation that explains the room-membership consequences.
- [x] **IDEN-03**: Rotating an anonymous identity retires the old identity's active room credentials locally so the new identity cannot send to rooms it has not joined.
- [x] **IDEN-04**: Reloading or restarting an ephemeral host does not create duplicate coordinator or room entries for participants; stored sessions are keyed and reconciled by stable coordinator and room identities.

### Room Navigation & Unread State

- [x] **ROOM-01**: A user can hover or keyboard-focus an eligible room in the sidebar, open a three-dot context menu, and leave it without first opening that room.
- [x] **ROOM-02**: Leaving a room from the sidebar targets that exact room and coordinator and requires a contextual confirmation before local membership state is removed.
- [x] **ROOM-03**: Every room with unread messages shows an accurate unread-count badge that increments for newly received messages and clears when the room is read.

### Coordinator Startup & Recovery

- [x] **BOOT-01**: Coordinator startup reports room restoration as an explicit progress stage, including the current room and aggregate completion progress.
- [x] **BOOT-02**: Recoverable room connection timeouts remain in the startup/retry experience instead of surfacing as terminal MCP errors; a persistent failure becomes an actionable error only after recovery is exhausted.
- [x] **BOOT-03**: A locally hosted room cannot render as a disconnected chat while its coordinator startup and room recovery are still in progress.

### Startup Motion

- [x] **MOTION-01**: The startup ASCII field fills the workspace content container edge to edge at every supported desktop size without leaving the right portion uncovered.
- [x] **MOTION-02**: Startup rings are true masks/reveals of the ASCII field and are animated with GSAP rather than independent static border circles.
- [x] **MOTION-03**: Startup motion remains smooth, responds to progress state, and honors `prefers-reduced-motion` without hiding status or progress information.

### Presence, Invitations & Shell Controls

- [ ] **PRES-01**: Online, invisible, and offline presence options are selected inside the user/profile dropdown rather than a separate header control.
- [ ] **PRES-02**: The active presence state is represented by a status dot attached to the user/avatar control and is available to keyboard and screen-reader users.
- [x] **INVITE-01**: Incoming room invitations appear in a discoverable, actionable personal-notification surface instead of an isolated empty room-invites popover.
- [ ] **SHELL-01**: Header controls clearly separate personal/user actions from host/coordinator lifecycle actions and avoid duplicate status or settings controls.
- [x] **SHELL-02**: Every menu, popover, or dialog opened from the clipped sidebar renders in a viewport-level overlay layer, remains fully reachable at supported widths and short heights, and returns focus to its originating control when closed.

### Notifications

- [x] **NOTF-01**: The existing notification preference control is labeled `Notification settings` and opens a working settings surface with persisted choices.
- [x] **NOTF-02**: A separate bell control opens an in-app notification feed with unread state, concise grouped entries, and actions for applicable events such as room invitations.
- [x] **NOTF-03**: Browser notification permission is requested only from an explicit user action, and enabled desktop notifications are delivered on the configured cadence without duplicate bursts.
- [x] **NOTF-05**: The in-app notification feed provides an accessible clear-all action that removes persisted feed history and unread state without accepting, dismissing, or resolving live room invitations.
- [x] **NOTF-06**: A persisted global sound control lives at the top-right of the workspace, while each channel can override sound and choose message notifications from all, follows, mutuals, or mute; channels with non-default choices show a compact indicator.
- [x] **SHELL-03**: The local coordinator card exposes a large, right-aligned `+` create action without the `Group` label and provides clear hover/focus motion without moving surrounding content.

### Conversation Presentation & Reactions

- [x] **REACT-01**: Each message or message group exposes a compact reaction-add affordance that overlaps the bubble border and opens an inline emoji picker.
- [x] **REACT-02**: Reactions are aggregated by emoji across all participants, show total counts, and let the current participant toggle their own reaction on messages authored by other participants without duplicating counts; participants cannot react to their own messages.
- [x] **CHAT-01**: Consecutive messages from the same sender are rendered as one sender group with the avatar and display name shown once and individual message bubbles beneath it.
- [x] **CHAT-02**: Every message keeps its timestamp and relevant metadata visible in a smaller, lower-contrast treatment without repeating sender chrome.
- [x] **CHAT-04**: A valid Cordn invite shared as a chat message renders as a contextual join action naming the group, coordinator, and host, and activates the canonical current-shell join flow without exposing malformed text as an action.

### Delivery Process & Verification

- [ ] **DOC-01**: Root `AGENTS.md` documents the repository's desired GSD-centered SDLC, including requirements, planning, plan checking, execution, verification, gap closure, review, and shipping expectations.
- [ ] **TEST-01**: Unit and Playwright coverage proves identity persistence/rotation, exact room leave targeting, unread badges, startup recovery, notification behavior, shell control placement, grouped messages, and aggregated reactions.
- [ ] **INTEROP-01**: Every room exposes one current-origin invite link whose group id, coordinator nprofile/relay hints, and Cordn `name` metadata can be consumed by both CAHMLS and canonical cordn.net clients; a canonical client can then complete MLS admission without a CAHMLS-only invite extension.

### First-Run Coordinator Identity & Profile

- [ ] **SETUP-01**: Before the first coordinator start, an operator chooses either an existing supported Nostr sign-in method or the durable anonymous identity, with anonymous operation remaining fully supported.
- [ ] **SETUP-02**: After choosing identity, the operator must provide a non-empty normalized coordinator name; an authenticated profile name is used as an editable prefill when available and anonymous setup provides a sensible editable default.
- [ ] **SETUP-03**: Setup completion and coordinator name persist across ordinary restarts, while existing installations with a meaningful configured name migrate without unnecessary onboarding.
- [ ] **SETUP-04**: The operator can edit the coordinator name later through settings and a changed name is republished without replacing either the operator identity or coordinator transport identity.
- [x] **SETUP-05**: After naming a coordinator on first run, the operator is offered a recommended setup that requires a confirmed encryption passphrase, persists the coordinator identity on this device, enables autostart, and starts the coordinator without requiring a settings-panel detour.
- [x] **SETUP-06**: An advanced first-run wizard presents one decision at a time in this order: persistent (default) or ephemeral identity, editable relay defaults with add/remove support, announcement yes/no, and autostart yes/no.
- [x] **SETUP-07**: First-run setup choices are committed only when the wizard finishes, survive reload, are skipped after completion, and are shown again after a coordinator reset.
- [ ] **PROFILE-01**: CAHMLS publishes the selected coordinator name in the coordinator-key-signed kind-0 profile and the ContextVM kind-11316 announcement `name` tag through configured shareable relays, and exposes that same name through MCP initialize so invitees see it as the coordinator name instead of an `npub` fallback.
- [ ] **PROFILE-02**: Coordinator profile updates preserve existing metadata where possible, surface actionable retry state on publication failure, and never corrupt or prevent an otherwise valid coordinator runtime.

### Coordinator-Grouped Sidebar

- [x] **SIDE-01**: The sidebar keeps `Join from invite` first, followed by a dedicated local coordinator identity/status/control box with the selected local room's invite/admission controls attached as its bottom row, then coordinator-grouped room cards; the local control stack remains visible while browsing another coordinator.
- [x] **SIDE-02**: Every active coordinator renders as its own lightweight hairline card with its label embedded in the border; the local coordinator is always first and uniquely exposes a `+ Group` action.
- [x] **SIDE-03**: Each coordinator card shows at most five rooms by default and exposes an accessible show-more/show-less reveal without hiding unread state or the active room.
- [x] **SIDE-04**: Retired memberships, rotated local coordinator rooms, and explicitly deleted or left rooms appear only in one collapsed `History` section containing non-secret display metadata.
- [x] **SIDE-05**: Coordinator and room ordering is stable across connection, unread, and message activity changes and persists across browser sessions; newly discovered entries append without reordering existing entries.
- [x] **SIDE-06**: The reorganized sidebar remains keyboard-operable, screen-reader-labelled, compact-viewport bounded, and preserves exact room open/delete/leave targeting.

### Bounded Gift-Wrap Delivery

- [x] **RELAY-01**: Optional localhost publication is readiness-gated, time-bounded, and cannot block or degrade a healthy remote relay path.
- [x] **RELAY-02**: Every primary and optional publication has explicit retry and elapsed-time limits and is aborted when its relay handler, owning room session, or coordinator transport closes.
- [x] **RELAY-03**: Steady-state room polling remains single-flight so an unresolved sync or publication cannot accumulate additional ContextVM gift-wrap requests.
- [x] **RELAY-04**: Safe publish diagnostics identify relay URL, event ID, event kind, logical operation, attempt, elapsed time, and terminal outcome without exposing encrypted content or secrets.
- [x] **RELAY-05**: Bounded delivery retains transient-outage recovery, multi-relay success, reconnect behavior, and persistent/ephemeral ContextVM gift-wrap interoperability.
- [x] **RELAY-06**: Automated coverage proves offline-localhost containment, bounded retry lifetime, lifecycle cancellation, single-flight polling, healthy-remote isolation, and transient recovery.

### Chat User Interactions

- [x] **USER-01**: Every other participant's author identity exposes one keyboard-accessible context menu with Mention, Ignore, Invite, Follow, and Highlight actions; the current user's own identity does not expose self-directed actions.
- [x] **MENTION-01**: Mentioning a participant inserts an editable human-readable mention into either chat composer and sends the participant pubkey as a signed canonical kind-9 `p` tag without breaking legacy message decoding.
- [x] **MENTION-02**: A message that explicitly mentions the current room identity is visibly emphasized and accessibly identified in both host and invitee chat views, while mentions of other participants remain ordinary messages.
- [x] **INVMSG-01**: A room-invite message with no participant tags renders a join action for everyone; a tagged room invite renders only for a tagged viewer, renders nothing for other viewers, and never displays its mention tokens as chat text.
- [x] **IGNORE-01**: Ignoring a participant is persisted per exact room and collapses each consecutive streak from that participant into one centered “posted N messages” disclosure that the viewer can expand without changing what other participants receive.
- [x] **INVUSER-01**: Inviting a participant from their context menu lets the viewer choose another active room and sends that room's current invite as a tagged in-room message addressed to the selected participant.
- [x] **FOLLOW-01**: The active signed-in identity's kind-3 list is fetched at the earliest identity-ready lifecycle point, accepts only valid signatures from the active pubkey, selects the newest event deterministically, and stays current from live relay events.
- [x] **FOLLOW-02**: Following a participant serially merges a new `p` tag into the newest validated kind-3 event, preserves unrelated tags and content, signs a strictly newer replacement, publishes it to the configured social relays, and does not report success until publication succeeds.
- [x] **HILITE-01**: A viewer can choose or clear a participant highlight color; the preference persists between browser sessions and is rendered consistently in both host and invitee chat views without reducing text contrast.

## Future Requirements

### Notification Expansion

- **NOTF-04**: In-app notification history can be synchronized across multiple devices for the same signed-in Nostr identity.

### Conversation Expansion

- **CHAT-03**: Users can configure the time window that determines message-group boundaries.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Server-side identity or notification accounts | The application remains browser-resident and self-sovereign. |
| Email, SMS, or push-service notification backend | This milestone covers local in-app and browser notifications only. |
| Replacing MLS or ContextVM transport protocols | The milestone repairs continuity and presentation around the existing protocol stack. |
| Full mobile-first redesign | Layout must remain coherent, but this milestone targets the current desktop workspace. |
| Historical access after explicit identity rotation | Rotation is a deliberate privacy boundary; old credentials are retired unless the old identity is restored separately. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| IDEN-01 | Phase 15 | Complete |
| IDEN-02 | Phase 15 | Complete |
| IDEN-03 | Phase 15 | Complete |
| IDEN-04 | Phase 15 | Complete |
| ROOM-01 | Phase 16 | Complete |
| ROOM-02 | Phase 16 | Complete |
| ROOM-03 | Phase 16 | Complete |
| BOOT-01 | Phase 16 | Complete |
| BOOT-02 | Phase 16 | Complete |
| BOOT-03 | Phase 16 | Complete |
| MOTION-01 | Phase 17 | Complete |
| MOTION-02 | Phase 17 | Complete |
| MOTION-03 | Phase 17 | Complete |
| PRES-01 | Phase 18 | Pending |
| PRES-02 | Phase 18 | Pending |
| INVITE-01 | Phase 18 | Complete |
| SHELL-01 | Phase 18 | Pending |
| SHELL-02 | Phase 18 | Complete |
| NOTF-01 | Phase 18 | Complete |
| NOTF-02 | Phase 18 | Complete |
| NOTF-03 | Phase 18 | Complete |
| NOTF-05 | Phase 18 | Complete |
| REACT-01 | Phase 19 | Complete |
| REACT-02 | Phase 19 | Complete |
| CHAT-01 | Phase 19 | Complete |
| CHAT-02 | Phase 19 | Complete |
| CHAT-04 | Phase 19 | Complete |
| DOC-01 | Phase 20 | Pending |
| TEST-01 | Phase 20 | Pending |
| INTEROP-01 | Phase 20 | Pending |
| SETUP-01 | Phase 21 | Pending |
| SETUP-02 | Phase 21 | Pending |
| SETUP-03 | Phase 21 | Pending |
| SETUP-04 | Phase 21 | Pending |
| SETUP-05 | Phase 21 | Complete |
| SETUP-06 | Phase 21 | Complete |
| SETUP-07 | Phase 21 | Complete |
| PROFILE-01 | Phase 21 | Pending |
| PROFILE-02 | Phase 21 | Pending |
| SIDE-01 | Phase 22 | Complete |
| SIDE-02 | Phase 22 | Complete |
| SIDE-03 | Phase 22 | Complete |
| SIDE-04 | Phase 22 | Complete |
| SIDE-05 | Phase 22 | Complete |
| SIDE-06 | Phase 22 | Complete |
| RELAY-01 | Phase 23 | Complete |
| RELAY-02 | Phase 23 | Complete |
| RELAY-03 | Phase 23 | Complete |
| RELAY-04 | Phase 23 | Complete |
| RELAY-05 | Phase 23 | Complete |
| RELAY-06 | Phase 23 | Complete |
| USER-01 | Phase 24 | Complete |
| MENTION-01 | Phase 24 | Complete |
| MENTION-02 | Phase 24 | Complete |
| INVMSG-01 | Phase 24 | Complete |
| IGNORE-01 | Phase 24 | Complete |
| INVUSER-01 | Phase 24 | Complete |
| FOLLOW-01 | Phase 24 | Complete |
| FOLLOW-02 | Phase 24 | Complete |
| HILITE-01 | Phase 24 | Complete |

**Coverage:**

- v1.1 requirements: 56 total
- Mapped to phases: 56
- Unmapped: 0 ✓

---
*Requirements defined: 2026-08-02*
*Last updated: 2026-08-06 after bounded gift-wrap delivery scope confirmation*
