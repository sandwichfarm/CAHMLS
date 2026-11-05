---
phase: 27-mobile-optimized-experience
plan: "01"
subsystem: coordinator-persistence
tags: [indexeddb, persistence, lifecycle, svelte]
requires: []
provides: [identity-scoped-indexeddb-snapshots, flush-before-stop, bounded-storage-recovery]
affects: [coordinator-runtime, host-workspace, persistence-controls]
tech-stack:
  added: []
  removed: [@sqlite.org/sqlite-wasm]
  patterns: [validated-versioned-envelope, serialized-snapshot-writer, explicit-flush-boundary]
key-files:
  created: [src/cordn/coordinator/storage/indexedDbSnapshotStorage.ts, tests/unit/indexeddb-snapshot-storage.test.ts]
  modified: [src/cordn/coordinator/storage/inMemoryStorage.ts, src/lib/transport.ts, src/coordinator/coordinator.svelte.ts, src/components/HostWorkspace.svelte, src/components/PersistencePanel.svelte]
decisions:
  - Coordinator snapshots use normalized 64-hex identity keys and never adopt unscoped legacy records.
  - Cordn storage mutations remain synchronous while immutable snapshots queue asynchronously and stop awaits flush.
  - Durable, temporary, attention, and flush-failure UI states use static, secret-free copy.
metrics:
  duration: "~20 minutes"
  completed: 2026-08-07
status: complete
---

# Phase 27 Plan 01: IndexedDB coordinator persistence Summary

Coordinator snapshots now use a validated, identity-scoped IndexedDB envelope with ordered writes and a truthful flush-before-stop lifecycle.

## Completed Tasks

1. Added a normalized-key IndexedDB snapshot owner with versioned Zod validation, typed safe failures, serialized transaction-complete writes, scoped deletion, and a synchronous Cordn memory facade.
2. Threaded the flush join through the transport and coordinator lifecycle; normal stop waits for durable persistence while a failed flush keeps the running owner alive.
3. Replaced sqlite-wasm/localStorage snapshots, surfaced durable/temporary/recovery copy, and added explicit destructive confirmations for corrupt deletion and unsaved stopping.

## Verification

- Passed: `pnpm lint`
- Passed: `pnpm exec tsc --noEmit`
- Passed: `pnpm test` — 350 passed, 3 skipped
- Passed: focused Vitest storage tests
- Passed: focused Playwright coordinator stop lifecycle test
- Passed: `pnpm build`
- Passed: `pnpm check:upstream`
- Passed: `pnpm test:upstream-interop`
- Passed: `git diff --check`
- Full `workspace-lifecycle.spec.ts` run completed with one unrelated invite-only delivery scenario failure; see `deferred-items.md`.

## Deviations from Plan

### Auto-fixed Issues

None.

## Deferred Issues

- The full lifecycle suite's invite-only delivery test timed out after the guest's room connection became offline, outside the persistence paths modified here. The focused storage lifecycle browser test remains green.
- `state.advance-plan` could not update the pre-existing stale `STATE.md` position because it lacks a parseable phase plan count; progress, metrics, decisions, session, roadmap, and requirement evidence were still updated.

## Known Stubs

None.

## Self-Check: PASSED

- IndexedDB storage module and focused tests exist.
- Task commits `0f6ee16`, `1ac9bba`, `9f9d4b4`, `00444cd`, and `334800b` exist.
