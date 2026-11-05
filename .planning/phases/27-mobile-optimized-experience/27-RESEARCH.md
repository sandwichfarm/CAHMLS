# Phase 27: Mobile-Optimized Experience - Research

**Researched:** 2026-08-07  
**Domain:** Touch-first Svelte workspace, browser-native persistence, mobile browser E2E  
**Confidence:** HIGH for the existing-code seams and approved contract; MEDIUM for browser API details cited from primary documentation.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- Touch is a first-class input. No required action may depend on hover, fieldset focus, a hidden-but-clickable target, or a hardware keyboard. Pointer and keyboard behavior remain supported.
- The active conversation is the primary mobile surface. Coordinator, room, Favorites, History, invitation, notification, profile, and settings navigation move into deliberate drawers or sheets rather than sharing a permanently compressed desktop rail.
- The existing visual identity remains: dark terminal-like surfaces, restrained green status/accent color, hairline structure, monospaced type, and compact information density. Mobile optimization changes hierarchy, interaction, containment, and target sizing rather than replacing the brand.
- Interactive targets are at least 44 by 44 CSS pixels on coarse pointers. Visible glyphs may remain compact inside those targets.
- Phone portrait, phone landscape, small/short screens, safe-area insets, and viewport reduction from an onscreen keyboard are supported states. The focused input and its primary action remain reachable.
- Offline coordinator room disclosure must have an explicit tap control. Favorite actions, reactions, room actions, and other formerly hover-revealed affordances must be discoverable on hoverless devices.
- Durable coordinator persistence moves to native IndexedDB and is scoped by normalized coordinator pubkey. The current sqlite-wasm KVVFS path and JSON fallback both use synchronous `localStorage` and therefore are not independent mobile-safe durability paths.
- IndexedDB persistence serializes snapshot writes, validates version and shape at the boundary, exposes persistence failures without secrets, and flushes before stop reports success. A new identity must never silently inherit an unscoped legacy snapshot.
- If durable storage is unavailable, denied, corrupt, or exhausted, startup presents an actionable recovery choice. Temporary operation is allowed only when explicitly disclosed as non-durable; the UI must not claim persistence.
- Existing Cordn wire behavior and interoperability remain unchanged. Storage and UI work must not alter invite, admission, MLS, ContextVM, or Nostr contracts.

### the agent's Discretion

None provided in `27-CONTEXT.md`.

### Deferred Ideas (OUT OF SCOPE)

- Native iOS/Android packages, push-notification backends, gesture-only shortcuts, or a new visual brand.
- Changes to Cordn protocol semantics or weakening encrypted-room authority to make mobile tests easier.
- Claiming mobile support from resized desktop tests alone.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MOBILE-01 | All primary interactions work with one touchscreen tap. | One shared room browser, persistent coarse-pointer affordances, and tap-only E2E paths. [VERIFIED: .planning/REQUIREMENTS.md] |
| MOBILE-02 | Navigation is one predictable drawer/sheet model. | A single state owner and overlay lifecycle/focus contract below. [VERIFIED: .planning/REQUIREMENTS.md] |
| MOBILE-03 | 44px targets and contained keyboard-safe layouts. | Coarse-pointer CSS, visual viewport owner, safe-area layout, and geometry assertions. [VERIFIED: .planning/REQUIREMENTS.md] |
| MOBILE-04 | Full touch host/guest lifecycle works after reload. | Chromium/WebKit mobile host and two-client journey plan. [VERIFIED: .planning/REQUIREMENTS.md] |
| MOBILE-05 | Identity-scoped async IndexedDB snapshot durability. | Native IndexedDB record design, Zod boundary validation, serialized writer, and flush. [VERIFIED: .planning/REQUIREMENTS.md] |
| MOBILE-06 | Storage failure paths fail safely and truthfully. | Typed storage result/recovery state, no legacy auto-adoption, and failure injection. [VERIFIED: .planning/REQUIREMENTS.md] |
| MOBILE-07 | Real touch projects prove journeys on Chromium and WebKit. | Playwright projects with `isMobile`, `hasTouch`, and `.tap()` coverage. [VERIFIED: .planning/REQUIREMENTS.md] |
</phase_requirements>

## Project Constraints (from AGENTS.md)

- Use the codebase-memory graph before grep for code discovery; preserve unrelated shared-worktree changes.
- Use Svelte 5 runes, strict TypeScript, browser-safe APIs, and existing component/state patterns; introduce no Node-only runtime dependency.
- Never place private keys, invite secrets, or decrypted messages in logs, errors, snapshots, fixtures, or commits.
- Use `apply_patch` for edits; run relevant narrow checks, then `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm test:e2e`, `pnpm build`, and `git diff --check` before shipping.
- Preserve Cordn contracts. Changes touching `src/cordn/`, coordinator contracts, chat admission, or wire paths require `pnpm check:upstream` and `pnpm test:upstream-interop`; browser tests alone cannot prove cross-client interoperability.

## Summary

Phase 27 is two coupled but separable vertical slices: consolidate the host and guest narrow-screen room-navigation presentation without changing room data or wire semantics, then replace only coordinator snapshots with an identity-keyed asynchronous IndexedDB owner. The existing host owns a partial `mobileRailOpen` implementation while the guest uses `WorkspaceNav`; the existing coordinator persistence callback synchronously serializes full snapshots into either sqlite KVVFS or `localStorage`. [VERIFIED: src/components/HostWorkspace.svelte; src/components/ChatRoute.svelte; src/components/WorkspaceNav.svelte; src/cordn/coordinator/storage/browserSqliteStorage.ts; src/cordn/coordinator/storage/inMemoryStorage.ts]

