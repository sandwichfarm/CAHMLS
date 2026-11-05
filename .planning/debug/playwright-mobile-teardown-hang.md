---
status: resolved
trigger: "The independent two-client mobile Chromium Playwright worker reaches teardown without a test failure, but the Playwright parent process remains alive with its preview server and never emits a terminal result."
created: 2026-08-07
updated: 2026-08-07
---

# Debug Session: Playwright Mobile Teardown Hang

## Symptoms

- **Expected behavior:** `pnpm exec playwright test tests/e2e/mobile-optimized-experience.spec.ts --project=mobile-chromium --grep "independent mobile clients" --workers=1` exits with a terminal pass/fail result and shuts down its owned preview server.
- **Actual behavior:** the independent host/invitee worker reaches teardown with no reported assertion failure, but the Playwright parent process and preview server remain alive indefinitely.
- **Errors:** no terminal test error is emitted; generated error/trace artifacts must not preserve capability-bearing invite output.
- **Timeline:** introduced while implementing Phase 27 Plan 04's real two-client mobile touch journey. The single-client durable mobile host tracer exits normally.
- **Reproduction:** run the dedicated two-client test under the `mobile-chromium` project with one worker; observe the worker finish while the parent/preview processes remain.

## Current Focus

- **bug_class:** bohrbug (deterministic once server ownership was isolated)
- **hypothesis:** CONFIRMED — see Resolution. The teardown-order hypothesis was refuted; the defect was a mobile drawer scrim covering the guest composer.
- **next_action:** none; resolved and verified

## Evidence

- **timestamp:** 2026-08-07
  **checked:** Semantic and durable debug-history lookup.
  **found:** `mempalace` is unavailable and `.planning/debug/knowledge-base.md` does not yet exist.
  **implication:** There is no prior-resolution candidate; the investigation proceeds from direct observation.
- **timestamp:** 2026-08-07
  **checked:** Current branch status and recent history.
  **found:** The only uncommitted path is this new debug-session file. The two-client mobile journey was added by `c46ba31`; the predecessor single-client tracer was added by `2c772f1`.
  **implication:** The suspected behavior is isolated to a committed Phase 27 test change, while unrelated worktree changes are absent.
- **timestamp:** 2026-08-07
  **checked:** Complete `tests/e2e/mobile-optimized-experience.spec.ts` and `playwright.config.ts`.
  **found:** The two-client test creates a separate `guestContext`, closes it in `finally`, then only taps the host `Stop` control (with errors swallowed) and does not wait for the host to reach `idle`. The exiting one-client tracer both stops and waits for `status-badge` to be `idle`. Both tests share a per-file mock relay closed in `afterAll`.
  **implication:** The test has a concrete teardown asymmetry to differentiate from the guest-context candidate; no production code is implicated yet.
- **timestamp:** 2026-08-07
  **checked:** Complete mock-relay and established-installation fixture implementations plus similar relay-owning specs.
  **found:** `MockRelay.close()` calls `socket.close()` for every connection and then awaits the Node WebSocket server's `close` callback; it does not wait for individual socket close events or force-terminate stalled clients. The installation helper only seeds browser storage. Other two-client specs close their extra contexts, but the mobile test uniquely couples a fresh guest context with a live host and immediate per-file relay shutdown.
  **implication:** An incomplete socket shutdown is mechanically capable of hanging `afterAll`; the exact command now has a specific, observable prediction.
- **timestamp:** 2026-08-07
  **checked:** Standard bounded-command utilities.
  **found:** Neither `gtimeout` nor GNU `timeout` is installed. The first wrapper invocation did not start Playwright because zsh reserves the name `status`.
  **implication:** No reproduction result has been observed yet; use an explicit process-group watchdog without the reserved variable name.
- **timestamp:** 2026-08-07
  **checked:** First 60-second process-group-wrapped reproduction.
  **found:** Playwright emitted `Running 1 test using 1 worker`, but no terminal result was captured before the wrapper command ended. The expected wrapper exit marker was also absent.
  **implication:** This is not yet a valid pass/fail observation; process ownership must be checked before changing any test or relay code.
- **timestamp:** 2026-08-07
  **checked:** Post-run process/port state and result-file names, without opening diagnostics.
  **found:** No current `pnpm exec playwright` runner remained, but port `4173` was already served by an orphaned project Vite preview process whose elapsed time predates this run by many hours. A test-result diagnostic file was created but intentionally not read because it may contain capability-bearing runtime material.
  **implication:** The reported command's non-CI `reuseExistingServer` setting confounds server ownership in this checkout. A unique `CI=1` preview port is required for a trustworthy teardown test; existing orphan processes are not this task's owned targets and will be preserved.
- **timestamp:** 2026-08-07
  **checked:** Isolated reproduction startup on `CI=1 PLAYWRIGHT_PORT=4235`.
  **found:** The chosen preview and mock-relay ports were free. The isolated build completed, a new web server started, and Playwright reported `Running 1 test using 1 worker`; it had not emitted a test-result line after 30 seconds.
  **implication:** This run is not confounded by port 4173, but it has not yet distinguished an in-test wait from teardown. The exact terminal session is bounded to one further 30-second poll.
