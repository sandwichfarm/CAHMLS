---
phase: 27-mobile-optimized-experience
status: planned
nyquist: enabled
requirements: [MOBILE-01, MOBILE-02, MOBILE-03, MOBILE-04, MOBILE-05, MOBILE-06, MOBILE-07]
updated: 2026-08-07
---

# Phase 27 Validation Strategy

## Validation principle

Every implementation task begins with a failing focused test where practical and ends with its narrowest green command. A plan is not complete from task execution alone: later waves must exercise the actual public mobile journey, and Phase 27 closes only after full local gates, Cordn interoperability, independent verification, UI review, pushed evidence, and green PR checks.

## Requirement evidence map

| Requirement | Primary evidence | Focused command | Phase gate |
|---|---|---|---|
| MOBILE-01 | Tap-only offline disclosure, Favorites, room/participant actions, reactions, personal controls | `pnpm exec playwright test tests/e2e/mobile-optimized-experience.spec.ts --project=mobile-chromium` | Both mobile engines and explicit interaction inventory |
| MOBILE-02 | Shared Room browser and one-overlay policy unit/browser tests | `pnpm test -- tests/unit/mobile-overlay.test.ts` | Host and invitee drawer/sheet journeys in both engines |
| MOBILE-03 | VisualViewport unit tests and touch-target/viewport matrix | `pnpm test -- tests/unit/viewport-overlay.test.ts` | 390x844, 844x390, 390x520, injected 390x430, and 320px backstop |
| MOBILE-04 | Fresh host lifecycle plus independent invite/admit/message/reaction clients | mobile acceptance spec | Same complete journey on mobile Chromium and WebKit |
| MOBILE-05 | IndexedDB validation, exact identity keying, ordered queue, reload and flush | `pnpm test -- tests/unit/indexeddb-snapshot-storage.test.ts` | Browser reload/stop/restart evidence in both engines |
| MOBILE-06 | Denied/open/write/quota/corrupt/version/legacy/flush failure tests | storage unit test plus mobile recovery cases | Bounded recovery, explicit temporary state, no recursive start or secret output |
| MOBILE-07 | Playwright project configuration and `.tap()` usage | `pnpm exec playwright test --list` | Complete dedicated suite on `mobile-chromium` and `mobile-webkit` |

## Per-plan cadence

| Plan | RED evidence | GREEN evidence | Regression boundary |
|---|---|---|---|
| 27-01 | New IndexedDB/storage lifecycle unit cases fail before adapter/state implementation | Storage unit tests, focused workspace lifecycle, TypeScript | Existing identity/setup and Cordn transport behavior |
| 27-02 | Overlay policy and host/guest Room-browser browser cases fail first | Mobile overlay unit test and focused navigation E2E | Desktop rail, exact room selection, invite callbacks |
| 27-03 | Hoverless/touch geometry and VisualViewport cases fail first | Viewport unit test plus focused responsive E2E | Fine-pointer hover and keyboard accessibility |
| 27-04 | Mobile project/tracer, WebKit parity, two-client and failure matrices fail first | Dedicated two-engine suite | Full desktop E2E and pinned upstream interop |

## Full phase gate

```bash
pnpm exec playwright test --list
CI=1 PLAYWRIGHT_PORT=4302 pnpm exec playwright test tests/e2e/mobile-optimized-experience.spec.ts --project=mobile-chromium --project=mobile-webkit --workers=1
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm test:e2e
pnpm build
pnpm check:upstream
pnpm test:upstream-interop
git diff --check
```

## Human and independent gates

- A separate GSD verifier produces `27-VERIFICATION.md` with requirement-by-requirement code and test evidence.
- A separate UI reviewer produces `27-UI-REVIEW.md` against the approved UI-SPEC at required phone states.
- The exact verified commit is pushed, one non-duplicate PR is open, and remote checks reach terminal green before the stop condition is claimed.
- Missing browser binaries, unavailable external services, credentials, or remote checks are recorded as blockers; they are not converted into passes.

## Privacy guard

Tests may assert public UI text and opaque IndexedDB record counts/keys, but must never log, snapshot, or embed private keys, invite capabilities, raw snapshots, decrypted transport payloads, or raw browser storage exceptions in failure output.
