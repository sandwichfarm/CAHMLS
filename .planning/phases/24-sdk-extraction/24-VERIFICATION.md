---
phase: 24-sdk-extraction
status: gaps_found
verified: 2026-11-05
requirements: [SDK-01, SDK-02, SDK-03, SDK-04, SDK-05, SDK-06, SDK-07]
commit: 249eb67
score: 5/7 requirements verified
gaps:
  - truth: "SDK-04: SDK tests enforce coverage thresholds in CI, and every coverage exclusion is honest"
    status: partial
    reason: "Thresholds are enforced and pass, but one of the five v8 ignore comments is false: it excludes a branch that can be reached today and that no test exercises."
    artifacts:
      - path: "packages/sdk/src/client/protocol.ts"
        issue: "The v8 ignore at line 393 says the verifying key always comes from a member leaf. For a past-epoch message it comes from a retained tree, so a sender who has since left the group reaches the branch."
    missing:
      - "Remove the v8 ignore and add a test that a sender no longer in the current tree is rejected."
human_verification:
  - test: "Read the final conclusion of GitHub CI run 42006177810, or run pnpm build, on 249eb67."
    expected: "The run succeeds, including its Build step. This is the only evidence for the build leg of SDK-06."
    why_human: "pnpm build was out of scope for this verification and no result was supplied. CI was still running when read."
  - test: "Take a room offline and bring it back on a real network with ordinary relay latency, with no prior accepted publish on the pool."
    expected: "The room reconnects within the bounded retry window."
    why_human: "The regression tests use a mock pool and fake timers. Commit 249eb67 corrected a fix whose own regression test had passed, so the mock alone is weak evidence for this behavior."
---

# Phase 24 Verification

**Verdict: GAPS FOUND**

The extraction achieves its structure: `@cahmls/sdk` is framework-free, imports nothing from the application, loads through its `exports` map, and is documented for every public export. `CoordinatorStore` only mirrors `CoordinatorRuntime`. Two requirements are not closed. SDK-04 has one false coverage exclusion, and SDK-06 has no evidence yet for its build check.

| Requirement | Verdict | Evidence |
|---|---|---|
| SDK-01 | PASS | No UI framework imports or rune usage in `packages/sdk/src`. The only `../../` imports stay inside the package. Thirty modules moved, and no copies remain under `src/` by file name or in git. |
| SDK-02 | PASS | `pnpm sdk:verify-package` loaded 10 entry points and checked 162 packed files, on Node 26.11.1. The Node 22 floor depends on the pending CI run. An import walk of `dist` shows SQLite only under root, `runtime`, `server`, and `storage/browser`, matching the phase decision and the docs. |
| SDK-03 | PASS | `runtime/coordinator-runtime.ts` (1,036 lines) has `subscribe` and `getSnapshot`, exercised by `coordinator-runtime.test.ts`. `coordinator.svelte.ts` fell from 884 to 134 lines and holds mirroring, delegation, and application injection only. |
| SDK-04 | GAP | Thresholds are 100% on all four metrics and CI runs `pnpm sdk:coverage`, which passes (3,612 statements, 2,085 branches, 807 functions, 3,280 lines). One exclusion is false, as described below. |
| SDK-05 | PASS | After `pnpm docs:build`, all 307 exports across the nine subpath entry points have their own page in `docs/reference`. The root entry has no module of its own. Its 224 exports are the union of those modules plus the `contracts` and `mls` namespaces. All 35 named imports in the guides, API overview, and SDK README resolve to real exports. CI runs the build. |
| SDK-06 | NOT PROVEN | Lint, type-check, and unit checks pass, and the supplied browser and upstream results pass. `pnpm build` has no result yet. |
| SDK-07 | PASS, sampled | All nine fix commits were sampled. See the limits below. |

## Coverage exclusions

Five `v8 ignore` comments exist in `packages/sdk/src`. Each claim was checked against the code it relies on.

- `client/invite.ts:143`: honest. The pinned `nostr-tools` always sets `relays` for an `nprofile`.
- `client/room-store.ts:1626`: honest. Both callers reach it only without a current record of the same identity.
- `coordinator/storage/browserSqliteStorage.ts:48`: honest. The class is built only without `localStorage`, where the clearing function has already returned, and no other path calls `clear`.
- `server/base64.ts:36`: honest. `decodeBase64` rejects every empty result first.
- `client/protocol.ts:393`: **false**. A one-off probe against the built package reached this branch using a sender who had left the group. The message was rejected, which is the required behavior, so this is a coverage accounting defect and not a behavior defect.

## SDK-07 sample and limits

`packages/sdk/tests/` does cover the sample. 34 defects named in the nine fix commits (`10eacab`, `117c986`, `6220d6b`, `22daaa2`, `7da3f1d`, `5377577`, `7817f9c`, `226c4e0`, `249eb67`) were matched to a test by title, and those tests passed in the full run. The bodies of seven were read.

- This is a sample, not every defect. Items not traced to a named test include subscriber shutdown on coordinator close, reaction toggle ordering, retired room data, and stream disposal.
- Fail-first is not proven. Each fix landed in the same commit as its tests, and mutation testing was out of scope.
- The relay retry fix is proven only against a mock pool. See `human_verification`.

## Regression comparison with master

The 13 moved test files have the same number of tests and the same number of `expect(` calls as on `origin/master`. The e2e suite declares 99 tests on both. No test was newly skipped or focused. The 3 skipped tests are the upstream interop tests in the default run, which `pnpm test:upstream-interop` runs.

## Quality gates

Run for this verification, on 249eb67:

- `pnpm --filter @cahmls/sdk typecheck`, `pnpm exec tsc --noEmit`, and `pnpm lint`: passed.
- `pnpm exec vitest run --reporter=dot`: 1717 passed, 3 skipped.
- `pnpm sdk:coverage`: 1528 passed, 3 skipped, 100% on all four metrics.
- `pnpm sdk:verify-package` and `pnpm docs:build`: passed.
- `git diff --check origin/master..HEAD`: no output.

Supplied by the orchestrator, not run here:

- `pnpm test:e2e`: 99 passed.
- `pnpm check:upstream`: passed.
- `pnpm test:upstream-interop`: 3 passed.

Not run and not supplied: `pnpm build`.

GitHub CI: `gh run list --branch feat/cahmls-sdk --limit 1` showed run 42006177810 `in_progress` after 5m25s, with head 249eb67. It is not counted as evidence. `.github/workflows/ci.yml` contains the SDK typecheck, coverage, package verification, docs build, and app build steps.

## Notes

These do not block the phase.

- `README.md:175` still names `src/cordn/`, which no longer holds any files.
- Empty untracked directories remain on disk under `src/cordn` and `src/crypto`.
- `coordinatorMethods.ts:971` and `:1014` carry two `TODO` comments that predate this phase.
- There is no `24-01-SUMMARY.md`. The roadmap plan box and requirement statuses still read as in progress.
