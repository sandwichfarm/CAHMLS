---
phase: 24-sdk-extraction
status: passed
verified: 2026-11-05
requirements: [SDK-01, SDK-02, SDK-03, SDK-04, SDK-05, SDK-06, SDK-07]
commit: 05638a6
score: 7/7 requirements verified
re_verification:
  previous_status: gaps_found
  previous_commit: 249eb67
  previous_score: 5/7
  gaps_closed:
    - "SDK-04: every coverage exclusion is honest"
    - "SDK-06: pnpm build has a result"
  gaps_remaining: []
  regressions: []
---

# Phase 24 Verification

**Verdict: PASSED, with the limits below**

The extraction achieves its structure: `@cahmls/sdk` is framework-free, imports nothing from the application, loads through its `exports` map, and is documented for every public export. `CoordinatorStore` only mirrors `CoordinatorRuntime`. The two gaps from the first pass are closed. Three limits remain: the relay retry fix has no real-network check, SDK-07 rests on a sample, and CI on the final commit had not finished when read.

| Requirement | Verdict | Evidence |
|---|---|---|
| SDK-01 | PASS | No UI framework imports or rune usage in `packages/sdk/src`. The only `../../` imports stay inside the package. Thirty modules moved, and no copies remain under `src/` by file name or in git. |
| SDK-02 | PASS | `pnpm sdk:verify-package` loaded 10 entry points and checked 162 packed files, on Node 26.11.1. On Node 22, the `Verify SDK package` step of CI run 42006177810 succeeded on 249eb67. An import walk of `dist` shows SQLite only under root, `runtime`, `server`, and `storage/browser`, matching the phase decision and the docs. |
| SDK-03 | PASS | `runtime/coordinator-runtime.ts` (1,036 lines) has `subscribe` and `getSnapshot`, exercised by `coordinator-runtime.test.ts`. `coordinator.svelte.ts` fell from 884 to 134 lines and holds mirroring, delegation, and application injection only. |
| SDK-04 | PASS | Thresholds are 100% on all four metrics and CI runs `pnpm sdk:coverage`, which passes at 05638a6 (3,614 statements, 2,087 branches, 807 functions, 3,281 lines). The four remaining exclusions are honest. |
| SDK-05 | PASS | After `pnpm docs:build`, all 307 exports across the nine subpath entry points have their own page in `docs/reference`. The root entry has no module of its own. Its 224 exports are the union of those modules plus the `contracts` and `mls` namespaces. All 35 named imports in the guides, API overview, and SDK README resolve to real exports. CI runs the build. |
| SDK-06 | PASS | `pnpm build`, lint, type-check, and unit checks pass at 05638a6. The browser and upstream results are from 249eb67, and no runtime code changed since. See the gap closure below. |
| SDK-07 | PASS, sampled | All nine fix commits were sampled. See the limits below. |

## Gap closure

Re-verified at 05638a6, for the recorded gaps only.

- **SDK-04.** The false `v8 ignore` in `client/protocol.ts` is gone, and the branch is now counted. A coverage run of the new test alone (`rejects a message from an earlier epoch whose sender has since left`) takes the branch. A run of every other test does not, so that test is what covers it. `pnpm sdk:coverage` exits 0 at 100% with 1529 passed and 3 skipped.
- **SDK-06.** `pnpm build` exits 0 at 05638a6, and CI run 42006177810 succeeded on 249eb67, including its `Build` and `Playwright` steps. The build prints a chunk size warning and an ignored annotation warning from a dependency, and neither fails it.
- **Changes since 249eb67.** `git diff 249eb67..HEAD --stat` lists five files: `24-01-SUMMARY.md`, `24-VERIFICATION.md`, `README.md`, `client/protocol.ts`, and `tests/protocol.test.ts`. The `protocol.ts` change replaces one comment and no code. The browser and upstream results therefore carry over from 249eb67, but they were not repeated on 05638a6.
- **Notes from the first pass.** `README.md` no longer names `src/cordn/`, no empty directories remain under `src/`, and `24-01-SUMMARY.md` exists and is tracked.

## Coverage exclusions

Four `v8 ignore` comments remain in `packages/sdk/src`, and `vitest.config.ts` has no `coverage.exclude`. Each claim was read again against the code it relies on.

- `client/invite.ts:143`: honest. The pinned `nostr-tools` 2.23.5 always sets `relays` for an `nprofile`.
- `client/room-store.ts:1626`: honest. Both callers reach it only without a current record of the same identity.
- `coordinator/storage/browserSqliteStorage.ts:48`: honest. The class is built only without `localStorage`, where the clearing function has already returned, and no other path in the file calls `clear`.
- `server/base64.ts:36`: honest. `decodeBase64` rejects every empty result first.

## SDK-07 sample and limits

`packages/sdk/tests/` does cover the sample. 34 defects named in the nine fix commits (`10eacab`, `117c986`, `6220d6b`, `22daaa2`, `7da3f1d`, `5377577`, `7817f9c`, `226c4e0`, `249eb67`) were matched to a test by title, and those tests passed in the full run. The bodies of seven were read.

- This is a sample, not every defect. Items not traced to a named test include subscriber shutdown on coordinator close, reaction toggle ordering, retired room data, and stream disposal.
- Fail-first is not proven. Each fix landed in the same commit as its tests, and mutation testing was out of scope.
- The relay retry fix has unit tests against a mock pool. See "Relay reconnection on a real network" for the browser evidence.

## Regression comparison with master

Read on 249eb67. The 13 moved test files have the same number of tests and the same number of `expect(` calls as on `origin/master`. The e2e suite declares 99 tests on both. No test was newly skipped or focused. The 3 skipped tests are the upstream interop tests in the default run, which `pnpm test:upstream-interop` runs.

## Quality gates

Run for this re-verification, on 05638a6:

- `pnpm build`: passed.
- `pnpm sdk:coverage`: 1529 passed, 3 skipped, 100% on all four metrics.
- `pnpm --filter @cahmls/sdk typecheck`, `pnpm exec tsc --noEmit`, and `pnpm lint`: passed.
- `pnpm exec vitest run --reporter=dot`: 1718 passed, 3 skipped.
- `git diff --check origin/master..HEAD`: no output.

Run in the first pass, on 249eb67, and not repeated:

- `pnpm sdk:verify-package` and `pnpm docs:build`: passed.

Supplied by the orchestrator, on 249eb67, not run here:

- `pnpm test:e2e`: 99 passed.
- `pnpm check:upstream`: passed.
- `pnpm test:upstream-interop`: 3 passed.

GitHub CI:

- 249eb67: run 42006177810 concluded `success`. Its one job, `lint-unit-build-e2e`, runs on Node 22.
- 05638a6: `gh run list --branch feat/cahmls-sdk --limit 1` showed run 42008073536 `in_progress` after 2m26s. It is not counted as evidence.

## Notes

These do not block the phase.

- `coordinatorMethods.ts:971` and `:1014` carry two `TODO` comments that predate this phase.
- The roadmap plan box and requirement statuses still read as in progress.

## Relay reconnection on a real network

The earlier human-verification item is closed by browser evidence. Invite links carry only `wss://` relays, so in `a persistent host can navigate home rooms while communicating on another coordinator` the home tab reaches the remote coordinator over public relays. That test failed on a developer machine on `master` and before the fix, and a temporary 120-second wait also failed. It passes after the fix, in the isolated repeat run and in both the local and CI full suites. The evidence is one network, not a survey of network conditions.
