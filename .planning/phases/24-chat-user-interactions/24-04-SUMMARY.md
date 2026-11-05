---
phase: 24-chat-user-interactions
plan: "04"
subsystem: shared-chat-participant-ui
tags: [svelte-5, playwright, nostr, participant-actions, private-preferences]
requires:
  - phase: 24-01
    provides: "Signed recipient metadata and viewer-aware message projection"
  - phase: 24-02
    provides: "Exact-room ignores and global highlight preferences"
  - phase: 24-03
    provides: "Acceptance-aware authenticated Nostr follow service"
provides:
  - "One shared non-self participant menu for host and invitee chat"
  - "Structured composer mention recipients and canonical active-room invite dispatch"
  - "Private ignored-streak disclosures and persistent presentation highlights"
affects: [chat-rendering, host-workspace, invitee-chat, phase-24-verification]
tech-stack:
  added: []
  patterns: [shared participant callbacks, post-visibility local presentation projection, reactive local disclosure state]
key-files:
  created: []
  modified: [src/chat/message-presentation.ts, src/components/MessageGroup.svelte, src/components/HostWorkspace.svelte, src/components/ChatRoute.svelte, tests/e2e/chat-user-interactions.spec.ts]
key-decisions:
  - "MessageGroup owns the one non-self author menu while both panes retain their own composer and exact-room state."
  - "Ignored disclosure state is keyed from the post-target-filter streak identity and remains ephemeral."
patterns-established:
  - "Participant intent crosses panes only through typed callbacks carrying exact pubkeys, never display-name parsing."
  - "Private visibility changes use SvelteSet local UI state after shared projection, leaving room and wire data unchanged."
requirements-completed: [USER-01, INVUSER-01]
coverage:
  - id: D1
    description: "Non-self author menu, composer mention, active-room chooser, and focus return share one invitee/host component contract."
    requirement: USER-01
    verification:
      - kind: automated_ui
        ref: "tests/e2e/chat-user-interactions.spec.ts#participant menu opens from a non-self author"
        status: pass
    human_judgment: false
  - id: D2
    description: "Active canonical-room choices are filtered from current and retired records before targeted invite dispatch."
    requirement: INVUSER-01
    verification:
      - kind: automated_ui
        ref: "tests/e2e/chat-user-interactions.spec.ts#participant menu opens from a non-self author"
        status: pass
    human_judgment: false
  - id: D3
    description: "Private highlight persistence and exact-room ignored-streak disclosure render without raw participant identifiers."
    verification:
      - kind: automated_ui
        ref: "tests/e2e/chat-user-interactions.spec.ts#ignore collapses each participant streak locally"
        status: pass
    human_judgment: false
duration: 19min
completed: 2026-08-06
status: complete
---

# Phase 24 Plan 04: Shared Participant Interaction Surface Summary

**Shared host/invitee author actions now preserve signed mention targets, send canonical room invites, and apply private ignore/highlight presentation without leaking capabilities.**

## Performance

- **Duration:** 19 min
- **Started:** 2026-08-06T18:49:40Z
- **Completed:** 2026-08-06T19:08:00Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added one non-self author trigger and ordered participant menu in the common `MessageGroup`, with keyboard focus restoration and viewport-contained invite selection.
- Kept visible mention text editable while host and invitee composers independently preserve exact signed recipient metadata through failed sends.
- Projected exact-room ignored streaks only after recipient filtering, while persistent highlights remain purely local decoration and accepted follows use the social-store result.
- Added focused browser evidence for menu/mention/room filtering, private highlight reload, and ignored disclosure expansion.

## Task Commits

1. **Task 1: Deliver the shared non-self menu, mention composer, and targeted room chooser** — `4a36b28` (test), `c42c5a8` (feat)
2. **Task 2: Complete ignore disclosures, accepted follow feedback, highlights, and compact parity** — `9143e61` (test), `f450380` (feat), `1aa302d` (fix)

## Files Created/Modified

- `src/components/MessageGroup.svelte` — shared author action surface, chooser, feedback, and private highlight rail.
- `src/components/HostWorkspace.svelte` and `src/components/ChatRoute.svelte` — parity callbacks, structured composer recipients, canonical room invite dispatch, and local disclosures.
- `src/chat/message-presentation.ts` — post-visibility streak projection with stable disclosure keys.
- `tests/e2e/chat-user-interactions.spec.ts` — focused action and local-presentation browser evidence.

## Decisions Made

- The selectable room callback carries only composite identity/display fields; the canonical invite URL exists only at click-time in the receiving pane.
- Following stays unavailable without an authenticated contact-list identity and reports only generic retry feedback on rejection.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Lint/reactivity bug] Used SvelteSet for expanded ignored disclosure state**
- **Found during:** Task 2
- **Issue:** Native mutable `Set` instances violate the repository’s reactive Svelte collection lint rule.
- **Fix:** Replaced them with per-pane `SvelteSet` state and direct reactive mutations.
- **Files modified:** `src/components/HostWorkspace.svelte`, `src/components/ChatRoute.svelte`
- **Verification:** `pnpm lint`, type check, and focused browser suite passed.
- **Committed in:** `1aa302d`

**Total deviations:** 1 auto-fixed (Rule 1).
**Impact on plan:** Required reactive correctness only; no feature scope expanded.

## Issues Encountered

- The complete `pnpm test:e2e` run passed the visible initial 47 tests (including all four Phase 24 tests) but left a Playwright worker running without terminal output. It was stopped after 73 seconds; focused Phase 24 browser coverage ran to completion on an isolated preview port.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 24 has a single shared interaction seam and focused verification evidence for final independent review.
- Re-run the full browser suite in a clean runner before a shipping claim because the shared-runner process did not terminate.

## Self-Check: PASSED

- Verified all five key files and all Task 1/Task 2 commits exist in history.
- No new stubs, skipped tests, or sensitive output paths were introduced.

---
*Phase: 24-chat-user-interactions*
*Completed: 2026-08-06*
