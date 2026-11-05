# Roadmap: Cordn Browser

## Overview

Milestone v1.1, **Quality of Life & Polish**, makes a browser-resident Cordn
coordinator feel coherent and trustworthy through daily reloads and active room
use. It starts by preserving anonymous identity and membership integrity, then
makes room recovery and navigation truthful, turns recovery into a clear startup
experience, consolidates personal and host controls, modernizes conversations,
and closes with repeatable delivery guidance and automated proof.

## Phases

- [x] **Phase 15: Identity Continuity & Membership Integrity** - Preserve anonymous identity across reloads and make deliberate rotation a safe privacy boundary. (completed 2026-08-02)
- [x] **Phase 16: Resilient Rooms & Recovery** - Make room navigation, unread state, and coordinator-led room restoration accurate and actionable. (completed 2026-08-02)
- [x] **Phase 17: Content-Pane Startup Motion** - Turn truthful room-recovery progress into an accessible GSAP ASCII startup experience that fills the workspace content pane. (completed 2026-08-03)
- [ ] **Phase 18: Unified Presence, Notifications & Controls** - Consolidate personal presence and notifications while separating them from host lifecycle actions.
- [x] **Phase 19: Grouped Conversations & Reactions** - Make active conversations easier to scan and react to without visual repetition.
- [ ] **Phase 20: Delivery Contract & Regression Proof** - Document the GSD lifecycle and protect the complete v1.1 experience with automated coverage.
- [ ] **Phase 21: First-Run Coordinator Identity & Profile** - Require deliberate operator identity and coordinator naming before first startup.
- [x] **Phase 22: Coordinator-Grouped Sidebar** - Replace the selected-coordinator switcher with stable, lightweight coordinator cards and collapsed room history. (completed 2026-08-06)
- [x] **Phase 23: Bounded Gift-Wrap Delivery** - Stop unavailable relays and room polling from accumulating immortal ContextVM gift-wrap publications.

## Phase Details

### Phase 15: Identity Continuity & Membership Integrity

**Goal**: Anonymous users retain one durable local identity and only the room authority that belongs to that identity.
**Depends on**: Phase 14
**Requirements**: IDEN-01, IDEN-02, IDEN-03, IDEN-04
**Success Criteria** (what must be TRUE):

  1. After an ordinary page reload or browser restart on the same device, a user returns as the same anonymous identity with its local profile.
  2. Restoring an ephemeral host shows each previously known coordinator and room once, without duplicate participant, coordinator, or room entries.
  3. From the identity menu, a user can choose to rotate identity and must explicitly confirm after seeing that existing room membership will not carry over.
  4. After confirmed rotation, the new identity cannot send with the retired identity's locally stored room credentials until it joins a room itself.

**Plans**: 3/3 plans executed

- [x] 15-01-PLAN.md
- [x] 15-02-PLAN.md
- [x] 15-03-PLAN.md

**UI hint**: yes

### Phase 16: Resilient Rooms & Recovery

**Goal**: Users can navigate and leave the exact room they intend while room restoration presents reliable state instead of misleading failures.
**Depends on**: Phase 15
**Requirements**: ROOM-01, ROOM-02, ROOM-03, BOOT-01, BOOT-02, BOOT-03
**Success Criteria** (what must be TRUE):

  1. A user can hover or keyboard-focus an eligible sidebar room, open its context menu, and confirm leaving that exact room and coordinator without opening the room first.
  2. Each room with new messages displays an accurate unread count, which increments for received messages and clears when that room is read.
  3. While starting a coordinator, the user sees each room being restored and aggregate restoration progress.
  4. A recoverable room timeout remains visible as retry/recovery progress; only an exhausted recovery becomes an actionable failure.
  5. A locally hosted room remains visibly recovering during startup and never appears as a disconnected chat before recovery finishes.

**Plans**: 6/6 plans executed

- [x] 16-01-PLAN.md
- [x] 16-02-PLAN.md
- [x] 16-03-PLAN.md
- [x] 16-04-PLAN.md
- [x] 16-05-PLAN.md
- [x] 16-06-PLAN.md

