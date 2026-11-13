---
phase: 25-jsr-sdk-publication
verified: 2026-11-13T10:15:00Z
status: gaps_found
score: 3/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "A trusted default-branch push with successful CI triggers OIDC publication of the tested commit; pull requests cannot publish."
    status: partial
    reason: "The workflow is implemented and guarded, but it is still on draft PR #19. The registered JSR package has versionCount 0, so no default-branch publish run or registry version proves the requested deployment."
    artifacts:
      - path: .github/workflows/publish-jsr.yml
        issue: "Cannot activate from a pull-request branch; workflow_run publication requires merge to the default branch and successful default-branch CI."
    missing:
      - "Merge the reviewed PR to the default branch, allow CI to complete, and verify a successful Publish SDK to JSR run plus @sandwich/cahmls@0.1.0 registry metadata."
---

# Phase 25: JSR SDK Publication Verification Report

**Phase Goal:** Publish the SDK as `@sandwich/cahmls` through GitHub Actions after the exact release commit passes CI.
**Verified:** 2026-11-13T10:15:00Z
**Status:** gaps_found
**Re-verification:** Yes — after public-type gap closure in 25-02.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | The JSR source manifest preserves all public code entry points and matches the SDK version. | ✓ VERIFIED | `jsr.json` names `@sandwich/cahmls`, has version `0.1.0`, MIT metadata, and all 10 source entry points. The package verifier checks exact export parity and a clean-checkout `jsr publish --dry-run` passed with 44 files, all source/metadata only. |
| 2 | CI runs a real JSR publish dry run and catches invalid packages before publishing. | ✓ VERIFIED | CI has a `Verify JSR publication` step in `packages/sdk`; remote run 43405994937 executed it and failed solely on the formerly missing license. The same exact command now passes from a clean checkout in `/tmp/cahmls-jsr-mit-clean-dry-run.log`. |
| 3 | A trusted default-branch push with successful CI triggers OIDC publication of the tested commit; pull requests cannot publish. | ✗ FAILED | The guarded workflow is substantive and validated, but no default-branch run can exist until PR #19 is merged. JSR API evidence still has `versionCount: 0`; no published `@sandwich/cahmls@0.1.0` exists. |
| 4 | Contributors can follow documented installation and release instructions. | ✓ VERIFIED | SDK README and Getting Started document JSR installation, the internal workspace distinction, repository linking, OIDC, version synchronization, trigger rules, and recovery. |

**Score:** 3/4 truths verified.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/sdk/jsr.json` | Source-package identity and exports | ✓ VERIFIED | Name/version/license, all 10 source exports, and narrow include list are present. |
| `packages/sdk/scripts/verify-package.mjs` | Manifest parity proof | ✓ VERIFIED | Checks JSR name, version, every runtime export target, source existence, built npm entry points, and package boundary. Current run: 10 entry points, 163 npm packed files. |
| `.github/workflows/ci.yml` | Real release preflight | ✓ VERIFIED | Runs the pinned JSR dry run after SDK package verification. |
| `.github/workflows/publish-jsr.yml` | Trusted OIDC publication | ⚠️ PRESENT, AWAITING ACTIVATION | Guards success/push/same repository/master-or-main, checks out `workflow_run.head_sha`, disables credential persistence, and grants only job-level `contents: read` / `id-token: write`. It cannot run from the draft PR. |
| `packages/sdk/README.md` and `docs/guide/getting-started.md` | Consumer and maintainer instructions | ✓ VERIFIED | Imports and installation use `@sandwich/cahmls`; release instructions distinguish it from `@cahmls/sdk`. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| npm export map | JSR source export map | parity verifier | ✓ WIRED | Exact sorted export-key and source-target checks passed. |
| CI | JSR dry run | `working-directory: packages/sdk` | ✓ WIRED | Remote CI exercised the step; clean source dry run now succeeds. |
| successful CI workflow_run | publication checkout | `head_sha` plus OIDC job | ✓ WIRED | `actionlint` passed; an eight-case predicate evaluation accepted only trusted main/master push success and rejected failed, PR, manual, feature, and foreign-repo cases. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Source-package validation | Clean checkout `pnpm dlx jsr@0.14.3 publish --dry-run` | Passed; 44 included files, no app/test/build files | ✓ PASS |
| Public API compatibility | TypeScript equality and bidirectional assignability for all 14 `CoordinatorAdapter` returns against `ab53031` declarations | Passed after 25-02 | ✓ PASS |
| Upstream contract compatibility | `pnpm check:upstream` and `pnpm test:upstream-interop` | Passed: 11 methods, 7 schemas, 3 interop tests | ✓ PASS |
| Browser regression timeout retry | Two timed-out full-suite tests rerun serially on an isolated port | 2/2 passed; first post-change full suite had 98 passes and two timing timeouts while shared `dist` was being rebuilt | ⚠️ TIMING LIMITATION |

### Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| JSR-01 | ⚠️ PARTIAL | Source validity, clean dry run, all entry points and baseline public method declarations are verified. Its wording includes availability on JSR, so requirement completion remains pending actual registry publication under JSR-03. |
| JSR-02 | ✓ SATISFIED | CI has a real dry-run gate; remote failure correctly caught the missing license, and corrected dry run passes locally from a clean checkout. |
| JSR-03 | ✗ BLOCKED | Workflow is secure and wired but unactivated; deployment needs an approved merge/default-branch run and registry evidence. |
| JSR-04 | ✓ SATISFIED | Documentation covers install, linking, versioning, CI trigger, OIDC, and recovery. |

### Anti-Patterns Found

No phase-introduced `TBD`, `FIXME`, `XXX`, bypass flag, `continue-on-error`, or registry token was found. `coordinatorMethods.ts` contains two pre-existing TODOs from commit `bfa4ed95`, already present at the Phase 25 base; Phase 25 introduced none.

### Gaps Summary

The release implementation is ready and independently validated, including JSR's actual validation engine. Deployment itself remains unproven because the workflow cannot run from this draft PR and the registry contains zero versions. Merging is deliberately outside the agent's authority; after an approved merge, the default-branch CI and OIDC publication run must be monitored to terminal success and the JSR registry must show `@sandwich/cahmls@0.1.0`.

_Verified: 2026-11-13T10:15:00Z_
_Verifier: gsd-verifier_
