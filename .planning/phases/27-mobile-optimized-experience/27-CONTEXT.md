---
phase: 27-mobile-optimized-experience
requirements: [MOBILE-01, MOBILE-02, MOBILE-03, MOBILE-04, MOBILE-05, MOBILE-06, MOBILE-07]
status: specified
---

# Phase 27 Context

CAHMLS must become a complete browser-resident mobile coordinator, not merely a desktop layout rendered at a narrow width. The stop condition is outcome-based: coordinator startup, chats, and every supported interaction work on mobile by touch; automated coverage is pushed; and a pull request is open.

## Locked product decisions

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

## Evidence from the current implementation

- `CoordinatorRoomCard.svelte` reveals offline rooms through pointer-enter or focus-within state; its summary is not an actionable control, so an ordinary touchscreen tap cannot reveal the rooms.
- Favorite discovery and several reaction controls are visually hover-dependent or substantially smaller than the required touch target.
- The host rail already has a partial off-canvas implementation at 900px, but mobile behavior is split between host-only rail state and a separate guest room-switcher. Phase 27 consolidates the interaction model and proves close/focus/navigation behavior.
- Existing narrow-viewport Playwright tests use the desktop Chrome device profile. There are no touch-enabled projects, `.tap()` calls, `hasTouch`, mobile Safari/WebKit, mobile Chromium, or virtual-keyboard viewport tests.
- `browserSqliteStorage.ts` opens sqlite-wasm `:localStorage:` KVVFS on the main thread. Its fallback writes the same full snapshot as JSON to `localStorage`; access denial, quota exhaustion, corruption, and synchronous rewrite cost therefore affect both paths.
- The current snapshot mutation callback is synchronous. IndexedDB requires a serialized asynchronous persistence owner and an explicit flush/close boundary threaded through transport stop and startup rollback.

## Mobile acceptance journeys

1. Fresh phone setup: choose anonymous or authenticated identity, name the coordinator, start it, observe truthful progress, create a room, stop, restart, and reload without identity or room loss.
2. Host and invitee: generate/open an invite, request and approve admission, exchange encrypted messages and reactions both ways, navigate rooms, use participant and room actions, and recover after offline/reload transitions.
3. Personal controls: use profile and presence, notification feed/settings, sound/channel overrides, invitation actions, Favorites, History, and identity rotation entirely by tap.
4. Responsive resilience: repeat critical actions on small portrait, landscape, and short-height viewports; open the composer or a form with a reduced visual viewport; scroll long room/message lists; dismiss overlays by their visible control and outside tap.
5. Storage resilience: prove IndexedDB restore, ordered writes, flush-on-stop, denied/open/write/quota failures, corrupt legacy data, safe identity scoping, and explicit temporary operation.

## Non-goals

- Native iOS/Android packages, push-notification backends, gesture-only shortcuts, or a new visual brand.
- Changes to Cordn protocol semantics or weakening encrypted-room authority to make mobile tests easier.
- Claiming mobile support from resized desktop tests alone.