- **timestamp:** 2026-08-07
  **checked:** Second 30-second poll of isolated Playwright session `3146`.
  **found:** The session remained live with no further output and still no test-result line after 60 seconds total.
  **implication:** This isolated run did not reproduce the reported post-worker teardown state within the bounded window; it is currently an in-test or worker-level wait. The owned session must be interrupted before the next focused experiment.
- **timestamp:** 2026-08-07
  **checked:** Exact-session interruption and its post-interrupt process state.
  **found:** Ctrl-C terminated Playwright session `3146`. Its uniquely configured preview server remained as process group `83250` (shell PID 83250, Vite PID 83286) on port 4235; both PIDs were created by this run and have parent PID 1.
  **implication:** These are safe, task-owned cleanup targets. The old port-4173 server and unrelated browser processes remain out of scope.
- **timestamp:** 2026-08-07
  **checked:** Owned process-group cleanup for the interrupted isolated run.
  **found:** TERM to process group `83250` released port 4235; neither verified PID remained.
  **implication:** The interrupted run's resources are fully cleaned. The next run can use a distinct port to locate the exact teardown boundary.
- **timestamp:** 2026-08-07
  **checked:** Instrumented isolated reproduction startup on port 4236.
  **found:** A new build and preview server started, then Playwright reported one worker. The only added observability consists of constant lifecycle labels around guest-context close, host stop, and relay close; no runtime values are logged.
  **implication:** The next terminal output can distinguish test-body delay from a specific teardown boundary without exposing capabilities.
- **timestamp:** 2026-08-07
  **checked:** Two 30-second polls of the instrumented isolated session `63135`.
  **found:** After 60 seconds, the session remained live with no test-result line and no temporary teardown marker.
  **implication:** This bounded reproduction never reached `guestContext.close()`, host stop, or `afterAll`; it cannot confirm the reported teardown hang and shifts the immediate investigation to an earlier test-body phase.
- **timestamp:** 2026-08-07
  **checked:** Cleanup and rollback of the bounded instrumentation run.
  **found:** Ctrl-C ended session `63135`; its exact preview group `86808`/`86911` on port 4236 was then terminated and the port was released. The temporary constant lifecycle markers were removed, leaving only this debug file modified.
  **implication:** No debugging instrumentation or owned preview process remains. Further evidence must come from static differential analysis before any fix.
- **timestamp:** 2026-08-07
  **checked:** `c46ba31` diff, comparable multi-context tests, coordinator lifecycle, transport shutdown, and browser pagehide code.
  **found:** The Phase 27 test adds the only local flow that closes a guest context then performs `await stopCoordinator(host).catch(() => undefined)` without waiting for `idle`. The existing durable mobile tracer explicitly waits for idle after every host stop. The UI calls `void coordinator.stop()`, so the click helper does not await shutdown; coordinator shutdown synchronously closes the transport only after an async snapshot flush, and mock-relay `afterAll` awaits graceful socket/server closure.
  **implication:** The test has a concrete, testable cleanup-order difference spanning code and runtime resources. A full declared-timeout marker run is required because the prior 60-second cap is shorter than the legitimate admission path.
- **timestamp:** 2026-08-07
  **checked:** Final marker reproduction startup on `CI=1 PLAYWRIGHT_PORT=4237`.
  **found:** The chosen port was free, the isolated preview build completed, and the focused Playwright invocation started one worker. No lifecycle marker or test-result line had appeared after the first 30 seconds.
  **implication:** The run remains within its declared timing budget and needs further bounded polls to reach the teardown markers.
- **timestamp:** 2026-08-07
  **checked:** Full-budget marker reproduction on `CI=1 PLAYWRIGHT_PORT=4241` with a 420-second watchdog (session resumed after interruption; orphaned port-4237 preview from the prior run cleaned first).
  **found:** The test failed terminally (exit 1) at `locator.tap` on the host Send button after the 120s test budget: the button stayed `disabled` with an empty composer for ~105s, all four teardown markers then completed (guest close, relay close, host stop), and the Playwright parent exited with a reported result. No parent-process or preview-server hang occurred.
  **implication:** The reported indefinite hang does not reproduce under isolated server ownership; the terminal defect is a test-body failure — the composer fill was lost.
- **timestamp:** 2026-08-07
  **checked:** Host composer markup and state paths (`HostWorkspace.svelte`): Send is `disabled={!composerEnabled || !composer.trim()}` with `composerEnabled` a constant `true`; only `send()` and active-room deletion clear `composer`. The test approves invitees inside the room-browser drawer and never closes it before filling the composer.
  **found:** With the drawer open, the mobile modal surface makes the background composer inert. Playwright `fill` passes its actionability checks (visible/enabled/editable — inert is not checked) but `focus()` on an inert element is a no-op, so the inserted text never reaches the input and `composer` stays empty, keeping Send `disabled`. This regression window opened when Wave 3 tightened inert enforcement.
  **implication:** Test-side defect: the journey must close the drawer after approving (matching real mobile UX) and assert the fill landed before tapping Send.

