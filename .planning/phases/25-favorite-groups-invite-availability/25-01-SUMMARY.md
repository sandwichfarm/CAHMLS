---
phase: 25-favorite-groups-invite-availability
plan: "01"
subsystem: sidebar-and-chat-ui
tags: [svelte-5, local-storage, accessibility, playwright, vitest]
requires:
  - phase: 22-coordinator-grouped-sidebar
    provides: "Stable coordinator-card sidebar and exact composite room navigation"
  - phase: 24-chat-user-interactions
    provides: "Shared host/invitee MessageGroup rendering seam"
provides:
  - "Validated persistent exact-room favorites duplicated above coordinator cards"
  - "Shared 44px row-star and menu favorite controls with focus-safe removal"
  - "Fail-closed shared room-invite availability based on exact coordinator reachability"
affects: [sidebar-navigation, shared-chat-rendering, invitee-chat]
tech-stack:
  added: []
  patterns: [validated composite local preference keys, shared row presentation variants, workspace-owned availability resolver]
key-files:
  created: []
  modified: [src/chat/sidebar-ledger.ts, src/components/CoordinatorRoomCard.svelte, src/components/RoomActionsMenu.svelte, src/components/HostWorkspace.svelte, src/components/MessageGroup.svelte, src/components/ChatRoute.svelte, tests/unit/sidebar-ledger.test.ts, tests/e2e/workspace-lifecycle.spec.ts]
key-decisions:
  - "Favorites store only validated coordinator-plus-room keys and are reconciled only against active rooms."
  - "The same CoordinatorRoomCard renders source and Favorites rows so navigation and actions cannot diverge."
  - "Shared invite actionability defaults to unknown and is enabled only by an exact online reachability result."
patterns-established:
  - "Availability presentation is supplied by a workspace resolver rather than inferred from invite content or room state."
requirements-completed: [FAV-01, FAV-02, INVMSG-02]
coverage:
  - id: D1
    description: "Exact composite favorites persist, duplicate above coordinator cards, and remove without removing their source rows."
    requirement: FAV-01
    verification:
      - kind: automated_ui
        ref: "tests/e2e/workspace-lifecycle.spec.ts#favorite menu duplicates the exact room and survives reload"
        status: pass
      - kind: unit
        ref: "tests/unit/sidebar-ledger.test.ts#normalizes valid composite favorites independently and retires stale keys"
        status: pass
    human_judgment: false
  - id: D2
    description: "Favorite stars expose synchronized selected state and 44px controls without compact sidebar overflow."
    requirement: FAV-02
    verification:
      - kind: automated_ui
        ref: "tests/e2e/workspace-lifecycle.spec.ts#favorite star mirrors duplicate state and keeps sidebar controls touch-safe"
        status: pass
    human_judgment: false
  - id: D3
    description: "Invitee shared invites fail closed with the required offline explanation and not-allowed cursor when exact coordinator availability is unknown."
    requirement: INVMSG-02
    verification:
      - kind: automated_ui
        ref: "tests/e2e/workspace-lifecycle.spec.ts#shared invite follows exact coordinator availability"
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-08-07
status: complete
---

# Phase 25 Plan 01: Favorite Groups & Invite Availability Summary

**Persistent exact-room favorites now duplicate shared sidebar rows, while shared room invites fail closed unless their precise coordinator is online.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-08-07T00:51:36Z
- **Completed:** 2026-08-07T01:00:12Z
- **Tasks:** 3/3
- **Files modified:** 8

## Accomplishments

- Added validated, deduplicated composite favorite storage that preserves unrelated sidebar data and removes stale favorite keys during reconciliation.
- Reused one room-row implementation for Favorites and source cards, with synchronized menu/star controls, 44px targets, persisted state, and safe focus return.
- Passed one workspace-owned exact reachability resolver through host and invitee message renderers; unknown, connecting, and offline states disable room-invite actions with accessible offline copy.

## Task Commits

1. **Task 1: Prove one persisted menu favorite through the duplicated sidebar** — `058d707` (test), `34354da` (feat)
2. **Task 2: Complete 44px row-star parity and favorite-state recovery** — `fcf1148` (test), `99e69a2` (feat)
3. **Task 3: Gate shared invite messages on exact coordinator reachability** — `d4a8890` (feat)

## Files Created/Modified

- `src/chat/sidebar-ledger.ts` — strict favorite parsing, exact-key mutation, and active-room reconciliation.
- `src/components/CoordinatorRoomCard.svelte` and `RoomActionsMenu.svelte` — shared favorites presentation and toggle parity.
- `src/components/HostWorkspace.svelte` and `ChatRoute.svelte` — workspace-owned favorite persistence and availability forwarding.
- `src/components/MessageGroup.svelte` — fail-closed invite action and accessible offline state.
- `tests/unit/sidebar-ledger.test.ts` and `tests/e2e/workspace-lifecycle.spec.ts` — recovery, geometry, persistence, and availability evidence.

## Decisions Made

- Persist only exact validated composite identities; titles, URLs, message content, and capabilities never enter the sidebar ledger.
- Keep the Favorites section a secondary fieldset above coordinator cards; source rows remain authoritative and unchanged.
- Default absent availability projections to `unknown` so they cannot make Join actionable.

## Verification

- `pnpm exec vitest run tests/unit/sidebar-ledger.test.ts` — passed (5 tests).
- Focused favorite Playwright scenarios — passed (2 tests).
- `shared invite follows exact coordinator availability` Playwright scenario — passed.
- `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`, and `git diff --check` — passed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test selector] Avoided CSS matching on an embedded NUL composite key.**
- **Found during:** Task 1
- **Issue:** CSS attribute selectors cannot safely express the existing composite identity delimiter.
- **Fix:** Compared `data-room-key` values in a browser evaluation while retaining exact-key proof.
- **Files modified:** `tests/e2e/workspace-lifecycle.spec.ts`
- **Verification:** Focused favorite scenario passed.

**2. [Rule 1 - Build compatibility] Replaced an optional function parameter syntax that the current Vite parser emitted incorrectly.**
- **Found during:** Task 1
- **Issue:** The production build parsed the optional callback parameter as plain JavaScript.
- **Fix:** Used an explicit `HTMLButtonElement | undefined` default parameter.
- **Files modified:** `src/components/HostWorkspace.svelte`
- **Verification:** `pnpm build` passed.

**Total deviations:** 2 auto-fixed Rule 1 issues. No scope expansion.

## Known Stubs

None.

## Issues Encountered

- `state.advance-plan` could not parse the pre-existing Phase 18 plan position in `STATE.md`; metrics, requirements, decisions, roadmap progress, and session metadata were still updated through the SDK.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Favorites and invite availability are covered by focused unit/browser checks and do not alter membership authorization or wire protocols.

## Self-Check: PASSED

- Verified all eight listed implementation/test files and task commits `058d707`, `34354da`, `fcf1148`, `99e69a2`, and `d4a8890` exist.

---
*Phase: 25-favorite-groups-invite-availability*
*Completed: 2026-08-07*
