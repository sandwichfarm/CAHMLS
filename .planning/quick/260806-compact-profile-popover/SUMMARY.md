# Summary

The operator profile now remains a bounded 22rem card on tablet-sized layouts and switches to a viewport sheet only at 520px and below. A Playwright regression test verifies the 800px layout.

## Evidence

- `pnpm lint`
- `pnpm exec tsc --noEmit`
- `pnpm test` — 316 passed, 3 skipped
- `pnpm exec playwright test tests/e2e/identity-ui-review.spec.ts` — 10 passed
- `pnpm build`
- `git diff --check`
