# Phase 24 — UI Review

**Audited:** 2026-08-06
**Baseline:** approved `24-UI-SPEC.md`
**Screenshots:** captured at desktop (1440x900), tablet (768x1024), and mobile (375x812) in `.planning/ui-reviews/24-20260806-232520/`. The running Vite server stops at the unauthenticated identity screen, so those captures do not show Phase 24 chat controls. Current-source focused Chromium checks supplied host/guest component evidence instead.

---

## Verdict

**PASS WITH ONE VISUAL-EVIDENCE WARNING.** The Phase 24 gap closure resolves all four findings in the prior 10/24 review: author triggers are 44px, highlight and ignore state is visibly persistent, participant token values match the approved contract, and compact overlays retain 16px side gutters. No implementation blocker remains.

## Pillar Scores

| Pillar | Score | Key finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | Locked menu, chooser, mention, ignore, and feedback copy is present in both panes. |
| 2. Visuals | 3/4 | Contract geometry and selected state pass browser assertions, but live screenshots could not reach an authenticated chat. |
| 3. Color | 4/4 | Participant surfaces use the declared secondary, accent, mention, divider, and error colors. |
| 4. Typography | 4/4 | New participant controls use the declared 12/14/16/20px sizes and 400/600 weights. |
| 5. Spacing | 4/4 | 44px targets, 4/8/16px component spacing, and 16px compact gutters match the contract. |
| 6. Experience Design | 4/4 | Keyboard entry/dismissal, focus return, state feedback, touch targets, and reduced-motion behavior are implemented and tested. |

**Overall: 23/24**

---

## Top 3 Priority Follow-ups

1. **WARNING — Capture an authenticated chat visual UAT.** The three live captures show only onboarding, so an operator should open host and invitee menus at desktop and 320px widths before release; this validates visual hierarchy against real conversation density.
2. **WARNING — Exercise the invite chooser with a real successful send.** Focused UI coverage proves chooser layout and error handling, but a connected multi-room session should confirm the success presentation and focus return with live data.
3. **WARNING — Run the full browser suite before shipping.** This audit reran the Phase 24 focused checks only; retain the project-wide `pnpm test:e2e` result as final regression evidence.

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

- **PASS:** The participant menu contains the exact action order and labels, including persistent `Highlight: {color}` feedback. The chooser and its empty/pending/error copy match the contract. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:327)
- **PASS:** Both host and invitee ignored-streak disclosures now visibly switch between `Show messages` and `Hide messages` while retaining the count and `aria-expanded`. [HostWorkspace.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/HostWorkspace.svelte:1896), [ChatRoute.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/ChatRoute.svelte:818)
- **PASS:** Targeted messages render the visible, accessible `Mentioned you` label only when recipient metadata targets the active viewer. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:274)

### Pillar 2: Visuals (3/4)

- **PASS:** The shared host/invitee trigger stays at least 44x44px without shifting the author streak or bubble; selected highlights have a visible accent rail plus a text `Selected` marker. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:393), [chat-user-interactions.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/chat-user-interactions.spec.ts:401)
- **WARNING:** Captures at the three required viewport sizes are git-safe and available, but all stop before chat authentication. They cannot independently confirm local focal hierarchy, menu placement, or density in a real populated log. This is an evidence limitation, not a code-level contract failure.

### Pillar 3: Color (4/4)

- **PASS:** Menus/choosers use `#101614`; divider, accent focus/selection, mention rail, and actionable-error tokens use their specified values. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:396)
- **PASS:** The current highlight is not color-only: its action names the color and its selected palette button adds both `aria-pressed` and visible `Selected` text. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:332)

### Pillar 4: Typography (4/4)

- **PASS:** Participant actions and room rows are 14px/400; guidance and coordinator labels are 12px/400; selected markers and empty heading are 16px/600; the chooser heading is 20px/600. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:397)
- **PASS:** The focused browser test verifies 14px action rows and the 20px/600 chooser heading in both host and guest fixtures. [chat-user-interactions.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/chat-user-interactions.spec.ts:324)

### Pillar 5: Spacing (4/4)

- **PASS:** The shared author trigger and all menu/palette actions have the required 44px minimum target. Menus use the approved 4/8/16px local scale. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:393)
- **PASS:** At 320px, both menu and chooser render at 288px with exactly 16px on each side, fulfilling `calc(100vw - 32px)`. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:324), [chat-user-interactions.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/chat-user-interactions.spec.ts:344)

### Pillar 6: Experience Design (4/4)

- **PASS:** Non-self author controls are keyboard-addressable; opening moves focus to Mention, Escape restores the trigger, and outside pointer/focus interaction dismisses the active surface. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:85)
- **PASS:** Follow/invite pending and error states use disabled/busy controls plus safe status text; anonymous follow is visibly unavailable with the required guidance. [MessageGroup.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/MessageGroup.svelte:329)
- **PASS:** The 320px reduced-motion check confirms both surfaces stay inside the viewport and the invite control has a `0s` transition duration. [chat-user-interactions.spec.ts](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/chat-user-interactions.spec.ts:286)

---

## Verification Performed

- `CI=1 PLAYWRIGHT_PORT=4288 pnpm exec playwright test tests/e2e/chat-user-interactions.spec.ts --grep 'participant visual contract|participant feedback remains visible and persistent|participant surfaces keep invite controls contained' --workers=1` — **3 passed**.
- Screenshot safety gate confirmed `.planning/ui-reviews/.gitignore` already ignores all configured image formats before capture.
- Registry audit: skipped — `components.json` is absent and the approved UI specification declares no third-party registry.

## Files Audited

- `.planning/phases/24-chat-user-interactions/24-CONTEXT.md`
- `.planning/phases/24-chat-user-interactions/24-01-PLAN.md` through `24-05-PLAN.md`
- `.planning/phases/24-chat-user-interactions/24-01-SUMMARY.md` through `24-05-SUMMARY.md`
- `.planning/phases/24-chat-user-interactions/24-UI-SPEC.md`
- `.planning/phases/24-chat-user-interactions/24-REVIEW-FIX.md`
- `src/components/MessageGroup.svelte`
- `src/components/HostWorkspace.svelte`
- `src/components/ChatRoute.svelte`
- `src/lib/viewport-overlay.ts`
- `tests/e2e/chat-user-interactions.spec.ts`
