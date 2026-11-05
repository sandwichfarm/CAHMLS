# CAHMLS Agent Delivery Contract

This repository uses Get Shit Done (GSD) as the default software delivery lifecycle. Agents should preserve the user's product intent, produce inspectable planning artifacts, implement in small verified increments, and leave a clean requirement-to-evidence trail.

## Operating Principles

- Treat `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/STATE.md` as the source of truth for active milestone scope and status.
- Prefer the codebase-memory MCP graph for code discovery: `search_graph`, `trace_path`, `get_code_snippet`, `query_graph`, then `get_architecture`. Use `rg` for literal strings, non-code files, or gaps in the graph.
- Preserve unrelated working-tree changes. Multiple agents may share this checkout; never revert or overwrite work you do not own.
- Use Svelte 5 runes, strict TypeScript, browser-safe APIs, and the project's existing component/state patterns. Do not introduce Node-only runtime dependencies.
- Keep `packages/sdk` free of UI framework imports and of imports from `src/`. Application services reach it through injection (`configureRoomEnvironment`, `CoordinatorRuntime` options).
- Keep private keys, invite secrets, and decrypted message material out of logs, errors, snapshots, fixtures, and commits.
- Use `apply_patch` for intentional file edits and focused commands for generated formatting or test output.
- Follow [`GIT-PROCEDURES.md`](GIT-PROCEDURES.md) for branch creation, commit cadence, remote synchronization, upstream escalation, issue publication, pushing, and pull requests. A completed task is not delivered while its commits exist only in the local checkout unless the user explicitly requested local-only work.

## Required GSD Lifecycle

1. **Scope the milestone**
   - Record user outcomes as atomic, testable requirement IDs in `.planning/REQUIREMENTS.md`.
   - Map each active requirement to exactly one roadmap phase.
   - Keep deferred and out-of-scope behavior explicit.

2. **Discuss and specify the phase**
   - Read the active phase goal, requirements, prior decisions, relevant screenshots, and existing code patterns.
   - Capture implementation decisions and non-goals in the phase `CONTEXT.md`.
   - For frontend phases, create and validate a `UI-SPEC.md` before implementation planning.

3. **Plan and check before editing**
   - A GSD planner writes executable `PLAN.md` tasks with exact files, dependencies, tests, and requirement IDs.
   - A separate GSD plan checker performs goal-backward analysis.
   - Revise blocked plans until the checker passes; do not execute a known-invalid plan.

4. **Execute in bounded increments**
   - A GSD executor owns only the files or responsibility assigned in its plan.
   - Add or update tests with the behavior change. Prefer failing coverage before the implementation when practical.
   - Keep commits focused and preserve traceability to the phase/requirement or review finding. Commit every independently verified increment; do not accumulate an entire phase as uncommitted work.

5. **Verify outcomes, not task completion**
   - Run proportional unit, browser, lint, type-check, build, and diff checks.
   - A separate GSD verifier checks every must-have and requirement against code and test evidence.
   - Frontend phases also receive a visual/UI review against their design contract.

6. **Close gaps deliberately**
   - When verification or UAT finds gaps, create a gap-closure plan and re-run execution and verification.
   - Use code review and audit findings as tracked inputs; do not silently waive them.
   - Requirement completion requires implementation, passing evidence, and verification.

7. **Ship only a proven branch**
   - Before opening a PR, require a clean feature branch, passing verification, full quality gates, and no unresolved blocking audit findings.
   - Synchronize with the remote, push the feature branch, open or update its PR, monitor required checks, and record the PR in project state. Follow the exact procedure and blocker rules in `GIT-PROCEDURES.md`.

## Project Quality Gates

Run the narrowest relevant checks while iterating, then the complete gate before shipping:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm --filter @cahmls/sdk typecheck
pnpm test
pnpm sdk:coverage
pnpm sdk:verify-package
pnpm docs:build
pnpm test:e2e
pnpm build
git diff --check
```

When a command cannot run because an external service, credential, or browser capability is unavailable, document the exact blocker and retain all locally provable evidence. Do not claim completion for an unproven requirement.

## Cordn Interoperability Guardrails

For changes to `packages/sdk/src/` coordinator, server, contract, or client modules, or chat admission and wire-protocol paths:

- Run `pnpm check:upstream` to detect live Cordn method and schema drift.
- Run `pnpm test:upstream-interop` to execute the pinned upstream `CliSession` against CAHMLS's real ContextVM/Nostr transport. The gate must prove join-request admission, a CAHMLS-to-Cordn direct invitation, a Cordn-to-CAHMLS direct invitation, and encrypted messages in both directions for every membership path.
- Keep the browser invite tests for CAHMLS-created and externally shaped canonical links. Do not treat tests that use CAHMLS client code on both sides as sufficient cross-client proof.

## Completion Standard

A phase is complete only when its requirements are implemented, automated checks pass, verifier evidence exists, and any required human/visual checks are resolved. A milestone is complete only after a requirement-by-requirement audit passes and the requested pull request is open on the remote.
