---
phase: 24-chat-user-interactions
plan: "01"
subsystem: chat-protocol-ui
tags: [svelte, typescript, nostr, mls, mentions, invites]
requires:
  - phase: 19-grouped-conversations-reactions
    provides: Shared MessageGroup renderer and streak presentation
  - phase: 22-coordinator-grouped-sidebar
    provides: Exact room identity and host/guest workspace surfaces
provides:
  - Signed canonical kind-9 recipient metadata and queued send options
  - Viewer-exact mention treatment and visibility-first invite projections
affects: [24-02, 24-04, chat-composer, participant-actions]
tech-stack:
  added: []
  patterns: [canonical recipient normalization, visibility-first message projection]
key-files:
  created: [tests/e2e/chat-user-interactions.spec.ts]
  modified: [src/chat/protocol.ts, src/chat/room-store.ts, src/chat/message-presentation.ts, src/components/MessageGroup.svelte, src/components/HostWorkspace.svelte, src/components/ChatRoute.svelte, tests/unit/chat-protocol.test.ts, tests/unit/message-presentation.test.ts, tests/unit/room-session-concurrency.test.ts]
key-decisions:
  - "Recipient pubkeys are lowercased, deduplicated 64-hex arrays signed into both kind-9 tags and compact authentication."
  - "Only valid targeted invites are filtered, after dedupe and before streak construction; ordinary tagged messages remain visible."
patterns-established:
  - "Use projectMessageStreaks(messages, viewerPubkey) before every keyed chat streak loop."
  - "Carry recipient intent through ChatRoomSession.send options, never by parsing display text."
requirements-completed: [MENTION-01, MENTION-02, INVMSG-01]
coverage:
  - id: D1
    description: Signed canonical recipient metadata survives MLS encryption, queued pending persistence, and mutation checks.
    requirement: MENTION-01
    verification:
      - kind: unit
        ref: tests/unit/chat-protocol.test.ts#Scenario: signed recipient metadata is canonical, authenticated, and survives MLS
        status: pass
      - kind: unit
        ref: tests/unit/room-session-concurrency.test.ts#carries normalized recipients through the queued pending send
        status: pass
    human_judgment: false
  - id: D2
    description: Exact recipient metadata renders the accessible Mentioned you marker in the shared message presentation.
    requirement: MENTION-02
    verification:
      - kind: automated_ui
        ref: tests/e2e/chat-user-interactions.spec.ts#signed recipient tracer renders Mentioned you in the shared invitee presentation
        status: pass
    human_judgment: false
  - id: D3
    description: Valid targeted invites disappear for non-target viewers before layout while public and ordinary tagged messages remain visible.
    requirement: INVMSG-01
    verification:
      - kind: unit
        ref: tests/unit/message-presentation.test.ts#removes only valid targeted invites before grouping and preserves adjacency
        status: pass
      - kind: automated_ui
        ref: tests/e2e/chat-user-interactions.spec.ts#targeted invite projection removes non-target layout artifacts before grouping
        status: pass
    human_judgment: false
duration: 18 min
completed: 2026-08-06
status: complete
---

# Phase 24 Plan 01: Signed Recipient Metadata and Invite Visibility Summary

**Signed canonical kind-9 recipients now drive exact viewer mention emphasis and pre-layout targeted-invite visibility across the shared chat renderer.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-08-06T18:06:00Z
- **Completed:** 2026-08-06T18:23:31Z
- **Tasks:** 2/2
- **Files modified:** 9

## Accomplishments

- Added canonical recipient normalization, kind-9 `p` tags, compact-proof coverage, and legacy-safe decoding.
- Extended queued chat sends so canonical recipients survive signing, MLS encryption, pending persistence, and sync.
- Added exact-viewer mention treatment and visibility-first targeted-invite filtering before host or guest streak layout.
- Added focused unit and Playwright evidence for recipient integrity, mention presentation, and zero-artifact invite suppression.

## Task Commits

1. **Task 1: Carry one signed recipient through send, decrypt, and both shared presentations** — `f8687d9` (test), `ccac5d0` (feat)
2. **Task 2: Remove non-target invite messages before streak layout** — `7d2c3d3` (feat)

## Files Created/Modified

- `src/chat/protocol.ts` — authenticated recipient normalization and kind-9 conversion.
- `src/chat/room-store.ts` — recipient-aware queued send API and legacy-safe storage normalization.
- `src/chat/message-presentation.ts` — dedupe → visibility → grouping projection.
- `src/components/MessageGroup.svelte` — accessible Mentioned you treatment with a semantic rail.
- `src/components/HostWorkspace.svelte` and `src/components/ChatRoute.svelte` — viewer-aware projection before keyed rendering.
- `tests/e2e/chat-user-interactions.spec.ts` — focused Wave 0 mention and targeted-invite browser checks.

## Decisions Made

- Recipient identity is structured and signed; editable mention text is not used to infer a target.
- Reaction envelopes cannot carry ordinary recipient metadata and preserve their existing `p`/`e` target semantics.
- Targeted invite filtering is explicitly presentation-only and happens before group layout.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical coverage] Added queued-pending recipient regression coverage**
- **Found during:** Task 1
- **Issue:** Protocol round-trip coverage did not independently prove the session's pending message retained canonical recipient metadata.
- **Fix:** Added the focused queued-send concurrency regression test.
- **Files modified:** `tests/unit/room-session-concurrency.test.ts`
- **Verification:** Focused unit suite passed.
- **Committed in:** `ccac5d0`

**Total deviations:** 1 auto-fixed (Rule 2).
**Impact on plan:** Required correctness evidence only; no scope expansion.

## Issues Encountered

The complete repository E2E invocation was still draining an unrelated long-lived existing worker when plan-scoped verification finished. Focused Phase 24 browser coverage, full unit coverage, lint, build, upstream parity, and upstream interoperability checks passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 24-02 and 24-04 can reuse `ChatMessageSendOptions`, `projectMessageStreaks`, and the single shared `MessageGroup` path for composer targeting and participant interactions.

## Self-Check: PASSED

Verified all key files exist and task commits `f8687d9`, `ccac5d0`, and `7d2c3d3` are present in git history.
