---
status: awaiting_human_verify
trigger: "CAHMLS is now forgetting the user session on reload, causing rooms to fail to load. If logged in, it should remember. If it was an ephemeral key, it should remember it as well until user manually refreshes their identity."
created: 2026-08-07
updated: 2026-08-07T00:00:00Z
---

# Debug Session: Identity session lost on reload

## Symptoms

- expected: Authenticated and durable anonymous/ephemeral identities survive reload, allowing their existing rooms to restore; identity changes only through the explicit refresh/rotation action.
- actual: Reload forgets the active user session and rooms consequently fail to load.
- errors: No error message was reported.
- timeline: Regression observed in the current build after prior identity-continuity work.
- reproduction: Sign in or use the generated ephemeral identity, join/create rooms, reload the page, and observe that the prior identity/session and rooms are not restored.

## Current Focus

- bug_class: bohrbug (deterministically reproduced with a delayed NIP-07 injection)
- hypothesis: Confirmed and fixed: a saved NIP-07 selection previously fell back permanently to anonymous when window.nostr injected after bootstrap.
- test: Targeted and full unit suites, focused Chromium identity/room suite, lint, build, and scoped revert-and-reconfirm all pass.
- expecting: In the reporter's browser, a saved NIP-07 session restores after reload even when its extension injects shortly after the app starts; anonymous identity continues to retain its stable key.
- next_action: await real-browser confirmation of the original reload workflow; automated implementation and combined identity-plus-room verification are complete.

reasoning_checkpoint:
  hypothesis: "A late NIP-07 extension injection causes a saved session to be lost because restoreNip07Session returns false on its one immediate `nip07Available` check, and initialize memoizes that anonymous outcome for the rest of the page."
  confirming_evidence:
    - "The delayed-extension regression fails deterministically: after the saved marker is present and window.nostr is added after bootstrap, UserProfileStore.method is anonymous rather than nip07."
    - "restoreNip07Session currently returns before calling connectNip07 whenever nip07Available is false; no later path retries it."
    - "ChatRoute and HostWorkspace gate room work on initialized, so a bounded wait repairs the identity before their signer use."
  falsification_test: "If the delayed-extension regression restores NIP-07 without changing production code, or if a later retry already exists, the one-shot-availability hypothesis is false."
  fix_rationale: "Wait a bounded interval only when the versioned NIP-07 selection marker is present, then construct the extension signer before initialization completes. This preserves the anonymous fallback when no extension arrives and avoids switching signer identity after rooms begin loading."
  blind_spots: "The exact injection delay and extension behavior in the reporter's browser are not observable here; the regression proves the application's vulnerability to that documented timing class, not that every reported device injects late."
  candidate_causes:
    - "code: restoreNip07Session performs a single non-reactive availability check and initialize memoizes its result."
    - "environment: the browser extension injects window.nostr after the application's bootstrap turn."
    - "config: a browser storage policy could remove the marker, but the failing repro retains a valid marker throughout."
    - "data: a corrupt recovery/identity record could block all identity hydration, but the repro has valid records and does not enter recovery."
  and_gate: "yes — the observed authenticated-session loss requires both the one-shot code path and an extension whose injection happens after that check; the code fix removes the timing dependency."

## Evidence

- timestamp: 2026-08-07T00:00:00Z
  checked: Phase-0 knowledge-base recall and earlier identity/reload debug sessions
  found: MemPalace is unavailable and no durable debug knowledge base is present. The graph identifies UserProfileStore, anonymous-identity, and KeyStorage as the identity persistence boundary; prior sessions document related coordinator identity rotation but do not establish this user-session regression's cause.
  implication: Treat the earlier work as a hypothesis candidate only and trace the current user-profile startup path directly.

- timestamp: 2026-08-07T00:00:00Z
  checked: SBFL eligibility
  found: No failing test or per-test coverage spectrum has been supplied for this regression.
  implication: SBFL skipped: no failing tests and no per-test coverage available. Use deterministic reproduction and call-graph tracing for this Bohrbug candidate.

- timestamp: 2026-08-07T00:00:00Z
  checked: UserProfileStore and anonymous identity graph snippets
  found: UserProfileStore.bootstrap loads the local anonymous signer and calls restoreNip07Session only after it is ready. Anonymous identity loading reads one localStorage record and distinguishes absent from corrupt. The graph lacks useful Svelte inbound call edges beyond module initialization.
  implication: The essential distinctions are persistence write/read correctness, NIP-07 marker availability, and whether App awaits initialize before room restoration; inspect those exact source boundaries and tests next.