Use a presentational `RoomBrowser` composition shared by both routes, owned by a route-level mobile-overlay controller. Keep all room data, selection, and business callbacks in `HostWorkspace`/`ChatRoute`; the shared component receives slots or explicit callback props and does not create a second navigation store. This follows the approved contract's single state owner while retaining the existing desktop rail over 900px. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md] [ASSUMED]

Use the platform IndexedDB API directly—no new persistence dependency. Its asynchronous open, upgrade, readwrite transaction, and completion/error model matches the required durable boundary; each queued snapshot write must resolve only after its transaction's `complete` event, not after `put()` is issued. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB] [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event]

**Primary recommendation:** First establish the reusable mobile overlay/room-browser and keyboard-height primitive with focused E2E tests; then migrate coordinator snapshot persistence behind an explicit `flush()` lifecycle boundary, with failure/recovery UI and storage tests before swapping the default backend. [ASSUMED]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Room-browser opening, close/focus/back handling | Browser / Client | Frontend Server — | Svelte routes own local DOM state, focus restoration, history state, and responsive presentation. [VERIFIED: src/components/HostWorkspace.svelte; src/components/ChatRoute.svelte] |
| Host/guest room list and room selection | Browser / Client | API / Backend — | Lists derive from existing local `room-store` records and callbacks; they must not reimplement Cordn membership logic. [VERIFIED: src/chat/room-store.ts; src/components/HostWorkspace.svelte; src/components/WorkspaceNav.svelte] |
| Safe-area, visual viewport, and coarse-pointer affordances | Browser / Client | — | `VisualViewport`, CSS media queries, `env()`, and focus/scroll are browser responsibilities. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport] [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/pointer] [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env] |
| Durable coordinator snapshot persistence | Browser / Client | Database / Storage | The client owns encrypted coordinator state and native IndexedDB stores its per-identity record; no server receives this snapshot. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts] [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB] |
| Snapshot validation and error classification | Browser / Client | — | The storage boundary must reject malformed data before `InMemoryCoordinatorStorage.restoreSnapshot()` and expose only user-safe errors. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts; package.json] [ASSUMED] |
| Stop/save truthfulness | Browser / Client | API / Backend — | `CoordinatorStore.stop()` controls the visible status and transport lifecycle; it must await the storage adapter's flush before transition to `stopped`. [VERIFIED: src/coordinator/coordinator.svelte.ts] |
| Mobile interaction proof | Browser / Client | — | Playwright device projects create touch-enabled browser contexts and exercise locators through `tap()`. [CITED: https://playwright.dev/docs/emulation] [CITED: https://playwright.dev/docs/api/class-locator#locator-tap] |

## Standard Stack

### Core

| Library / API | Version | Purpose | Why Standard |
|---------------|---------|---------|--------------|
| Native IndexedDB | Browser API | Identity-keyed durable snapshot record with async reads/writes. | Supports object stores, versioned schema upgrade, transactions, and request/transaction completion events without a new dependency. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB] |
| Svelte 5 runes | `5.56.3` installed | Existing reactive mobile-overlay, storage-state, and component implementation. | Project constraint requires existing Svelte 5 patterns; all current workspace controllers use `$state`/`$derived`. [VERIFIED: package.json; src/components/HostWorkspace.svelte; src/components/ChatRoute.svelte] |
| Zod | `4.4.3` installed | Validate persisted record envelope and snapshot version/shape before restoration. | Already present in the project; do not trust a cast from browser storage before passing data to decode/restore code. [VERIFIED: package.json; src/cordn/coordinator/storage/inMemoryStorage.ts] [ASSUMED] |
| Playwright Test | `1.61.0` installed | Dedicated touch-enabled Chromium and WebKit projects and real multi-context journeys. | Project's only current project is Desktop Chrome; Playwright device descriptors include viewport/touch emulation and `tap()` requires a touch context. [VERIFIED: playwright.config.ts; package.json] [CITED: https://playwright.dev/docs/emulation] [CITED: https://playwright.dev/docs/api/class-locator#locator-tap] |

### Supporting

| Library / API | Purpose | When to Use |
|---------------|---------|-------------|
| CSS `@media (pointer: coarse), (hover: none)` | Make otherwise hover-revealed required controls persistently visible and 44px. | Only for input-adaptive presentation; do not gate actual operability on a media query. [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/pointer] |
| `window.visualViewport` + `100dvh` fallback | Drive `--app-visual-height` and update overlays/composer after viewport resize/scroll. | VisualViewport is present; retain `100dvh`/`window` fallback for browsers without it. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport] [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length] |
| CSS `env(safe-area-inset-*)` | Keep drawer, sheets, composer, and footer controls clear of cutouts/system areas. | Applied as additive padding with the UI-SPEC minimum spacing. [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env] |
| Existing `viewportOverlay` | Preserve top-layer anchored desktop popovers and centralize resize/scroll placement. | Extend for visual-viewport listeners and sheet mode; do not add a competing overlay package. [VERIFIED: src/lib/viewport-overlay.ts] [ASSUMED] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native IndexedDB | Current sqlite-wasm KVVFS / JSON fallback | Reject: SQLite documents KVVFS as a whole database in main-thread `localStorage`, with a single database and small quota; the current fallback is the same synchronous storage family. [CITED: https://sqlite.org/wasm/doc/trunk/persistence.md] [VERIFIED: src/cordn/coordinator/storage/browserSqliteStorage.ts] |
| Existing Svelte/CSS overlay primitive | Third-party drawer/sheet library | Reject: would duplicate existing native dialog/popover/overlay patterns and violate the approved no-new-UI-package direction. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md] |
| Explicit serialized writer | Fire-and-forget `onChange` promise | Reject: the current callback is synchronous and has no lifecycle join point, so a stop can report completion while queued browser storage is unfinished. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts; src/coordinator/coordinator.svelte.ts] [ASSUMED] |