## Eliminated

- The mock-relay `afterAll` close and the guest-context/host-stop teardown order do not hang the parent process: all teardown markers completed and the runner exited terminally in the isolated full-budget reproduction. (Preventive hardening was still added: bounded force-terminate in `MockRelay.close()` and an idle wait after host stop.)
- The originally reported "parent alive with preview server" state is attributed to the non-CI `reuseExistingServer` confound with pre-existing orphaned preview processes, not to this branch's test or product code.

- **timestamp:** 2026-08-07
  **checked:** Instrumented milestone timing across the two-client journey (constant labels only, no runtime values), then bounded per-action budgets on the guest send.
  **found:** Every relay-crossing milestone completed within 15 seconds (admission at +11s, reaction round trip at +15s). The stall was entirely in one action: `locator.tap` on the guest Send button, which reported `<button aria-label="Close room browser" class="mobile-rail-scrim"> intercepts pointer events` for the full budget.
  **implication:** Not a transport, teardown, or timing defect. A room-browser drawer the guest never opened was covering the guest composer.
- **timestamp:** 2026-08-07
  **checked:** `HostWorkspace.svelte` mobile child-surface coordination and every `viewportOverlay` consumer.
  **found:** `clearMobileChildSurface` ran `if (compactViewport) mobileRailOpen = true` on **every** `cahmls:mobile-overlay-close` event. All compact sheets (reaction picker, room actions, profile, presence, notifications) dispatch that global event, and `HostWorkspace` shells the guest chat route too. So closing a sheet opened from the message list raised the shell's drawer, whose full-screen scrim then intercepted composer taps.
  **implication:** Confirmed product defect with a precise mechanism, reachable by real users — not a test artifact.

## Resolution

- **root_cause:** `HostWorkspace`'s `clearMobileChildSurface` unconditionally re-opened the mobile room-browser drawer whenever any compact sheet closed on a narrow viewport. The Wave 3 commit `7e40ecb` introduced this to restore a drawer whose own trigger opened the sheet, but the global `cahmls:mobile-overlay-close` event carries no ownership information, so sheets opened from the chat surface raised a drawer the reader never requested. Its scrim then swallowed taps on the composer's Send button. `7e40ecb` also masked the symptom in `workspace-lifecycle.spec.ts` with a conditional "close it if it reopened" step.
- **fix:** Capture drawer ownership on the opening transition only (`mobileChildSurfaceRestoresDrawer = mobileRailOpen`, guarded by `if (!mobileChildSurfaceOpen)` because sheets re-dispatch open on every scroll/resize reposition), and restore the drawer on close only when it actually owned the sheet. The masked assertion in `workspace-lifecycle.spec.ts` was strengthened from a conditional dismissal into a deterministic `toBeVisible()` expectation, since drawer-owned restoration is now guaranteed.
- **verification:** The two-client `mobile-chromium` journey went from a 240s timeout (blocked at the guest Send tap) to passing in 20.2s. The durable host journey additionally asserts that after a chat-surface sheet closes, the drawer stays `aria-hidden="true"`, no `.mobile-rail-scrim` exists, and the composer still sends. Full mobile spec run across `mobile-chromium` and `mobile-webkit` plus the complete repository gate.
- **files_changed:** `src/components/HostWorkspace.svelte`, `tests/e2e/mobile-optimized-experience.spec.ts`, `tests/e2e/workspace-lifecycle.spec.ts`, `tests/e2e/mock-relay.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`

## Follow-up: WebKit parity deferred

Both mobile journeys were confirmed to pass under `mobile-webkit` locally, but WebKit executes this MLS/relay path roughly an order of magnitude slower than Chromium (durable host journey: 2.7 minutes versus 9.2 seconds). Three engine differences were resolved along the way and are retained in the spec:

- `navigator.maxTouchPoints` reports `0` on WebKit even in a touch context, so the touch assertion accepts `"ontouchstart" in window` as an equivalent signal.
- WebKit rejects `grantPermissions(["clipboard-read", "clipboard-write"])`, so the clipboard read-back assertion is Chromium-only; the visible "Copied" confirmation remains the shared touch evidence.
- Per-engine budgets come from `budgets(testInfo)` rather than inflating every project's timeouts.

The `mobile-webkit` project is therefore opt-in through `MOBILE_WEBKIT=1` and is not part of the default gate or CI. Promoting it is tracked as follow-up work, not a known failure.

## Notes

The originally reported symptom — "Playwright's parent process stays alive with the preview server and never reports a terminal result" — never reproduced under isolated server ownership. It was an artifact of `reuseExistingServer: !process.env.CI` binding to pre-existing orphaned preview processes on port 4173. Running with `CI=1` and a unique `PLAYWRIGHT_PORT` produced terminal results every time. Two pieces of preventive hardening were kept regardless: `MockRelay.close()` now force-terminates sockets that do not complete the close handshake within 2s, and the two-client journey waits for the host coordinator to reach `idle` before the per-file relay closes.
