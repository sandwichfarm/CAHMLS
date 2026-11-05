# Identity Reload and Rotation-History Verification

**Verified:** 2026-08-07  
**Commits inspected:** `07e24df`, `a409444`, `1416394`  
**Verdict:** PASS — all requested behaviors are implemented, wired, and exercised by targeted tests.

| Requirement | Verdict | Code evidence | Test evidence |
| --- | --- | --- | --- |
| A saved NIP-07 selection survives delayed extension injection before room startup. | ✓ Verified | `UserProfileStore.bootstrap()` awaits `restoreNip07Session()`. That waits up to 1 second for `window.nostr`; `App.svelte` derives `identityReady` from that same initialization; `ChatRoute.svelte` will not initialize a route until `identityReady`. | The updated Playwright test saves the session, reloads with the browser mock withholding `window.nostr` for 75 ms, immediately consumes a real room invite after hydration, and proves the stored joined room has the saved NIP-07 public key. |
| A durable anonymous identity remains stable. | ✓ Verified | `loadAnonymousIdentity()` strictly reloads the versioned local credential; bootstrap creates only when absent. | `keeps the initialized anonymous identity without a prior NIP-07 selection` passes; existing browser reload test compares persisted identity record and avatar across reload. |
| Rotation warns that channel access is lost and channels move to History. | ✓ Verified | `IdentityRotationDialog.svelte` states the loss/move consequence for nonzero membership and explains that prior channels are read-only and need a new invite; `UserProfile.svelte` announces the same post-success outcome. | Browser rotation test asserts the singular warning text. |
| Confirmed rotation retires authority and exposes the channel in collapsed sidebar History. | ✓ Verified | Rotation awaits live-session retirement and `retireAnonymousMemberships()`, which scrubs secret-bearing room fields, marks the membership `retired`, and emits the room-change event. `HostWorkspace.svelte` reconciles retired rooms into `SidebarHistory`; `SidebarHistory.svelte` defaults closed and labels the reason `Identity retired`. | Browser rotation test passes: it checks the retired storage shape, finds `History 1` with `aria-expanded=\"false\"`, expands it, and sees the room title plus `Identity retired`. |

## Wiring trace

`App.svelte` starts profile initialization → `UserProfileStore.bootstrap()` restores anonymous identity then waits/restores a saved NIP-07 session → `identityReady` becomes true only after that promise resolves → `HostWorkspace` forwards it → `ChatRoute` invokes `initializeRoute()` only when it is true. This blocks room startup during the bounded extension wait.

On rotation: `UserProfileStore.rotateAnonymousIdentity()` retires registered sessions and persisted memberships before committing/publishing the replacement signer. The room-store retirement event refreshes `HostWorkspace`; sidebar-ledger reconciliation converts `membershipStatus: \"retired\"` into `identity-retired` History entries, which `SidebarHistory` renders collapsed by default.

## Checks run

- `pnpm exec vitest run tests/unit/user-profile.test.ts -t "restores a selected NIP-07 session when the extension injects shortly after bootstrap|keeps the initialized anonymous identity without a prior NIP-07 selection|rotates an anonymous identity only after creating a replacement"` — 3 passed.
- `pnpm exec playwright test tests/e2e/nip07-session-restoration.spec.ts -g "restores NIP-07 before a legacy invite is consumed in the unified root shell"` — 1 passed.
- `pnpm exec playwright test tests/e2e/identity-rotation-behavior.spec.ts -g "locks a confirmed rotation until the replacement identity succeeds"` — 1 passed.
- `pnpm lint` — passed.
- `pnpm exec tsc --noEmit` — passed.
- `git diff --check 07e24df^..HEAD` — passed; no stub/debt markers found in the modified implementation files.

No gaps found.