**Installation:** No package installation is recommended. Remove `@sqlite.org/sqlite-wasm` only after repository-wide references and its unit mock are removed; retain the already-pinned Playwright and Zod dependencies. [VERIFIED: package.json; src/cordn/coordinator/storage/browserSqliteStorage.ts; tests/unit/browser-coordinator-storage.test.ts]

## Package Legitimacy Audit

No external package is introduced in this phase, so no package install checkpoint is required. `@sqlite.org/sqlite-wasm` is an existing dependency to remove from this persistence path, not a recommendation to add. The registry legitimacy seam rates the existing `@sqlite.org/sqlite-wasm` package `OK`; it rates the currently newest `@playwright/test` release `SUS` solely for recency, while the project remains pinned to already-installed `1.61.0`. [VERIFIED: package-legitimacy seam; package.json]

## Architecture Patterns

### System Architecture Diagram

```text
Touch / keyboard / mouse
          |
          v
HostWorkspace ---------------------- ChatRoute
  (host data + callbacks)             (guest data + callbacks)
          \                             /
           \                           /
            v                         v
       RoomBrowser shell + one overlay controller
       - desktop: existing persistent rail
       - <=900px: drawer -> sheets/dialogs
       - focus, scrim, Back/Escape, visual-height
                      |
        room selected | action chosen
                      v
  existing room-store / ChatRoomSession / CoordinatorStore
                      |
            coordinator snapshot mutations
                      v
  InMemoryCoordinatorStorage -> SerializedIndexedDbSnapshotStore
       validate -> per-normalized-pubkey record -> transaction complete
                      |
                      v
       CoordinatorStore.stop(): flush -> close transport -> stopped
```

The diagram keeps Cordn, MLS, ContextVM, Nostr invitation/admission, and transport message behavior downstream and unchanged; Phase 27 wraps their existing storage and presentation seams rather than changing their contracts. [VERIFIED: src/lib/transport.ts; src/cordn/coordinator/coordinator.ts; .planning/phases/27-mobile-optimized-experience/27-CONTEXT.md]

### Recommended Project Structure

```text
src/
├── components/
│   ├── RoomBrowser.svelte                 # NEW shared rail/drawer composition
│   ├── mobile-overlay.svelte.ts            # NEW one-open-surface/focus/back controller
│   ├── app-visual-viewport.ts              # NEW CSS height + focus visibility action
│   ├── HostWorkspace.svelte                # host data/callback owner; renders RoomBrowser
│   ├── ChatRoute.svelte                    # guest data/callback owner; renders RoomBrowser
│   ├── CoordinatorRoomCard.svelte          # explicit offline and coarse-pointer controls
│   ├── RoomActionsMenu.svelte              # desktop popover / mobile sheet branch
│   └── MessageReactions.svelte             # always-discoverable coarse-pointer trigger
├── cordn/coordinator/storage/
│   ├── indexedDbSnapshotStorage.ts         # NEW envelope, validation, queue, IDB adapter
│   ├── browserSqliteStorage.ts              # REMOVE or rename after deleting sqlite/localStorage backend
│   └── inMemoryStorage.ts                  # expose async-safe flush hook without wire changes
├── coordinator/coordinator.svelte.ts       # startup recovery/temporary state and flush-before-stop
└── lib/viewport-overlay.ts                 # visualViewport/listener + sheet containment extension
tests/
├── unit/indexeddb-snapshot-storage.test.ts # NEW queue, validation, scope, failure matrix
├── unit/mobile-overlay.test.ts             # NEW stack/history/focus policy pure helpers
└── e2e/mobile-optimized-experience.spec.ts # NEW touch host + guest journeys
```

The exact new module names are implementation recommendations, while the existing file ownership is confirmed by the graph and source. [VERIFIED: codebase graph; src/components/HostWorkspace.svelte; src/components/ChatRoute.svelte; src/cordn/coordinator/storage/browserSqliteStorage.ts] [ASSUMED]

### Pattern 1: One room-browser state owner with route-owned data

**What:** Extract the common ordering and room-row composition from `HostWorkspace` and `WorkspaceNav` into `RoomBrowser.svelte`. Give it explicit arrays/callbacks and an `open` binding; the host provides lifecycle/create controls, while the guest omits them. Place the active conversation heading/composer focus callback in the route owner. [VERIFIED: src/components/HostWorkspace.svelte; src/components/ChatRoute.svelte; src/components/WorkspaceNav.svelte] [ASSUMED]

**When to use:** Always at `<=900px`; keep existing desktop rails/anchored desktop popovers above the breakpoint. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]

**Implementation rules:**

- The only mobile entry trigger is the named `Open room browser`; it opens the left drawer and retains its opener for focus restoration. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]
- Room selection closes the drawer before navigation and then focuses active conversation heading, except composer-adjacent invite navigation targets the composer. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]
- An action that opens a sheet/dialog closes the drawer and waits for it to leave the accessibility tree before opening the next surface. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]
- Add one overlay stack controller to enforce modal inertness, visible safe close control, scrim/Back/Escape policy, focus trap, and exact opener restoration. Do not let independent child booleans (`mobileRailOpen`, `mobileToolsOpen`, dialog flags) coexist uncoordinated. [VERIFIED: src/components/HostWorkspace.svelte] [ASSUMED]

### Pattern 2: Visual-viewport-aware contained overlay

**What:** Create a single `installAppVisualViewport()` action/store that writes `--app-visual-height` from `visualViewport.height` (else `window.innerHeight` or CSS `100dvh`), batches changes with `requestAnimationFrame`, and listens to both `visualViewport.resize`/`scroll` and window resize/scroll. Extend `viewportOverlay` to subscribe/unsubscribe to the same events, use sheet geometry below 900px, and avoid desktop anchor positioning while a keyboard can obscure the anchor. [VERIFIED: src/lib/viewport-overlay.ts] [CITED: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport] [ASSUMED]

