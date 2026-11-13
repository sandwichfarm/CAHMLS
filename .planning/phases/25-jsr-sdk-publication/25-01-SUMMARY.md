---
phase: 25-jsr-sdk-publication
plan: 01
status: incomplete
requirements-completed: [JSR-02, JSR-04]
---

# Phase 25 implementation and release status

The SDK is configured for JSR as `@sandwich/cahmls@0.1.0`, preserving ten source entry points. Package verification checks name, version, source export parity, actual Node imports, and npm tarball contents. Ordinary CI performs a genuine JSR dry run. A separate `Publish SDK to JSR` workflow requires successful same-repository default-branch push CI, checks out its exact `head_sha`, and publishes through OIDC. Documentation covers installation, linking, version updates, activation, and recovery.

JSR found 67 public-type diagnostics. Explicit annotations now preserve the baseline public types; all six touched source files transpile to identical JavaScript relative to `origin/master`. Independent verification detected and closed five return-type fidelity gaps under checked plan 25-02. The upstream checker now accepts type-annotated schema exports while still inspecting runtime fields.

## Delivery

- Branch: `ci/publish-sdk-jsr`, isolated worktree `/tmp/cahmls-jsr-ci`.
- Draft PR: [#19](https://github.com/sandwichfarm/CAHMLS/pull/19).
- Focused commits: `24082e6` planning, `a49c833` workflow/docs, `1aad158` source package/types, `7c8c812` lint/CLI command correction, `3112ab1` type fidelity/upstream-check gap closure, `4de94bd` owner-selected MIT license.
- All implementation commits pushed. The original checkout's unrelated `package.json` edit remains untouched.

## Evidence

- Local lint, application and SDK type checking, unit suite (1,724 passes; three explicitly skipped upstream tests), SDK coverage (100% all four dimensions), package verification (ten exports, 163 packed files with license), docs and application builds pass.
- Live Cordn parity: 11 methods and seven schemas match `27a1ff0931023d880713a1e6eba3010ea3df1e0f`. Pinned real Cordn interoperability: three tests pass across membership paths and encrypted traffic.
- Browser baseline: 100 pass. Final full rerun: 98 pass and two timeouts; focused rerun of both timed-out tests: two pass. Do not describe the final full browser invocation as green.
- `actionlint` and the actual workflow predicate truth table pass; trusted master/main pushes are accepted and failed/cancelled/PR/manual/feature/foreign-repository events are rejected.
- JSR dry run passes with the owner-selected MIT license; its 44-file manifest contains only 40 SDK TypeScript files, README, LICENSE, and package metadata. The earlier GitHub [CI run 43405994937](https://github.com/sandwichfarm/CAHMLS/actions/runs/43405994937) proved the dry run correctly rejected the then-missing license after passing lint, unit, SDK type/coverage/package gates.

## Outstanding work

JSR-01 and JSR-03 remain incomplete until actual deployment. The owner selected MIT and JSR package validation now passes. Require green PR CI, obtain merge authorization per `GIT-PROCEDURES.md`, merge, then monitor successful default-branch CI and the publishing workflow. Verify actual JSR version metadata and consumer installation before claiming publication. The registry currently has zero versions; no publication has occurred.
