---
phase: 24-chat-user-interactions
plan: "03"
subsystem: nostr-social-contact-list
tags: [svelte-5, typescript, nostr, kind-3, relay, vitest]
requires:
  - phase: 24-01
    provides: "Shared authenticated Nostr social-store and participant interaction foundation"
  - phase: 15-identity-continuity-membership-integrity
    provides: "Authenticated signer lifecycle and identity replacement contract"
provides:
  - "Application-owned, generation-safe, validated kind-3 contact-list lifecycle"
  - "Serialized lossless kind-3 follow replacement after relay acceptance"
affects: [24-04-participant-menu, presence, invitations, nostr-social]
tech-stack:
  added: []
  patterns: [validated replaceable-event reducer, generation-scoped relay lifecycle, acceptance-aware serialized mutation]
key-files:
  created: []
  modified: [src/invites/nostr-social.svelte.ts, src/App.svelte, src/components/UserProfile.svelte, tests/unit/nostr-invites.test.ts]
key-decisions:
  - "Kind-3 state is owned by the earliest authenticated App lifecycle, while optional profile/presence cleanup cannot clear it."
  - "Follow refreshes and signs inside one generation-captured queue; relay acceptance, not publication attempt or echo, authorizes local success."
patterns-established:
  - "Validate kind, active author, event hash, signature, well-formed p tags, and deterministic replacement ordering before any contact state mutation."
  - "Capture the identity generation when enqueueing async mutation work so stale queued work cannot act as a replacement identity."
requirements-completed: [FOLLOW-01, FOLLOW-02]
coverage:
  - id: D1
    description: "The authenticated application lifecycle owns exactly one valid, deterministic live kind-3 contact list and ignores stale or invalid relay ingress."
    requirement: FOLLOW-01
    verification:
      - kind: unit
        ref: "tests/unit/nostr-invites.test.ts#validated kind-3 contact lists"
        status: pass
      - kind: other
        ref: "pnpm exec vitest run tests/unit/nostr-invites.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Follow serializes refresh, lossless merge, strict signing, pending echo suppression, and relay-accepted commit without stale identity mutation."
    requirement: FOLLOW-02
    verification:
      - kind: unit
        ref: "tests/unit/nostr-invites.test.ts#serialized kind-3 follows"
        status: pass
      - kind: manual_procedural
        ref: "follow critical-section review: refresh→merge→sign→validate→Promise.any→commit"
        status: pass
    human_judgment: false
duration: 10 min
completed: 2026-08-06
status: complete
---

# Phase 24 Plan 03: Validated Contact Lists and Relay-Accepted Follows Summary

**A single authenticated App lifecycle now validates live kind-3 state and publishes lossless, serialized follow replacements only after relay acceptance.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-08-06T18:35:54Z
- **Completed:** 2026-08-06T18:45:57Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Moved own contact-list ownership to the earliest authenticated application lifecycle, with one reducer for bounded query and live subscription ingress.
- Enforced kind, author, event-hash, signature, tag-shape, generation, and `(created_at desc, id asc)` replacement checks before updating following state.
- Added a generation-captured follow queue that refreshes, preserves exact content and unrelated tags, deduplicates contacts, signs strictly newer events, waits for a relay acknowledgement, and then commits locally.
- Added real-signature fake-pool coverage for query/subscription races, malformed ingress, acceptance delays, independent newer events, all-relay failure, invalid signer output, and replacement-identity queue races.

## Task Commits

1. **Task 1: Own only the newest valid active-identity kind-3 state**
   - `9c8d343` — `test(24-03): add failing kind-3 contact-list contracts`
   - `bad24cb` — `feat(24-03): validate active kind-3 contact state`
2. **Task 2: Serialize lossless follow replacements through relay acceptance**
   - `8914e3b` — `test(24-03): add failing serialized follow contracts`
   - `c81ae30` — `feat(24-03): serialize relay-accepted follows`

## Files Created/Modified