**UI hint**: yes

### Phase 17: Content-Pane Startup Motion

**Goal**: Coordinator recovery progress is communicated by a smooth, accessible startup motion that completely fills the workspace content pane while retaining the surrounding application shell.
**Depends on**: Phase 16
**Requirements**: MOTION-01, MOTION-02, MOTION-03
**Success Criteria** (what must be TRUE):

  1. At every supported desktop size, the startup ASCII field covers the entire workspace content pane with no uncovered right portion or internal gutter.
  2. Startup rings reveal and mask the ASCII field itself, rather than appearing as independent static border circles, and animate through GSAP.
  3. Startup motion responds to current recovery progress without obscuring status information.
  4. Users with reduced-motion enabled retain readable startup status and progress while nonessential motion is suppressed.

**Plans**: 2/2 plans executed

- [x] 17-01-PLAN.md
- [x] 17-02-PLAN.md

**UI hint**: yes

### Phase 18: Unified Presence, Notifications & Controls

**Goal**: Users can find personal presence, notification, and invitation actions in one coherent surface, distinct from coordinator lifecycle controls.
**Depends on**: Phase 16
**Requirements**: PRES-01, PRES-02, INVITE-01, SHELL-01, SHELL-02, SHELL-03, NOTF-01, NOTF-02, NOTF-03, NOTF-05, NOTF-06
**Success Criteria** (what must be TRUE):

  1. The profile dropdown lets a user select online, invisible, or offline presence, and its active accessible status dot is attached to the user/avatar control.
  2. Header controls plainly separate personal actions from host/coordinator lifecycle actions, with no duplicate status or settings controls.
  3. A clearly labeled `Notification settings` action opens a working settings surface and retains the user's choices.
  4. A separate bell opens a grouped in-app notification feed with unread state and actionable incoming room invitations.
  5. Browser-notification permission is requested only after a user action, and enabled desktop notifications follow the configured cadence without duplicate bursts.
  6. Users can clear all persisted in-app notification history without implicitly resolving live room invitations.
  7. Sidebar-originated menus, popovers, and dialogs escape rail clipping and remain viewport-contained, scrollable, and focus-safe across supported viewport sizes.
  8. Global sound is controlled from the top-right, each channel can override sound and filter message notifications by relationship, and non-default channels are visibly marked.
  9. The coordinator create action is a large right-aligned animated `+` with an accessible `Create group` name.

**Plans**: 3/4 plans executed

Plans:

- [x] 18-01-PLAN.md — Establish the feed-first notification ledger, optional desktop projection, and safe invitation replay state.
- [x] 18-02-PLAN.md — Deliver the separate bell feed, same-shell invitation actions, and exact Notification settings surface.
- [ ] 18-03-PLAN.md — Move presence into the profile and finalize personal/host control ownership across breakpoints.
- [x] 18-04-PLAN.md — Introduce one viewport overlay primitive and migrate every sidebar-originated floating surface with constrained-resolution regressions.
- [x] 18-05-PLAN.md — Add global and per-channel sound/notification controls plus the compact coordinator create affordance.

**UI hint**: yes

### Phase 19: Grouped Conversations & Reactions

**Goal**: Users can scan active conversations quickly and use compact, accurate reactions on message groups.
**Depends on**: Phase 17
**Requirements**: REACT-01, REACT-02, CHAT-01, CHAT-02, CHAT-04
**Success Criteria** (what must be TRUE):

  1. Consecutive messages from one sender render as a single group with the sender avatar and name shown once above its individual bubbles.
  2. Every message retains its timestamp and relevant metadata in a smaller, lower-contrast treatment without repeating sender chrome.
  3. Each message or message group offers a compact reaction-add affordance overlapping the bubble border and opens an inline emoji picker.
  4. Reactions aggregate by emoji across participants, show total counts, and let the current participant toggle their own reaction without duplicating the count.

**Plans**: 1 plan

- [x] 19-01-PLAN.md — Deliver one ownership-aware grouped renderer with adaptive timestamps and retained reaction interoperability.

