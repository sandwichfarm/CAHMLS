---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Quality of Life & Polish
current_phase: 18
current_phase_name: Unified Presence, Notifications & Controls
status: "Phase 18 shipped — PR #8"
stopped_at: Completed 18-02-PLAN.md
last_updated: "2026-08-06T15:03:51.570Z"
last_activity: 2026-08-06
progress:
  total_phases: 8
  completed_phases: 7
  total_plans: 25
  completed_plans: 24
last_activity_desc: Phase 18 execution started
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-02)

**Core value:** A single browser tab acts as a fully functional, self-sovereign Cordn coordinator reachable over Nostr relays — no backend, no account, no installation.
**Current focus:** Phase 18 — Unified Presence, Notifications & Controls

## Current Position

Phase: 18 (Unified Presence, Notifications & Controls) — EXECUTING
Plan: 3 of 3
Status: Phase 18 shipped — PR #8
Last activity: 2026-08-06
Pull request: [#7 — maximize room QR codes](https://github.com/sandwichfarm/CAHMLS/pull/7) — open, CI in progress. [#6](https://github.com/sandwichfarm/CAHMLS/pull/6) merged 2026-08-06.
README refresh: [#16 — rewrite README for CAHMLS](https://github.com/sandwichfarm/CAHMLS/pull/16) — merged, outside phase scope.
SDK extraction: Phase 24 — [#17 — extract coordinator and client into @cahmls/sdk](https://github.com/sandwichfarm/CAHMLS/pull/17) — opened 2026-11-05. Deferred: [#18](https://github.com/sandwichfarm/CAHMLS/issues/18).
JSR publication: Phase 25 — preparing a CI workflow to publish `@sandwich/cahmls` after successful default-branch CI. Work is isolated on `ci/publish-sdk-jsr`; existing checkout changes are preserved.

Progress: [██████████░░░░░░░░░░] 3/6 phases ([█████████░] 93%)

## Performance Metrics

**Velocity:**

- Total plans completed: 11
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 15 | 3 | - | - |
| 16 | 6 | 2h+ | - |

**Recent Trend:** No data yet

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 15 P01 | 53m 39s | 2 tasks | 8 files |
| Phase 15-identity-continuity-membership-integrity P02 | 10min | 2 tasks | 7 files |
| Phase 15 P03 | 11min | 3 tasks | 9 files |
| Phase 16-resilient-rooms-recovery P02 | 36min | 2 tasks | 7 files |
| Phase 16 P03 | 16min | 3 tasks | 8 files |
| Phase 17-full-viewport-startup-motion P01 | 54m 21s | 2 tasks | 5 files |
| Phase 17-full-viewport-startup-motion P02 | 12min | 2 tasks | 4 files |
| Phase 18 P01 | 7min | 2 tasks | 5 files |
| Phase 18 P02 | 10min | 2 tasks | 5 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Phase 15] Persist only a version and validated 32-byte secret hex; malformed present records require explicit recovery.
- [Phase 15] Retain the anonymous signer independently of NIP-07/NIP-46 and zeroize it on retirement.
- [Phase 15] Require the active signer for all new room authority; room-local secrets are legacy-only migration material.
- [Phase 15] Treat `(coordinatorPubkey, roomId)` as the sole room identity and journal exact storage before retirement commit.
- [Phase 15] Use the versioned non-secret recovery marker as the irreversible boundary before signer replacement is published.
- [Phase 16]: Unread state is keyed by coordinator pubkey plus room ID and established at the initial sync baseline.
- [Phase 16]: Unread announcement history remains non-reactive bookkeeping to prevent Svelte update loops.
- [Phase 16]: Coordinator transport readiness is not running readiness; exact hosted-room recovery completes the startup transaction.
- [Phase 16]: Recovery uses three injected 4-second attempts with injected 250ms and 750ms backoff, preserving no raw error details.
- [Phase 16]: Local chat renders only after a completed recovery state and an attached connected exact session.
- [Phase 16]: An exhausted room can be deleted only through its exact contextual confirmation, after which startup resumes on the existing transport.
- [Phase 16]: Multi-room recovery preserves the remembered exact room as the active channel after every room is restored.
- [Phase ?]: Startup is pane-scoped to host-chat; global header and rail remain usable.
- [Phase ?]: Signal animation consumes a typed read-only projection of coordinator startup progress.
- [Phase ?]: Startup motion owns only the positioned host-chat pane; header and rail remain usable.
- [Phase ?]: One scoped GSAP context and media owner consumes immutable recovery projections and reverts on teardown.
- [Phase ?]: Wide-pane content coverage requires a 512x256 deterministic ASCII texture plus rendered extent assertions.
- [Phase ?]: [Phase 18] Feed-first notification recording is canonical; browser delivery remains an optional cadence-gated projection.
- [Phase ?]: [Phase 18] Invitation resolution persists only ID/timestamp for seven days and remains independent from read state.
- [Phase ?]: Separate the in-app notification feed from desktop permission controls; opening settings stays passive.
- [Phase ?]: Require a live trusted invitation capability at accept time; persisted feed history remains non-redeemable.

### Pending Todos

None yet.

### Blockers/Concerns

- Production nsite publication requires repository secrets. The deploy workflow currently succeeds as a guarded skip.
- Authoritative active user count is not yet derived from real Cordn group membership.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260802-jj8 | Give every participant emoji shortcuts and authenticated persistent message reactions | 2026-08-02 | uncommitted | [260802-jj8](./quick/260802-jj8-give-every-participant-emoji-shortcuts-a/) |
| 260802-i5b | Unify root and chat routes into one root workspace with exact room actions and truthful coordinator reachability | 2026-08-02 | uncommitted | [260802-i5b](./quick/260802-i5b-unify-root-and-chat-routes-into-one-root/) |
| 260802-f3u | Add in-session invite redemption by paste or camera scan without disrupting the local coordinator | 2026-08-02 | uncommitted | [260802-f3u](./quick/260802-f3u-add-in-session-invite-redemption-by-past/) |
| 2 | Add a camel emoji to the left of CAHMLS | 2026-08-02 | uncommitted | — |
| 3 | Set the site title to CAHMLS | 2026-08-02 | ae42349 | — |
| 6 | Give chat bubbles a 50% pane minimum and preserve directional negative space | 2026-08-05 | uncommitted | — |
| 7 | Reduce chat bubble border noise and compact message spacing | 2026-08-06 | uncommitted | — |
| 8 | Show relative message timestamps until seven days old | 2026-08-06 | 08cb3aa | — |
| 9 | Add required Git remote synchronization, commit, issue, push, and pull-request procedures | 2026-08-06 | 7ff1d08 | — |
| 10 | Show reaction add control on message hover and separate it from reaction chips | 2026-08-06 | 37f65d0 | — |
| 11 | Add viewport-maximized QR mode to the room invite dialog | 2026-08-06 | 7a7ee4e | — |

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-08-03T06:19:49.123Z
Stopped at: Completed 18-02-PLAN.md
Resume file: None
