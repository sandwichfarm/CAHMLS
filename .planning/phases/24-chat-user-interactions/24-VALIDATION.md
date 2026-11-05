---
phase: 24
slug: chat-user-interactions
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-06
---

# Phase 24 — Validation Strategy

> Per-phase validation contract for chat-user interaction and kind-3 safety feedback during execution.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1 + Playwright |
| **Config file** | `vite.config.ts`, `playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run tests/unit/chat-protocol.test.ts tests/unit/message-presentation.test.ts tests/unit/chat-participant-preferences.test.ts tests/unit/nostr-invites.test.ts` |
| **Full suite command** | `pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm test:e2e && pnpm build && pnpm check:upstream && pnpm test:upstream-interop && git diff --check` |
| **Estimated runtime** | Quick: under 20 seconds; full: several minutes |

## Sampling Rate

- **After every task commit:** Run the narrowest affected Vitest or Playwright file plus `pnpm exec tsc --noEmit`.
- **After every plan wave:** Run `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, and the Phase 24 Playwright spec.
- **Before `$gsd-verify-work`:** The complete project and upstream interoperability gates must be green.
- **Max feedback latency:** 30 seconds for ordinary unit/UI task iteration.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 24-01-01 | 01 | 1 | MENTION-01, INVMSG-01 | T-24-01 | Recipient metadata is normalized, signed, mutation-resistant, and legacy-compatible. | unit | `pnpm exec vitest run tests/unit/chat-protocol.test.ts` | ✅ | ⬜ pending |
| 24-01-02 | 01 | 1 | INVMSG-01, IGNORE-01 | T-24-02 | Non-target invites are removed before grouping and create no render artifact. | unit | `pnpm exec vitest run tests/unit/message-presentation.test.ts` | ✅ | ⬜ pending |
| 24-02-01 | 02 | 1 | IGNORE-01, HILITE-01 | — | Exact-room ignores and global validated colors persist without modifying room state. | unit | `pnpm exec vitest run tests/unit/chat-participant-preferences.test.ts` | ❌ W0 | ⬜ pending |
| 24-03-01 | 03 | 1 | FOLLOW-01, FOLLOW-02 | T-24-03 | Only newest valid self-authored kind-3 state is selected and publication commits after relay acceptance. | unit | `pnpm exec vitest run tests/unit/nostr-invites.test.ts` | ✅ | ⬜ pending |
| 24-04-01 | 04 | 2 | USER-01, MENTION-02, INVUSER-01 | T-24-04 | Context actions are non-self, keyboard-operable, and invite capabilities never appear as raw text. | browser | `pnpm exec playwright test tests/e2e/chat-user-interactions.spec.ts` | ❌ W0 | ⬜ pending |
| 24-04-02 | 04 | 2 | USER-01, IGNORE-01, HILITE-01 | — | Both panes share menu, disclosure, highlight, focus-return, and narrow-viewport behavior. | browser | `pnpm exec playwright test tests/e2e/chat-user-interactions.spec.ts` | ❌ W0 | ⬜ pending |

## Wave 0 Requirements

- [ ] `tests/unit/chat-participant-preferences.test.ts` — strict storage parsing, exact-room ignore keys, global highlight keys, invalid palette repair.
- [ ] `tests/e2e/chat-user-interactions.spec.ts` — host/invitee context menu parity, mention emphasis, targeted invite omission, independent ignore disclosure, highlight reload, keyboard/focus, 320px containment.
- Existing Vitest, Playwright, mock signer, relay, room fixture, and upstream interop infrastructure requires no new dependency.

## Manual-Only Verifications

All phase behaviors have automated verification. A final UI review still inspects hierarchy and highlight contrast as an independent quality gate.

## Security and Privacy Backstops

- **T-24-01:** A recipient list changed after signing invalidates the compact chat proof; malformed/duplicate/non-hex `p` tags cannot create mention or invite targets.
- **T-24-02:** Targeted-invite filtering is presentation-only but must remove the complete non-target render subtree without claiming cryptographic secrecy.
- **T-24-03:** Invalid, foreign-author, stale-generation, or deterministically older kind-3 events cannot alter follow state; failed publication cannot commit optimistic state.
- **T-24-04:** Invite URLs, decrypted message content, private keys, and signer material do not appear in visible raw text, aria labels, errors, snapshots, fixtures, or logs.

## Validation Sign-Off

- [x] All planned capability areas have an automated verification path or explicit Wave 0 test.
- [x] Sampling continuity: no three consecutive tasks can proceed without an automated check.
- [x] Wave 0 names every missing test file.
- [x] No watch-mode flags.
- [x] Quick feedback target is under 30 seconds.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-08-06