- timestamp: 2026-08-07T00:00:00Z
  checked: complete identity modules and related resolved NIP-07 investigation
  found: Both identity types have current persistence code: anonymous key material is written and read under cordn:v1:anonymous-identity, and NIP-07 selection is stored under cordn:v1:nip07-session. App invokes userProfileStore.initialize(configStore.userName) with `void`, rather than an awaited startup gate.
  implication: A missing persistence implementation is contradicted. The leading code hypothesis is startup ordering: a consumer may use the signer before initialize has completed.

- timestamp: 2026-08-07T00:00:00Z
  checked: App and ChatRoute graph/source search
  found: App derives identityReady from userProfileStore.initialized and supplies it to the chat route. ChatRoute's initialization effect returns until identityReady is true, then initializes only once; it checks activeSigner only after that gate.
  implication: The first route consumer does retry reactively after hydration, so the simple App `void` call alone cannot explain a ChatRoute pre-hydration failure. HostWorkspace still needs the same inspection before eliminating the ordering branch.

- timestamp: 2026-08-07T00:00:00Z
  checked: HostWorkspace startup guards and existing user-profile regression suite
  found: HostWorkspace autostart also returns until identityReady is true; its hosted-room recovery obtains activeSigner only during subsequent coordinator startup. The focused suite passes 30 tests, including existing identity persistence coverage.
  implication: The known startup consumers are gated; the ordering hypothesis is weakened. Inspect signer ownership because anonymous persistence explicitly zeroes the source secret-key array after constructing its signer.

- timestamp: 2026-08-07T00:00:00Z
  checked: BrowserNostrSigner constructor ownership
  found: BrowserNostrSigner defensively copies the supplied private-key bytes in its constructor, and caches the corresponding public key before createAnonymousIdentity zeroes its temporary input array.
  implication: The temporary-key wipe cannot alter the active signer or produce a reload identity mismatch; eliminate this code hypothesis.

- timestamp: 2026-08-07T00:00:00Z
  checked: browser-level anonymous and NIP-07 reload regressions
  found: `pnpm exec playwright test tests/e2e/nip07-session-restoration.spec.ts --project=chromium` passed all three tests, including restoring NIP-07 before a legacy invite is consumed. The unit suite also covers fresh-store anonymous and NIP-07 restoration.
  implication: Stored credentials and the normal startup ordering work when window.nostr is available before app bootstrap. The existing browser mock does not test late extension injection, and NIP-46 intentionally has no persisted reconnect contract.

- timestamp: 2026-08-07T00:00:00Z
  checked: agent-authored delayed NIP-07 extension regression
  found: `pnpm vitest run tests/unit/user-profile.test.ts` fails one new test: with a valid NIP-07 marker, bootstrap completes anonymous when window.nostr is added 5 ms later; the assertion expected nip07 and received anonymous. The other 30 tests pass.
  implication: The one-shot NIP-07 availability check is a confirmed root-cause mechanism for session loss and room signer mismatch after late extension injection.

- timestamp: 2026-08-07T00:00:00Z
  checked: targeted fix validation
  found: After adding a bounded selected-session availability wait before restoreNip07Session, `pnpm vitest run tests/unit/user-profile.test.ts` passes all 31 tests, including the delayed-injection regression.
  implication: The direct reproduction is fixed and the existing anonymous/NIP-07 persistence contracts remain green; proceed to adjacent and complete validation.

- timestamp: 2026-08-07T00:00:00Z
  checked: full unit, lint, build, and diff validation
  found: `pnpm test` passed 349 tests (3 skipped), `pnpm lint` passed, `pnpm build` passed, and `git diff --check` passed. Build emitted only pre-existing third-party pure-annotation and chunk-size warnings. The scoped diff adds a bounded wait plus its regression; it does not remove or bypass behavior.
  implication: Adjacent unit behavior, static checks, and production compilation are green. Browser identity/room flows and causal revert proof remain.

- timestamp: 2026-08-07T00:00:00Z
  checked: focused Chromium identity and room restoration suite after fix
  found: `pnpm exec playwright test tests/e2e/nip07-session-restoration.spec.ts --project=chromium` passed 3 tests, including anonymous persistence and NIP-07 restoration before consuming a room invite.
  implication: The bounded wait preserves existing browser-visible identity and room restoration behavior.