- `src/invites/nostr-social.svelte.ts` — validated contact reducer, independently owned contact lifecycle, safe status projections, and serialized follow transaction.
- `src/App.svelte` — identity-ready, idempotent contact-list start/reset ownership.
- `src/components/UserProfile.svelte` — presence teardown no longer clears contact correctness state.
- `tests/unit/nostr-invites.test.ts` — deterministic injected-pool and signer coverage for relay, ordering, and lifecycle safety.

## Decisions Made

- A kind-3 event is accepted only when its supplied ID matches its canonical event hash in addition to `verifyEvent`; signature validity alone does not authenticate a mutable ID field.
- A newer independent relay replacement remains authoritative while a pending matching publication echo is suppressed until relay acceptance.
- Follow failures expose only `Unable to follow on Nostr. Try again.` and retain prior validated state without relay or signed-event diagnostics.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Security bug] Bound kind-3 IDs to canonical event hashes**
- **Found during:** Task 1
- **Issue:** A signature-valid event object with a mutated `id` can otherwise influence the deterministic tie-breaker.
- **Fix:** Required `event.id === getEventHash(event)` before reduction and signer-output acceptance.
- **Files modified:** `src/invites/nostr-social.svelte.ts`, `tests/unit/nostr-invites.test.ts`
- **Verification:** Focused kind-3 ingress tests passed.
- **Committed in:** `bad24cb`

**2. [Rule 1 - Lifecycle bug] Preserved contact state when presence stops**
- **Found during:** Task 1
- **Issue:** Optional profile/presence teardown cleared `following`, reintroducing a rendering-dependent contact-list failure.
- **Fix:** Split presence and contact-list teardown; only contact teardown resets contact state.
- **Files modified:** `src/invites/nostr-social.svelte.ts`, `src/components/UserProfile.svelte`, `tests/unit/nostr-invites.test.ts`
- **Verification:** Focused lifecycle tests passed.
- **Committed in:** `bad24cb`

**3. [Rule 1 - Identity race] Captured generation when enqueueing follow work**
- **Found during:** Task 2
- **Issue:** A queued follow could otherwise run after an identity replacement using the new identity's signer and pool.
- **Fix:** Each queued operation carries its originating generation and rejects without mutating replacement state after a lifecycle reset.
- **Files modified:** `src/invites/nostr-social.svelte.ts`, `tests/unit/nostr-invites.test.ts`
- **Verification:** Replacement-identity queued-follow regression passed.
- **Committed in:** `c81ae30`

**Total deviations:** 3 auto-fixed (Rule 1).
**Impact on plan:** All corrections enforce the plan's relay and identity trust-boundary guarantees; no scope expansion.

## Verification

- `pnpm exec vitest run tests/unit/nostr-invites.test.ts` — passed (14 tests).
- `pnpm exec tsc --noEmit` — passed.
- `pnpm lint` — passed.
- `pnpm test` — passed (343 tests; 3 skipped).
- `pnpm build` — passed.
- `git diff --check` — passed.
- Independent safety review passed: the critical section refreshes before merging, preserves content and unrelated tags, deduplicates contacts deterministically, signs strictly newer state, validates identity/generation, suppresses only matching pending echoes, and waits for `Promise.any` before local success.

## Issues Encountered

`pnpm test:e2e` could not complete in this shared checkout: the first run hit an orphaned mock-relay listener on port 8765, and the clean retry left a Playwright worker running after partial output. The runner was stopped after confirming it was spawned by this task. This does not cover the new unit-tested kind-3 service directly; the complete phase E2E gate is deferred to the Phase 24 close-out run after Plan 24-04.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 24-04 can consume `nostrSocialStore.follow`, `followStatus`, and `followError` to present pending, accepted, and retryable follow feedback without implementing a second contact cache.

## Self-Check: PASSED

Verified all four modified production/test files exist and task commits `9c8d343`, `bad24cb`, `8914e3b`, and `c81ae30` are present in git history.

---
*Phase: 24-chat-user-interactions*
*Completed: 2026-08-06*