**UI hint**: yes

### Phase 20: Delivery Contract & Regression Proof

**Goal**: Contributors can follow one documented GSD delivery lifecycle and reliably detect regressions across the completed v1.1 experience.
**Depends on**: Phase 19
**Requirements**: DOC-01, TEST-01, INTEROP-01
**Success Criteria** (what must be TRUE):

  1. A contributor can read the root `AGENTS.md` and follow the repository's required GSD flow for requirements, planning, plan checks, execution, verification, gap closure, review, and shipping.
  2. Contributors can run unit and Playwright coverage that exercises identity continuity and rotation, exact room leaving, unread state, and startup recovery.
  3. The same automated coverage detects regressions in notifications, consolidated controls, grouped conversations, and aggregated reactions before release.
  4. Each room presents one current-origin Cordn-compatible invite link (not separate native/interoperable variants), and a canonical cordn.net requester can use it, be admitted with its requested KeyPackage, and consume the resulting Welcome over the Nostr transport.

**Plans**: TBD

### Phase 21: First-Run Coordinator Identity & Profile

**Goal**: A first-time operator deliberately chooses an authenticated or anonymous operator identity, names the coordinator before startup, and has that name resolve in canonical Cordn clients.
**Depends on**: Phase 17
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05, SETUP-06, SETUP-07, PROFILE-01, PROFILE-02
**Success Criteria** (what must be TRUE):

  1. A new installation cannot start its coordinator until the operator has explicitly chosen sign-in or durable anonymous operation and supplied a valid coordinator name.
  2. Authenticated setup prefills an available Nostr profile name, anonymous setup remains fully supported, and completed or meaningfully configured installations do not repeat onboarding after restart.
  3. Editing the persisted coordinator name later republishes a valid kind-0 event signed by the unchanged coordinator key through the configured shareable relays.
  4. Canonical cordn.net resolves the selected name rather than an `npub` fallback, while publication failures expose retry state without corrupting or unnecessarily stopping the coordinator.

**Integration note:** Phase 21 is independently executable against the current shell. It must preserve and integrate the in-progress Phase 18 personal/host control ownership edits, but does not depend on Phase 18 completion.

**Plans**: 5 plans

Plans:

- [ ] 21-01-PLAN.md — Enforce durable setup completion and configure MCP/transport identity metadata.
- [ ] 21-02-PLAN.md — Publish preserved coordinator-key kind-0 metadata with safe retry orchestration.
- [ ] 21-03-PLAN.md — Deliver identity-first onboarding, authenticated prefill, anonymous continuity, and autostart gating.
- [ ] 21-04-PLAN.md — Persist and immediately republish settings renames with truthful restart status.
- [ ] 21-05-PLAN.md — Verify live canonical cordn.net name resolution before and after rename/restart.

**UI hint**: yes

### Phase 22: Coordinator-Grouped Sidebar

**Goal**: Users can understand and navigate local, remote, and historical groups without coordinator switching or activity-driven list movement.
**Depends on**: Phase 18
**Requirements**: SIDE-01, SIDE-02, SIDE-03, SIDE-04, SIDE-05, SIDE-06
**Success Criteria** (what must be TRUE):

  1. The rail order is Join from invite → local coordinator controls → selected local-room invite/admission controls → local and remote coordinator cards → collapsed History → personal controls.
  2. Every active coordinator has a lightweight fieldset-style hairline card; local is first and owns the only `+ Group` action.
  3. No coordinator shows more than five rooms until its reveal control is activated, while the active room remains visible.
  4. Retired, rotated-key, explicitly deleted, and explicitly left rooms are represented only by secret-free History records, collapsed by default.
  5. First-seen coordinator and room order survives reload and never changes because of messages, unread counts, connection status, or recovery state.
  6. Existing exact open/delete/leave actions, responsive containment, and accessible names remain proven by browser tests.

**Plans**: 2 plans