**Example:**

```ts
// Source facts: MDN VisualViewport and CSS dynamic viewport documentation.
// Implementation shape is project-specific inference.
export function installAppVisualViewport(node: HTMLElement) {
  let frame = 0;
  const update = () => {
    frame = 0;
    const height = window.visualViewport?.height ?? window.innerHeight;
    node.style.setProperty("--app-visual-height", `${height}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  schedule();
  return { destroy: () => { /* remove all listeners; cancel frame */ } };
}
```

`VisualViewport` provides resize and scroll events, and mobile viewport offset behavior differs from desktop; `dvh` represents the dynamic viewport height while `vh` maps to the large viewport. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport] [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length]

### Pattern 3: Validated identity-scoped IndexedDB envelope plus serialized writer

**What:** Persist a record such as `{ key: normalizedPubkey, schemaVersion: 1, snapshot: CoordinatorStorageSnapshot, updatedAt }` in one `coordinatorSnapshots` object store. Validate the record envelope and every snapshot field/version before constructing `InMemoryCoordinatorStorage`; separately validate/normalize its key to lowercase 64-hex coordinator identity. Treat missing matching record as fresh state. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts; src/lib/transport.ts] [ASSUMED]

**Writer protocol:**

1. `InMemoryCoordinatorStorage` remains synchronous for Cordn callers, creates its immutable snapshot, and delegates to `queueSnapshot(snapshot)` without awaiting. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts] [ASSUMED]
2. The IndexedDB owner chains every write after a private `tail: Promise<void>`; a newer snapshot is queued after the earlier transaction settles, including errors, so one failed write cannot poison the queue. [ASSUMED]
3. Each job uses one `readwrite` transaction and resolves only on transaction `complete`; reject on request, transaction, open, or abort error after converting the DOM exception to a secret-free storage code. IndexedDB transaction errors/aborts roll back the transaction. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB] [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event]
4. `flush()` awaits the current queue tail and reports the first pending failure; it is idempotent and does not start a new write. `close()` marks the owner closed only after `flush()` succeeds or caller intentionally elects a non-durable stop. [ASSUMED]
5. `CoordinatorStore.stop()` enters a `stopping-and-saving` presentation state, awaits `running.storage.flush()` (or a dedicated transport-owned flush exposure) before closing transport/status transition, and on error leaves runtime running with the recovery sheet. [VERIFIED: src/coordinator/coordinator.svelte.ts; src/lib/transport.ts] [ASSUMED]

**Example:**

```ts
// Source: IndexedDB transaction completion semantics from MDN.
class SerializedSnapshotWriter {
  #tail = Promise.resolve();
  #failure: StorageFailure | null = null;

