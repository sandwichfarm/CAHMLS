---
phase: 27-mobile-optimized-experience
plan: "03"
subsystem: mobile-ui
tags: [svelte, visualviewport, responsive, touch, playwright]
requires:
  - phase: 27-mobile-optimized-experience
    provides: room-browser and mobile-sheet lifecycle from Plan 02
provides:
  - Ref-counted VisualViewport owner that exposes a finite app height CSS variable
  - Touch-operated offline chat disclosure with preserved desktop pointer and keyboard behavior
  - 44px mobile targets and bounded participant/reaction/action sheets
affects: [mobile-navigation, chat-composer, room-actions, reaction-picker]
tech-stack:
  added: []
  patterns: [ref-counted visual viewport listener, shared fixed overlay sheet, coarse-pointer touch geometry]
key-files:
  created:
    - src/components/app-visual-viewport.ts
  modified:
    - src/lib/viewport-overlay.ts
    - src/components/HostWorkspace.svelte
    - src/components/ChatRoute.svelte
    - src/components/CoordinatorRoomCard.svelte
    - src/components/RoomActionsMenu.svelte
    - src/components/MessageReactions.svelte
    - src/components/MessageGroup.svelte
    - tests/unit/viewport-overlay.test.ts
    - tests/e2e/workspace-lifecycle.spec.ts
decisions:
  - Use one ref-counted document-root VisualViewport CSS variable instead of per-component listeners.
  - Keep existing room and reaction callbacks unchanged while moving compact presentations into the shared overlay primitive.
metrics:
  duration: 59m
  completed: 2026-08-07
status: complete
---

# Phase 27 Plan 03: Mobile Touch and Visual Viewport Summary

Mobile chat surfaces now follow the usable visual viewport, retain safe-area room for composers, and keep disclosures and action sheets operable by touch without changing room or reaction behavior.

## Tasks Completed

| Task | Description | Commits |
| --- | --- | --- |
| 1 | Add app-level visual viewport ownership and compose-shell regression coverage | aa334a0, 281b759 |
| 2 | Make offline disclosures and compact actions touch-safe | 764a529, 9380494 |

## Implementation Highlights

- Added a ref-counted `mountAppVisualViewport` owner that writes `--app-visual-viewport-height` once per animation frame, falls back to `100dvh`, and cleans up the listener after the final owner unmounts.
- Applied that finite height to host, guest, browser, and mobile sheet roots; protected composer bottoms with the safe-area inset.
- Made offline room disclosure an explicit button with `aria-expanded`, while retaining pointer/focus discovery and the existing five-room expansion behavior.
- Standardized compact action, favorite, emoji, reaction, and sheet controls to 44px touch-safe geometry; participant, reaction, and room-action menus use the shared overlay sheet below 900px.

## Verification

- `pnpm lint` — passed.
- `pnpm exec tsc --noEmit` — passed.
- `pnpm test` — passed: 356 passed, 3 skipped.
- `pnpm exec vitest run tests/unit/viewport-overlay.test.ts` — passed: 9 passed.
- Focused visual viewport, touch-sheet, offline-disclosure, dialog-boundary, and reaction browser coverage — passed.
- `CI=1 PLAYWRIGHT_PORT=4293 pnpm exec playwright test tests/e2e/workspace-lifecycle.spec.ts --workers=1` — Plan 27-03 coverage passed. The full run completed 75/76; an unrelated persistent-host navigation workflow intermittently missed its composer. Its isolated retry passed (1/1), indicating a pre-existing timing flake rather than a mobile interaction regression.
- `pnpm build` and `git diff --check` — passed. Build emitted existing dependency pure-annotation and chunk-size warnings only.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Bug] Removed an unused Playwright locator**
   - **Found during:** Task 2 verification
   - **Issue:** Lint rejected an unused local test locator.
   - **Fix:** Removed the unused locator while preserving the viewport assertion.
   - **Files modified:** `tests/e2e/workspace-lifecycle.spec.ts`
   - **Commit:** 7129921

2. **[Rule 1 - Bug] Accounted for restored mobile browser state after a child sheet closes**
   - **Found during:** Task 2 browser verification
   - **Issue:** The dialog-boundary test assumed the parent drawer remained open after a child profile sheet closed, contrary to the established restore behavior.
   - **Fix:** Reopened the restored drawer through its exact expanded control before continuing containment checks.
   - **Files modified:** `tests/e2e/workspace-lifecycle.spec.ts`
   - **Commit:** 7e40ecb

3. **[Rule 1 - Bug] Stabilized offline disclosure transition checks**
   - **Found during:** Task 2 full-browser verification
   - **Issue:** The test could inspect the disclosure after the 150ms exit animation had already removed it.
   - **Fix:** Treat either the protected exit frame or normal post-animation removal as the valid completed transition.
   - **Files modified:** `tests/e2e/workspace-lifecycle.spec.ts`
   - **Commits:** f8a0a91, 3c4f9e1

## Known Stubs

None. The scan found only existing loading and input placeholder markup; no empty or mock data paths were introduced.

## Threat Surface Scan

No new network endpoints, authentication paths, file access patterns, or trust-boundary schema changes were introduced.

## Self-Check: PASSED

- All created and modified implementation/test files exist.
- Task commits `aa334a0`, `281b759`, `764a529`, `9380494`, `7129921`, `7e40ecb`, `f8a0a91`, and `3c4f9e1` exist in git history.
