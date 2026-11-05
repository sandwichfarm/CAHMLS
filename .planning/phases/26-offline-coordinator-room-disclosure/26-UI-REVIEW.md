# Phase 26 — UI Review

**Audited:** 2026-08-07
**Baseline:** approved `26-UI-SPEC.md`
**Screenshots:** captured previously; final browser evidence is the reported full Playwright run: **120/120 passed**, including 320px and reduced-motion coverage.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | Exact total-count singular/plural summary and instruction copy are implemented and exercised. |
| 2. Visuals | 4/4 | The revealed summary is visually removed while the unchanged room rows become the clear focal content. |
| 3. Color | 4/4 | The approved neutral offline palette is used; green remains reserved for focus and active/favourite states. |
| 4. Typography | 4/4 | Disclosure uses 10px semibold summary text, 12px rows, and the create affordance now uses regular 400. |
| 5. Spacing | 4/4 | Compact summary and rows retain the 4px/8px scale, 44px targets, and 320px containment evidence. |
| 6. Experience Design | 4/4 | The lifecycle preserves focus through reachability changes without adding a persistent non-eligible tab stop. |

**Overall: 24/24**

**Verdict: PASS — no blocking or warning findings.** Full browser evidence is green, including the targeted reachability-transition lifecycle test, 320px, and reduced-motion coverage.

---

## Top 3 Priority Fixes

1. **No corrective UI work required** — retain the focused-card continuity exception: removing it causes actual focus loss during reachability changes.
2. **Keep the reachability-transition lifecycle test** — it protects the required focus-retention and onward-Tab behavior.
3. **Keep the 320px and reduced-motion assertions in the full suite** — they provide the responsive and motion evidence for the approved contract.

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

PASS — [CoordinatorRoomCard.svelte](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:64) derives the exact `1 chat offline` / `{N} chats offline` string from the complete `rooms` collection. [Line 65](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:65) uses grammatical singular/plural keyboard instructions, and the browser tracer checks both compact copy and focus disclosure at [workspace-lifecycle.spec.ts:792](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/workspace-lifecycle.spec.ts:792).

### Pillar 2: Visuals (4/4)

PASS — the compact summary meets the neutral 44px presentation at [CoordinatorRoomCard.svelte:236](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:236). On reveal, [line 238](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:238) removes it from visual layout while retaining its accessible text, so the real room rows become the focal content. Entry and exit use only the approved opacity/`translateY(-4px)` keyframes ([lines 239-240 and 269-270](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:239)); 120/120 browser coverage includes the motion and 320px cases.

### Pillar 3: Color (4/4)

PASS — supporting text `#718277`, count `#9aac9f`, offline dot `#59675f`, and focus `#7cf59d` match the approved palette ([CoordinatorRoomCard.svelte:227](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:227), [236-241](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:236)). No disclosure-specific warning or destructive color was introduced.

### Pillar 4: Typography (4/4)

PASS — the disclosure summary is 10px semibold and room text remains 12px ([CoordinatorRoomCard.svelte:236](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:236), [247](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:247)). The earlier medium-weight exception is resolved: the create affordance is now `font-weight: 400` ([line 230](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:230)).

### Pillar 5: Spacing (4/4)

PASS — the summary uses 4px/8px padding and a 44px (`2.75rem`) minimum height ([CoordinatorRoomCard.svelte:236](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:236)); list gaps remain 4px ([line 235](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:235)) and room/action targets retain 44px minima ([lines 247-248](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:247)). The final Playwright run includes 320px containment.

### Pillar 6: Experience Design (4/4)

PASS — exact eligibility is correctly limited to remote coordinator/offline/non-empty cards ([CoordinatorRoomCard.svelte:62](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:62)); pointer and focus ownership is card-wide ([lines 137-154](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:137)); compact controls are not mounted ([line 183](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:183)); exiting controls are inert, hidden from assistive tech, and pointer-inert ([lines 184-190](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:184)); and reduced motion removes the animation ([lines 271-274](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:271)). The full 120/120 Playwright result covers the focused suite, including 320px and reduced-motion scenarios.

The `offlineDisclosure || focusInside` condition on the fieldset attributes ([lines 134-135](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:134)) is a necessary keyboard-continuity exception: it applies only to the card that already owns focus during a reachability update. It prevents focus loss during the required online/offline transition; once focus exits, `onfocusout` clears `focusInside` ([lines 151-154](/Users/sandwich/Develop/cordn-adhoc-cvm/src/components/CoordinatorRoomCard.svelte:151)), so it does not create a persistent new tab stop for online, connecting, or unknown cards. The targeted lifecycle test is green and confirms retained focus plus onward Tab navigation ([workspace-lifecycle.spec.ts:816](/Users/sandwich/Develop/cordn-adhoc-cvm/tests/e2e/workspace-lifecycle.spec.ts:816)).

---

## Files Audited

- `src/components/CoordinatorRoomCard.svelte`
- `tests/e2e/workspace-lifecycle.spec.ts`
- `.planning/phases/26-offline-coordinator-room-disclosure/26-UI-SPEC.md`
- `.planning/phases/26-offline-coordinator-room-disclosure/26-CONTEXT.md`
- `.planning/phases/26-offline-coordinator-room-disclosure/26-01-PLAN.md`
- `.planning/phases/26-offline-coordinator-room-disclosure/26-01-SUMMARY.md`

Registry audit: skipped — `components.json` is absent and the approved UI-SPEC declares no third-party registry blocks.