  enqueue(snapshot: CoordinatorStorageSnapshot) {
    this.#tail = this.#tail
      .catch(() => undefined)
      .then(async () => {
        await putSnapshotAndWaitForTransactionComplete(this.key, snapshot);
        this.#failure = null;
      })
      .catch((error) => { this.#failure = toStorageFailure(error); throw error; });
  }

  async flush() {
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }
}
```

The serialization class, `StorageFailure` type, and `flush()` placement are project-specific implementation inference; transaction completion is the cited API fact. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event] [ASSUMED]

### Pattern 4: Explicit storage recovery state, never implicit temporary fallback

**What:** Model persistence as a visible state—`checking | durable | attention(kind) | temporary | flushing | flushFailed`—rather than as the existing boolean `persistenceEnabled`. Keep encryption/key-storage decisions distinct from whether coordinator snapshots are currently durable. [VERIFIED: src/coordinator/coordinator.svelte.ts; src/components/CoordinatorSettings.svelte] [ASSUMED]

**Rules:** Retry a bounded open/read/write operation; offer `Continue temporarily` only from the recovery sheet; do not create/open a legacy record for a new key; offer `Remove corrupt saved data` only for a corrupt record and require the approved destructive confirmation. Errors shown in state/UI/logs must be code/category text, not a DOMException message, pubkey, snapshot, room name, invite, secret, or decrypted payload. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md; AGENTS.md] [ASSUMED]

### Anti-Patterns to Avoid

- **Async callback cast as synchronous:** Do not change `onChange` to `async` and ignore its promise; writes can race stop/restart and failures vanish. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts; src/coordinator/coordinator.svelte.ts] [ASSUMED]
- **Unscoped fallback migration:** Do not read the old global sqlite/localStorage snapshot and assign it to the currently selected key. Require matching record key; otherwise leave it unused and explain the relevant legacy choice. [VERIFIED: src/cordn/coordinator/storage/browserSqliteStorage.ts; .planning/phases/27-mobile-optimized-experience/27-CONTEXT.md]
- **Two mobile navigators:** Do not retain a host-only off-canvas rail plus `WorkspaceNav` mobile switcher; the same room list must have one open/close owner. [VERIFIED: src/components/HostWorkspace.svelte; src/components/WorkspaceNav.svelte; .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]
- **CSS-only hover dependency:** Do not rely on `:hover`, `:focus-within`, or opacity-zero controls for favorite, offline disclosure, actions, or reactions. [VERIFIED: src/components/CoordinatorRoomCard.svelte; .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]
- **Resize-only keyboard handling:** Do not depend solely on `window.innerHeight` or `100vh`; update from `visualViewport` when available and test a reduced viewport. [VERIFIED: src/lib/viewport-overlay.ts; .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md] [CITED: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Browser durable store | Another localStorage JSON or KVVFS fallback | Native IndexedDB transaction/object-store API | KVVFS is main-thread localStorage-backed and has documented small quota/storage constraints. [CITED: https://sqlite.org/wasm/doc/trunk/persistence.md] |
| Snapshot shape parsing | Blind `JSON.parse(...) as CoordinatorStorageSnapshot` | Existing Zod package with explicit envelope/snapshot schema | Browser persistence is untrusted at the storage boundary; runtime decode/restore expects structured valid fields. [VERIFIED: package.json; src/cordn/coordinator/storage/browserSqliteStorage.ts; src/cordn/coordinator/storage/inMemoryStorage.ts] [ASSUMED] |
| Mobile touch simulation | Desktop click tests resized to a narrow viewport | Playwright `isMobile: true`, `hasTouch: true`, device descriptors, and `locator.tap()` | Playwright documents that `tap()` uses touchscreen and requires touch context. [CITED: https://playwright.dev/docs/emulation] [CITED: https://playwright.dev/docs/api/class-locator#locator-tap] |
| Overlay positioning | New per-component fixed/popover math | Extend existing `viewportOverlay` plus one visual-viewport height primitive | The primitive already places fixed popovers and owns resize/scroll cleanup. [VERIFIED: src/lib/viewport-overlay.ts] |
| Focus/back stack | Ad-hoc booleans in each component | One small route-level overlay controller with reusable focus/history helpers | Phase requires one modal at a time and deterministic Back/Escape/focus restoration. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md] [ASSUMED] |

**Key insight:** keep coordinator runtime methods synchronous for Cordn compatibility; make asynchronous persistence an adapter with explicit lifecycle joins, not a rewrite of coordinator/wire behavior. [VERIFIED: src/cordn/coordinator/coordinator.ts; src/cordn/coordinator/storage/inMemoryStorage.ts] [ASSUMED]

## Common Pitfalls

### Pitfall 1: Stop reports success before durability

**What goes wrong:** Existing `CoordinatorStore.stop()` changes status to stopped after `stopSync()`, while current storage closes synchronously; an async writer added without `flush()` can still be writing or fail after visible success. [VERIFIED: src/coordinator/coordinator.svelte.ts; src/cordn/coordinator/storage/browserSqliteStorage.ts]

**How to avoid:** Thread a storage flush capability through `RunningTransport`/runtime or expose it on the coordinator storage adapter. Await it before close/status finalization; keep runtime alive and show the approved `Try saving again`/`Keep running`/`Stop without saving` branch when it fails. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md] [ASSUMED]

### Pitfall 2: Storage errors leak sensitive material

**What goes wrong:** Raw browser exceptions and snapshot debug strings can expose prior identities or persisted material, violating project and UI-SPEC secrecy constraints. [VERIFIED: AGENTS.md; .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]

**How to avoid:** Map DOM exceptions to a small discriminated `StorageFailureKind` (`unavailable`, `denied`, `quota`, `corrupt`, `write`, `flush`) and render approved static copy. Assert E2E/unit output has no pubkey, invite, `keyPackage64`, `welcome64`, or raw exception. [ASSUMED]

### Pitfall 3: Legacy snapshot attaches to the wrong identity

**What goes wrong:** Current snapshot names are global (`cordn:v1:coordinator-snapshot...` / sqlite `:localStorage:`), while the creation call receives a coordinator public key but does not scope snapshot load/save by it. [VERIFIED: src/cordn/coordinator/storage/browserSqliteStorage.ts; src/lib/transport.ts]

**How to avoid:** Never migrate automatically. Read only record key `normalizedPubkey`; treat an unscoped legacy key as unavailable for the new identity, retain/delete only under an explicit safe recovery action, and never show the previous key. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md] [ASSUMED]

### Pitfall 4: IndexedDB transaction lifetime misuse

**What goes wrong:** Awaiting unrelated work between starting a transaction and issuing requests can leave a transaction inactive; request success does not substitute for transaction completion/error handling. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB]

**How to avoid:** Create transaction, get object store, call `put` synchronously, then await a wrapper around `oncomplete`/`onabort`/`onerror`; do any snapshot validation before creating the transaction. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB] [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event] [ASSUMED]

### Pitfall 5: Hidden touch affordances and incompatible sheet behavior

**What goes wrong:** `CoordinatorRoomCard` exposes offline rooms by pointer/focus and makes favorite button opacity zero until hover/focus; `RoomActionsMenu` currently uses anchored overlay with compact-sheet behavior only below 520px. [VERIFIED: src/components/CoordinatorRoomCard.svelte; src/components/RoomActionsMenu.svelte]

**How to avoid:** Replace offline summary with labelled 44px disclosure. At coarse pointer render favorite/actions/reaction-add visibly; at <=900px put action surfaces in named bottom sheets, not anchor-dependent menus. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-UI-SPEC.md]

### Pitfall 6: Existing tests falsely claim mobile coverage

**What goes wrong:** The config has only `Desktop Chrome`; existing E2E manipulates viewport dimensions and uses mouse `.click()`. [VERIFIED: playwright.config.ts; tests/e2e/workspace-lifecycle.spec.ts]

**How to avoid:** Add separate `mobile-chromium` and `mobile-webkit` projects backed by real phone descriptors or equivalent `isMobile: true`, `hasTouch: true` contexts, and enforce `.tap()` in the new journeys. [CITED: https://playwright.dev/docs/emulation] [CITED: https://playwright.dev/docs/api/class-locator#locator-tap] [ASSUMED]

## Code Examples

### Identity-keyed IndexedDB boundary

```ts
// Source facts: IndexedDB open upgrades and readwrite transactions are async.
const DB_NAME = "cahmls-coordinator";
const STORE = "coordinatorSnapshots";

type SnapshotRecord = {
  key: string;
  schemaVersion: 1;
  snapshot: CoordinatorStorageSnapshot;
  updatedAt: number;
};

function normalizeCoordinatorKey(pubkey: string): string {
  const key = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new StorageFailure("corrupt");
  return key;
}

async function writeRecord(db: IDBDatabase, record: SnapshotRecord): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new StorageFailure("write"));
    tx.objectStore(STORE).put(record);
  });
}
```

The key form, record name, and error class are implementation recommendations. IDB's open/upgrade, readwrite transaction, and complete/error events are primary-source facts. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB] [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event] [ASSUMED]

### Real touch Playwright projects

```ts
// Source: Playwright device emulation and Locator.tap documentation.
projects: [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "mobile-chromium", use: { ...devices["Pixel 5"], browserName: "chromium", isMobile: true, hasTouch: true } },
  { name: "mobile-webkit", use: { ...devices["iPhone 13"], browserName: "webkit", isMobile: true, hasTouch: true } },
]

