# Phase 24: SDK Extraction - Context

**User request (2026-11-05):** Extract the coordinator and client to a proper SDK with full test coverage and documentation, with zero regressions in the web application. Fix unknown bugs when found. Open a PR. Use VitePress for docs.

## Decisions

- **Workspace package, consumed from source.** `packages/sdk` is `@cahmls/sdk` in a pnpm workspace. The app aliases it to source in Vite and TypeScript so development never depends on a stale build. `sdk:verify-package` separately proves the built output.
- **Subpath entry points.** `client`, `contracts`, `coordinator`, `crypto`, `mls`, `relay`, `runtime`, `server`, and `storage/browser`. SQLite loads only through `server`, `runtime`, `storage/browser`, and the root.
- **Injection instead of imports.** Notifications, sidebar history, storage, and events reach the room store through `configureRoomEnvironment`. `src/sdk-bindings.ts` is the single wiring point.
- **Runtime plus thin binding.** `CoordinatorRuntime` holds lifecycle logic and exposes `subscribe`/`getSnapshot`. `CoordinatorStore` mirrors snapshots into `$state.raw` fields and delegates all behavior.
- **Stay in the app:** `ResourceMonitor` (rune-based presentation metrics; the SDK exposes `setTelemetrySink`), `ConfigStore`, identity and profile, notification center, sidebar ledger, navigation, and message presentation.
- **Documentation.** VitePress guides plus a TypeDoc-generated reference, so every public export is documented without hand-kept lists. The generated output is not committed.
- **No registry publication.** The package is publishable, but publishing is left to the user.

## Non-goals

- Changing wire behavior, tool names, or schemas.
- Replacing the snapshot persistence model or its known pre-identity scoping.
- Changing the UI.