- timestamp: 2026-08-07T00:00:00Z
  checked: scoped revert with the driving regression preserved
  found: Reversing only the startup availability-wait code causes `pnpm vitest run tests/unit/user-profile.test.ts` to fail the delayed-extension test with expected nip07 and received anonymous; the other 30 tests pass.
  implication: The exact runtime fix is causally necessary for the corrected behavior; reapply it immediately and reconfirm green.

- timestamp: 2026-08-07T00:00:00Z
  checked: combined delayed signer and room restoration browser regression
  found: The saved NIP-07 session injects 75 ms after reload, restores before identityReady, and immediately consumes a real invite using the restored signer public key; the focused Chromium test passes.
  implication: The timing fix is proven at the browser boundary together with the room-authority behavior reported broken.

- timestamp: 2026-08-07T00:00:00Z
  checked: explicit rotation consequence and History presentation
  found: The confirmation names the exact channel count, warns access will be lost, says channels move to History, and the focused browser test proves confirmed retirement appears in collapsed History with secret authority scrubbed.
  implication: Deliberate anonymous rotation is clearly consented and preserves only safe historical presentation data.

## Eliminated

- hypothesis: Room restoration executes once before the user identity hydrates and does not retry.
  evidence: ChatRoute gates initializeRoute on reactive identityReady, and HostWorkspace gates autostart/recovery on the same prop; both obtain the signer only after that condition is true.
  timestamp: 2026-08-07T00:00:00Z

- hypothesis: Zeroing the temporary anonymous secret after persistence also zeros BrowserNostrSigner's active key.
  evidence: BrowserNostrSigner copies the Uint8Array in its constructor before the temporary source is wiped.
  timestamp: 2026-08-07T00:00:00Z

- hypothesis: A missing/cleared NIP-07 selection marker causes the reported reload loss.
  evidence: The failing delayed-injection reproduction retains a syntactically valid versioned marker for its full duration; the failure occurs solely because the extension is absent at the initial check.
  timestamp: 2026-08-07T00:00:00Z

- hypothesis: Corrupt anonymous identity or recovery-marker data prevents identity hydration.
  evidence: The delayed-injection reproduction uses valid identity records and reaches initialized ready state; it fails only to adopt the delayed NIP-07 signer.
  timestamp: 2026-08-07T00:00:00Z

## Resolution

- root_cause: A persisted NIP-07 selection is only checked once during UserProfileStore bootstrap. When window.nostr injects after that instant, restoreNip07Session exits, initialize memoizes the anonymous fallback, and existing rooms whose authority belongs to the authenticated key cannot restore. The trigger requires a late browser-extension injection plus the non-retrying startup code path.
- fix: Added a 1-second, 25-ms-poll bounded wait for window.nostr only when a valid persisted NIP-07 selection exists; bootstrap restores the selected extension signer before setting initialized. Clarified anonymous rotation consequences and proved confirmed channels move into collapsed History.
- oracle_type: specified — a saved NIP-07 selection must restore its authenticated public key before identityReady allows room work, while the existing anonymous key must remain stable on reload.
- verification:
    target_test: { result: pass, command: "pnpm vitest run tests/unit/user-profile.test.ts", result_detail: "31 tests passed, including delayed NIP-07 extension injection." }
    mutation_check: { result: skipped, reason_if_skipped: "No Stryker dependency or configuration is present in package.json or the repository." }
    no_op_deletion: { result: pass, deletion_justified_by_rca: false, result_detail: "The scoped diff adds bounded identity hydration and a specified-oracle regression; it neither removes nor short-circuits behavior." }
    adjacent_tests: { result: pass, suites_run: ["pnpm test (349 passed, 3 skipped)", "pnpm lint", "pnpm build", "pnpm exec playwright test tests/e2e/nip07-session-restoration.spec.ts --project=chromium (3 passed)"] }
    revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true, result_detail: "Reversing only the wait made the driving test fail with expected nip07 and received anonymous; reapplying it restored all 31 focused tests." }
    guardrail_verdict: accepted
- files_changed:
  - src/identity/user-profile.svelte.ts
  - src/components/IdentityRotationDialog.svelte
  - src/components/UserProfile.svelte
  - tests/unit/user-profile.test.ts
  - tests/e2e/nip07-session-restoration.spec.ts
  - tests/e2e/identity-rotation-behavior.spec.ts
