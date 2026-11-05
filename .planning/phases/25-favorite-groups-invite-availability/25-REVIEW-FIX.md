---
phase: 25
fixed_at: 2026-08-07T01:36:59Z
review_path: .planning/phases/25-favorite-groups-invite-availability/25-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 25: Code Review Fix Report

**Fixed at:** 2026-08-07T01:36:59Z  
**Source review:** `.planning/phases/25-favorite-groups-invite-availability/25-REVIEW.md`  
**Iteration:** 1

**Summary:**

- Findings in scope: 4
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: Shared-invite coordinators are never probed

**Files modified:** `src/components/HostWorkspace.svelte`, `tests/e2e/workspace-lifecycle.spec.ts`  
**Commits:** `dab7ad4`, `9b9a949`  
**Applied fix:** Parsed valid shared invites from host and embedded message collections, merged their relay hints into reachability targets, and re-probed when either collection changes. Session updates now invoke target-change probing directly, covering host message delivery even when message data is mutated in place. Added disabled-to-online and autojoin coverage for both host and embedded invitee paths.

### CR-02: Removing a favorite can lose focus and hide its required source row

**Files modified:** `src/components/HostWorkspace.svelte`, `src/components/CoordinatorRoomCard.svelte`, `tests/e2e/workspace-lifecycle.spec.ts`  
**Commit:** `4708b1e`  
**Applied fix:** Kept the original row rendered while its favorite duplicate is removed, then returned focus to that source row with a reveal-control fallback. Added a six-room collapsed-card regression case.

### WR-01: Disabled invite descriptions use duplicate IDs

**Files modified:** `src/components/MessageGroup.svelte`, `tests/e2e/workspace-lifecycle.spec.ts`  
**Commit:** `60bb956`  
**Applied fix:** Included Svelte's component-unique opaque ID in each unavailable-invite description ID and added a two-streak DOM uniqueness/resolution assertion.

### WR-02: The availability browser test does not test an online transition

**Files modified:** `tests/e2e/workspace-lifecycle.spec.ts`  
**Commits:** `dab7ad4`, `9b9a949`  
**Applied fix:** Changed the availability coverage from offline-only to disabled-to-online behavior using a valid signed heartbeat delivered through a shareable relay hint, asserting stable bounds and existing autojoin navigation in host and embedded renders.

## UI Review Gaps Closed

**Files modified:** `src/components/CoordinatorRoomCard.svelte`, `src/components/RoomActionsMenu.svelte`, `src/components/MessageGroup.svelte`, `tests/e2e/workspace-lifecycle.spec.ts`  
**Commit:** `8fda4e7`

- Replaced the Phase 25 700/620/800 typography with the approved 400/600 weights and explicit 8/10/12px sizes.
- Normalized the reviewed sidebar, menu, and shared-invite spacing to the 4px grid without changing unrelated message-streak rules.
- Added the menu reduced-motion override and asserted zero-duration favorite-star and menu-trigger transitions. The existing invite control retains its reduced-motion override.

## Verification

- Re-read every modified source/test section after each change.
- `git diff --check` passed for the complete fix range.
- `pnpm exec tsc --noEmit` passed.
- Focused Playwright coverage passed: `PLAYWRIGHT_PORT=4176 pnpm exec playwright test tests/e2e/workspace-lifecycle.spec.ts --grep 'favorite menu duplicates|favorite star mirrors|unfavoriting a collapsed source|shared invite follows exact|host messages re-probe|availability descriptions are unique' --workers=1` (6 passed).
- No full suite was run.

---

_Fixed: 2026-08-07T01:36:59Z_  
_Fixer: the agent (gsd-code-fixer)_  
_Iteration: 1_