- [x] 22-01-PLAN.md — Add secret-free sidebar history and stable first-seen ordering persistence with unit coverage.
- [x] 22-02-PLAN.md — Replace coordinator switching with coordinator cards, reveal limits, ordered controls, and browser coverage.

**UI hint**: yes

### Phase 23: Bounded Gift-Wrap Delivery

**Goal**: ContextVM gift-wrap delivery remains bounded, cancellable, observable, and interoperable when localhost or remote relays are unavailable.
**Depends on**: Phase 20
**Requirements**: RELAY-01, RELAY-02, RELAY-03, RELAY-04, RELAY-05, RELAY-06
**Success Criteria** (what must be TRUE):

  1. An unavailable optional localhost relay creates no immortal publication and never delays a successful remote path.
  2. Primary and optional publishes stop within explicit attempt/time budgets and abort when their owner closes.
  3. Four-second room polling never overlaps a still-running sync or publication.
  4. Safe diagnostics expose relay, event, operation, attempt, elapsed time, and outcome without payload material.
  5. Persistent and ephemeral gift wraps still deliver through canonical ContextVM/Cordn paths, including recovery from a transient outage.

**Plans**: 2 plans

- [x] 23-01-PLAN.md — Add bounded, cancellable relay publication with localhost readiness gating and safe diagnostics.
- [x] 23-02-PLAN.md — Prove single-flight polling, lifecycle cancellation, bounded retries, and upstream interoperability.

**UI hint**: no

### Phase 24: Chat User Interactions

**Goal**: Participants can address, personalize, moderate, invite, and follow people directly from the encrypted conversation without leaking targeted invite presentation to unrelated viewers.
**Depends on**: Phase 19, Phase 22
**Requirements**: USER-01, MENTION-01, MENTION-02, INVMSG-01, IGNORE-01, INVUSER-01, FOLLOW-01, FOLLOW-02, HILITE-01
**Success Criteria** (what must be TRUE):

  1. Every non-self author exposes one accessible context menu whose mention, ignore, invite, follow, and highlight actions work identically in host and invitee chat surfaces.
  2. Signed kind-9 `p` tags drive mention emphasis and targeted invite visibility while legacy untagged invites remain visible to everyone.
  3. Ignored consecutive message streaks collapse per exact room into reversible summaries, and participant highlight colors survive reload without changing shared message data.
  4. In-room invite targeting lets a viewer select another active room and sends its current invite only as a presentation-targeted message for the chosen participant.
  5. The active identity loads and live-maintains only the newest valid self-authored kind-3 event, and follow publication safely preserves its prior contact-list data.

**Plans**: 5/5 plans executed

Plans:

- [x] 24-05-PLAN.md

- [x] 24-01-PLAN.md — Prove signed kind-9 recipient metadata through send/decrypt and shared viewer-aware presentation.
- [x] 24-02-PLAN.md — Add strict exact-room ignore and global highlight preference contracts with the composite-room invariant.
- [x] 24-03-PLAN.md — Own validated live kind-3 state and serialize lossless relay-accepted follow publication.
- [x] 24-04-PLAN.md — Deliver the shared participant menu, targeted room invites, disclosures, follow feedback, highlights, and UI proof.

**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 15. Identity Continuity & Membership Integrity | 3/3 | Complete    | 2026-08-02 |
| 16. Resilient Rooms & Recovery | 6/6 | Complete | 2026-08-02 |
| 17. Content-Pane Startup Motion | 2/2 | Complete | 2026-08-03 |
| 18. Unified Presence, Notifications & Controls | 3/4 | In Progress|  |
| 19. Grouped Conversations & Reactions | 1/1 | Complete | 2026-08-05 |
| 20. Delivery Contract & Regression Proof | 0/TBD | Not started | - |
| 21. First-Run Coordinator Identity & Profile | 0/TBD | Not started | - |
| 22. Coordinator-Grouped Sidebar | 2/2 | Complete | 2026-08-06 |
| 23. Bounded Gift-Wrap Delivery | 2/2 | Complete | 2026-08-06 |
| 24. Chat User Interactions | 6/6 | Complete    | 2026-08-07 |