await page.getByRole("button", { name: "Open room browser" }).tap();
await page.getByRole("button", { name: "Close room browser" }).tap();
```

Use descriptors available in the installed Playwright version, and verify them with `pnpm exec playwright test --list`; device labels are not a product contract. [CITED: https://playwright.dev/docs/emulation] [CITED: https://playwright.dev/docs/api/class-locator#locator-tap] [ASSUMED]

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| SQLite WASM KVVFS / JSON fallback in localStorage | Native async IndexedDB record keyed by coordinator identity | Removes coordinator whole-snapshot UI-thread localStorage path and permits flush/error lifecycle. [VERIFIED: src/cordn/coordinator/storage/browserSqliteStorage.ts] [CITED: https://sqlite.org/wasm/doc/trunk/persistence.md] |
| Desktop Chrome + resized viewport | Device-context Chromium and WebKit with touch input | Verifies actual touch actionability and WebKit behavior. [VERIFIED: playwright.config.ts] [CITED: https://playwright.dev/docs/emulation] |
| Separate host rail and guest navigator | Shared room-browser drawer with route-owned data | Makes navigation consistent without changing room/wire contracts. [VERIFIED: src/components/HostWorkspace.svelte; src/components/WorkspaceNav.svelte] [ASSUMED] |

**Deprecated/outdated:** Do not retain coordinator KVVFS/localStorage snapshot compatibility as a silent fallback. It defeats identity scoping and the explicit durable/temporary truthfulness requirement. [VERIFIED: .planning/phases/27-mobile-optimized-experience/27-CONTEXT.md; src/cordn/coordinator/storage/browserSqliteStorage.ts]

## Implementation Sequence and Exact Seams

1. Add pure browser-storage types and tests first: `src/cordn/coordinator/storage/indexedDbSnapshotStorage.ts`, `tests/unit/indexeddb-snapshot-storage.test.ts`; define key normalization, Zod schemas, typed failures, fake-IDB injection, queue, `flush`, and per-key deletion. Do not touch wire code. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts; package.json] [ASSUMED]
2. Adapt `src/cordn/coordinator/storage/inMemoryStorage.ts`, `src/cordn/coordinator/coordinator.ts`, `src/lib/transport.ts`, and `src/coordinator/coordinator.svelte.ts` to carry an additive flush capability. Update `createBrowserCoordinatorStorage`, deletion, startup rollback, and stop/restart flow; delete `src/cordn/coordinator/storage/browserSqliteStorage.ts` only after imports/tests are moved. [VERIFIED: codebase graph; src/lib/transport.ts; src/coordinator/coordinator.svelte.ts] [ASSUMED]
3. Add visible storage attention/temporary/flushing states in `CoordinatorStore` and host control/settings surfaces (`HostWorkspace.svelte`, `CoordinatorSettings.svelte`, `PersistencePanel.svelte` as applicable), retaining approved exact copy and no sensitive diagnostics. [VERIFIED: src/components/CoordinatorSettings.svelte; src/components/PersistencePanel.svelte; 27-UI-SPEC.md] [ASSUMED]
4. Extract `RoomBrowser.svelte` and an overlay/visual-viewport helper. Refactor `HostWorkspace.svelte`, `ChatRoute.svelte`, and then retire narrow-only behavior in `WorkspaceNav.svelte`; preserve desktop behavior by breakpoint and use one state owner. [VERIFIED: src/components/HostWorkspace.svelte; src/components/ChatRoute.svelte; src/components/WorkspaceNav.svelte] [ASSUMED]
5. Update action components: `CoordinatorRoomCard.svelte` (explicit offline button and coarse-pointer favorite), `RoomActionsMenu.svelte` (mobile sheet), `MessageReactions.svelte`/`MessageGroup.svelte` (visible coarse-pointer reaction entry and 44px sheet grid), plus `viewport-overlay.ts` for containment. [VERIFIED: src/components/CoordinatorRoomCard.svelte; src/components/RoomActionsMenu.svelte; src/lib/viewport-overlay.ts] [ASSUMED]
6. Add real mobile projects and a dedicated mobile spec using existing mock-relay/established-installation fixtures; then run both normal E2E and Cordn upstream gates because storage/transport contract files changed. [VERIFIED: playwright.config.ts; tests/e2e/workspace-lifecycle.spec.ts; AGENTS.md] [ASSUMED]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A new `RoomBrowser.svelte` with callback props/slots is the least disruptive shared composition. | Architecture Patterns | Existing host/guest prop differences may require a smaller shared data model or render-function design. |
| A2 | Zod should validate IndexedDB envelope/snapshot before restore. | Standard Stack | Existing project validation patterns may prefer manually authored type guards for this binary-heavy snapshot. |
| A3 | `flush()` can be threaded additively through transport/runtime without changing Cordn wire contracts. | Pattern 3 | The upstream coordinator close boundary may require a wrapper/owner at `CoordinatorStore`, not interface alteration. |
| A4 | Named `Pixel 5`/`iPhone 13` descriptors exist in the pinned Playwright install. | Code Examples | Config would fail until descriptors are replaced by installed names or equivalent context values. |
| A5 | A fake/injected IndexedDB factory is sufficient for unit failure injection. | Validation Architecture | jsdom's IndexedDB support may require a minimal test-only adapter rather than an extra dependency. |

## Open Questions (RESOLVED)

1. **Does persistence availability describe only coordinator snapshots or the existing encrypted identity key too?**
   - What we know: `persistenceEnabled` presently affects coordinator storage and key storage, while UI calls it encrypted/ephemeral. [VERIFIED: src/coordinator/coordinator.svelte.ts; src/components/CoordinatorSettings.svelte]
   - Resolution: keep encrypted identity-key durability and coordinator-snapshot durability as separate internal capabilities. Phase 27 replaces only coordinator snapshot persistence. If snapshot IndexedDB fails after the identity key is durable, the user may explicitly run a temporary coordinator under that identity; the persistent warning refers specifically to coordinator changes. Existing identity-key behavior remains unchanged unless it independently prevents the required mobile journey. [DECIDED: 27-01-PLAN.md]

2. **What is the approved legacy-data remediation mechanism?**
   - What we know: automatic attachment is forbidden, and corrupt data gets a destructive remove flow. [VERIFIED: 27-CONTEXT.md; 27-UI-SPEC.md]
   - Resolution: retain valid unscoped legacy snapshots untouched for an explicit future recovery/removal action, never auto-attach them to any coordinator identity, and clear them only through an explicitly scoped destructive flow such as full coordinator destroy. A new identity always starts with a fresh identity-scoped IndexedDB record. [DECIDED: 27-CONTEXT.md; 27-01-PLAN.md]

3. **How is VisualViewport reduced-height behavior injected in WebKit CI?**
   - What we know: the UI-SPEC requires 390x430 proof, while Playwright contexts can set viewport but cannot necessarily summon a real virtual keyboard. [VERIFIED: 27-UI-SPEC.md] [ASSUMED]
   - Resolution: provide a deterministic injectable VisualViewport boundary for unit/browser tests, drive the required 390x430 state through that seam when CI cannot summon a virtual keyboard, and retain a real touch-enabled mobile context assertion that the focused composer and Send action remain visible. The seam may change browser geometry input only; it may not bypass application navigation or business state. [DECIDED: 27-03-PLAN.md; 27-04-PLAN.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | build/test tooling | ✓ | project requires `>=22` | — [VERIFIED: package.json] |
| pnpm | repository commands | ✓ | package manager pinned `10.17.1` | — [VERIFIED: package.json] |
| Playwright | mobile Chromium/WebKit E2E | ✓ dependency | `@playwright/test 1.61.0` pinned | Browser binaries must be confirmed with `pnpm exec playwright install --with-deps` when absent. [VERIFIED: package.json] [ASSUMED] |
| IndexedDB | browser persistence | browser API | — | Explicit temporary session only; no localStorage fallback. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB] [VERIFIED: 27-CONTEXT.md] |

**Missing dependencies with no fallback:** none identified before browser-binary availability is checked. [ASSUMED]

**Missing dependencies with fallback:** IndexedDB denial/unavailability is intentionally handled by user-selected temporary operation. [VERIFIED: 27-CONTEXT.md]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `4.1.9` (jsdom) plus Playwright Test `1.61.0`. [VERIFIED: package.json; vite.config.ts] |
| Config file | `vite.config.ts`, `playwright.config.ts`. [VERIFIED: vite.config.ts; playwright.config.ts] |
| Quick run command | `pnpm test -- tests/unit/indexeddb-snapshot-storage.test.ts` or `pnpm exec playwright test tests/e2e/mobile-optimized-experience.spec.ts --project=mobile-chromium`. [VERIFIED: package.json; playwright.config.ts] [ASSUMED] |
| Full suite command | `pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm test:e2e && pnpm build && git diff --check`; additionally run both Cordn gates for changed coordinator/transport contracts. [VERIFIED: AGENTS.md; package.json] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MOBILE-01 | Tap-only room browser/offline/favorite/actions/reactions/personal controls. | E2E | `pnpm exec playwright test tests/e2e/mobile-optimized-experience.spec.ts --project=mobile-chromium` | ❌ Wave 0 |
| MOBILE-02 | One drawer, focus, visible close, scrim, Escape, Back, selected-room close/focus. | unit + E2E | `pnpm test -- tests/unit/mobile-overlay.test.ts` and mobile E2E | ❌ Wave 0 |
| MOBILE-03 | 44px bounds, no horizontal document overflow, contained sheets, 390x844/844x390/390x520/390x430. | E2E | mobile E2E Chromium + WebKit | ❌ Wave 0 |
| MOBILE-04 | Host setup/start/create/stop/reload and two-client invite/admit/messages/reactions by tap. | E2E | mobile E2E each mobile project | ❌ Wave 0 |
| MOBILE-05 | Validated per-key IDB restore, ordered writes, flush-on-stop, no localStorage snapshot. | unit + E2E reload | `pnpm test -- tests/unit/indexeddb-snapshot-storage.test.ts` | ❌ Wave 0 |
| MOBILE-06 | denied/open/write/quota/corrupt/legacy/flush failure and explicit temporary choice. | unit + E2E | storage unit test and mobile E2E recovery cases | ❌ Wave 0 |
| MOBILE-07 | `hasTouch` mobile Chromium/WebKit projects and `.tap()` journeys. | config + E2E | `pnpm exec playwright test --project=mobile-chromium --project=mobile-webkit` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** changed Vitest file plus focused Playwright project. [ASSUMED]
- **Per wave merge:** `pnpm test` and changed E2E project(s). [VERIFIED: AGENTS.md] [ASSUMED]
- **Phase gate:** full quality suite, `pnpm check:upstream`, and `pnpm test:upstream-interop` after storage/transport changes. [VERIFIED: AGENTS.md]

### Wave 0 Gaps

- [ ] `tests/unit/indexeddb-snapshot-storage.test.ts` — normalization, schema/version validation, queue ordering, open/read/write/quota/abort/corrupt failures, flush and scoped delete.
- [ ] `tests/unit/mobile-overlay.test.ts` — overlay stack/focus/history helper policy if extracted as a pure module.
- [ ] `tests/e2e/mobile-optimized-experience.spec.ts` — touch-only host, two-client chat, responsive geometry, and recovery journeys.
- [ ] `playwright.config.ts` — `mobile-chromium` and `mobile-webkit` touch projects.
- [ ] Test-only IndexedDB/VisualViewport injection seam if jsdom/WebKit does not expose the failure mode deterministically; do not add an unreviewed test dependency. [ASSUMED]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No direct new auth flow | Preserve existing identity and invite/admission logic; do not modify protocol behavior. [VERIFIED: 27-CONTEXT.md] |
| V3 Session Management | Yes | Identity-keyed records, no cross-identity legacy adoption, explicit temporary session state. [VERIFIED: 27-CONTEXT.md] |
| V4 Access Control | Yes | Keep room deletion/leave, admission, and transport authority in existing coordinator/room stores; the UI only invokes existing callbacks. [VERIFIED: src/coordinator/coordinator.svelte.ts; 27-CONTEXT.md] |
| V5 Input Validation | Yes | Validate IDB envelope/version/snapshot shape and normalized key before restoration; treat browser storage as untrusted. [VERIFIED: src/cordn/coordinator/storage/inMemoryStorage.ts] [ASSUMED] |
| V6 Cryptography | Yes | Do not decrypt/re-encode storage records in presentation code; retain existing MLS/key-manager and never log material. [VERIFIED: AGENTS.md; 27-CONTEXT.md] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Corrupt/tampered local record drives unsafe restore | Tampering | Zod/version validation before restore, bounded recovery, explicit destructive deletion, no raw error UI. [ASSUMED] |
| Global legacy snapshot becomes another identity's authority | Elevation of Privilege | Exact normalized pubkey primary key; no automatic unscoped migration. [VERIFIED: 27-CONTEXT.md] |
| Error/debug output contains secrets or prior identity | Information Disclosure | Typed generic failures and assertions that UI/logs omit storage payload, identity, invite, and decrypted text. [VERIFIED: AGENTS.md; 27-UI-SPEC.md] [ASSUMED] |
| Duplicate queued write or stop race loses latest mutation | Repudiation / Availability | Serialized writer, transaction-complete promise, flush-before-success, explicit stop-without-saving confirmation. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event] [VERIFIED: 27-UI-SPEC.md] [ASSUMED] |
| Background UI remains active beneath a sheet | Elevation of Privilege / Tampering | One modal stack, `inert`, focus trap, safe scrim dismissal; destructive actions require named confirmation. [VERIFIED: 27-UI-SPEC.md] [ASSUMED] |

## Sources

### Primary (HIGH confidence)

- `src/cordn/coordinator/storage/browserSqliteStorage.ts`, `src/cordn/coordinator/storage/inMemoryStorage.ts`, `src/lib/transport.ts`, `src/coordinator/coordinator.svelte.ts` — current persistence, mutation, start/stop, and deletion seams. [VERIFIED: codebase graph + source]
- `src/components/HostWorkspace.svelte`, `src/components/ChatRoute.svelte`, `src/components/WorkspaceNav.svelte`, `src/components/CoordinatorRoomCard.svelte`, `src/components/RoomActionsMenu.svelte`, `src/lib/viewport-overlay.ts` — current host/guest/mobile/overlay behavior. [VERIFIED: codebase graph + source]
- `27-CONTEXT.md`, `27-UI-SPEC.md`, `.planning/REQUIREMENTS.md`, `AGENTS.md` — locked product, UI, quality, and security constraints. [VERIFIED: project planning artifacts]

### Secondary (MEDIUM confidence)

- [MDN: Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) — asynchronous open/upgrade, transaction lifecycle, errors and concurrency.
- [MDN: IDBTransaction complete](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event) — completion means successful transaction commit.
- [MDN: VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) — mobile resize/scroll events and visual viewport positioning.
- [MDN: pointer media feature](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/pointer), [MDN: env()](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env), [MDN: dynamic viewport units](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length) — coarse pointer, safe area, and dynamic viewport semantics.
- [Playwright: Emulation](https://playwright.dev/docs/emulation), [Playwright: Locator.tap](https://playwright.dev/docs/api/class-locator#locator-tap) — device/touch configuration and tap requirement.
- [SQLite WASM persistence](https://sqlite.org/wasm/doc/trunk/persistence.md) — KVVFS localStorage/main-thread and quota limitations.

### Tertiary (LOW confidence)

- None; all non-source implementation choices are marked `[ASSUMED]` for planner confirmation.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH for existing dependencies and current implementation; MEDIUM for web API behavior from official docs.
- Architecture: HIGH for present seams; MEDIUM for the proposed extraction/flush ownership because exact API shape is yet to be designed.
- Pitfalls: HIGH for currently observed localStorage/hover/desktop-test gaps; MEDIUM for browser-specific test injection details.

**Research date:** 2026-08-07  
**Valid until:** 2026-09-06 for stable browser APIs; recheck Playwright device labels immediately before implementation.
