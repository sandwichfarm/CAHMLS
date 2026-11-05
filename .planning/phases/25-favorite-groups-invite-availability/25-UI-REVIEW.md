# Phase 25 — UI Review

**Audited:** 2026-08-07  
**Baseline:** `25-UI-SPEC.md`  
**Screenshots:** baseline desktop, tablet, and mobile captures exist at `.planning/ui-reviews/25-20260807-020832/`; they stop at first-run identity selection. Authenticated screenshots were not captured because the established fixture seeds state within Playwright and adding capture instrumentation would modify the test harness.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | Favorite labels and required offline reason match the contract. |
| 2. Visuals | 3/4 | Shared rows, selected state, 44px targets, and containment pass; authenticated visual comparison remains unavailable. |
| 3. Color | 3/4 | Contract color roles are correctly scoped, but 60/30/10 cannot be verified from the available capture. |
| 4. Typography | 4/4 | Phase-owned sidebar/menu/invite additions now use the declared sizes and 400/600 weights. |
| 5. Spacing | 4/4 | Phase-owned sidebar/menu/invite layout now uses the declared 4px grid; the 44px target exception is preserved. |
| 6. Experience Design | 4/4 | Both render paths prove fail-closed offline behavior and live online restoration; reduced motion is covered for star and menu interactions. |

**Overall: 22/24**

**Verdict: PASS WITH VISUAL-EVIDENCE LIMITATION.** No blocker or contract-breaking implementation issue was found. Capture an authenticated rail/invite state before release if a human visual sign-off is required.

---

## Top 3 Priority Fixes

1. **WARNING — Add authenticated visual snapshots to the established fixture.** The current manual captures only show first-run identity selection, leaving focal hierarchy, selected-star contrast, and unavailable-invite density to code and assertion evidence.
2. **WARNING — Consider distinct connecting/unknown status copy in a future contract.** The required `Coordinator is offline` text is used for every non-online state; this meets Phase 25’s literal contract but is less precise for transient states.
3. **WARNING — Add a reduced-motion assertion for the invite action.** Its CSS override is present, while the new browser assertion exercises the star and room-menu trigger.

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

- **PASS:** The first menu item uses the contract’s `Add to favorites` / `Remove from favorites` copy ([RoomActionsMenu.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/RoomActionsMenu.svelte:74)), and the selected state exposes `Favorite # {room}` / `Unfavorite # {room}` ([CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:101)).
- **WARNING:** Non-online availability maps to the locked `Coordinator is offline` tooltip and accessible text ([MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:286)). Correct, but connecting/unknown cannot explain their distinct condition.

### Pillar 2: Visuals (3/4)

- **PASS:** One `CoordinatorRoomCard` implements source and Favorites presentation, retaining active rail, unread badge, avatar, star, and menu parity ([CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:66), [CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:92)). The focused browser test proves selected-state sync, 44px row/star geometry, and 320px containment ([workspace-lifecycle.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/workspace-lifecycle.spec.ts:808)).
- **WARNING:** `needs_human_review: true` — no captured image contains an authenticated Favorites fieldset or shared invite. The existing screenshots are first-run only, so direct comparison of secondary hierarchy and real contrast is unavailable.

### Pillar 3: Color (3/4)

- **PASS:** Green is restricted to active rail/selected favorite/focus, ordinary row hover is neutral, and unavailable invites use neutral subdued colors without hover accent ([CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:145), [CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:150), [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:439)).
- **WARNING:** The approximate 60/30/10 allocation is not mechanically verifiable and authenticated visual evidence is unavailable. Recheck this balance when snapshot coverage is added.

### Pillar 4: Typography (4/4)

- **PASS:** Phase-owned sidebar/menu additions now use 8/10/12px labels/actions and 600 maximum emphasis ([CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:121), [RoomActionsMenu.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/RoomActionsMenu.svelte:128), [RoomActionsMenu.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/RoomActionsMenu.svelte:143)). Invite emphasis is now 600 and explanatory copy maintains 1.45 line-height ([MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:442)).

### Pillar 5: Spacing (4/4)

- **PASS:** Favorites uses 4/8px layout values, while `2.75rem` remains the explicitly permitted 44px row/control minimum ([CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:120), [CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:139)). Menu and invite additions now use the 4px grid ([RoomActionsMenu.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/RoomActionsMenu.svelte:126), [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:437)).

### Pillar 6: Experience Design (4/4)

- **PASS:** Availability defaults to unknown and permits Join only for an exact online coordinator; the workspace resolver is forwarded through both host and embedded invitee paths ([MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:286), [HostWorkspace.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/HostWorkspace.svelte:693), [ChatRoute.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/ChatRoute.svelte:842)).
- **PASS:** Focused Chromium tests passed for invitee and host offline→online transitions, stable invite bounds, re-enabled Join, and autojoin navigation ([workspace-lifecycle.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/workspace-lifecycle.spec.ts:874), [workspace-lifecycle.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/workspace-lifecycle.spec.ts:923)). They also emulate reduced motion and assert zero transition duration for favorite star and menu ([workspace-lifecycle.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/workspace-lifecycle.spec.ts:810)).
- **WARNING:** The invite’s reduced-motion override exists ([MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:454)) but is not asserted in the focused test; add it with future snapshot coverage.

---

## Files Audited

- `25-UI-SPEC.md`, `25-CONTEXT.md`, `25-01-PLAN.md`, `25-01-SUMMARY.md`, `25-REVIEW-FIX.md`
- `src/components/CoordinatorRoomCard.svelte`
- `src/components/RoomActionsMenu.svelte`
- `src/components/MessageGroup.svelte`
- `src/components/HostWorkspace.svelte`
- `src/components/ChatRoute.svelte`
- `tests/e2e/workspace-lifecycle.spec.ts`

Registry audit: skipped — no `components.json`; the UI-SPEC declares no third-party registry blocks.
