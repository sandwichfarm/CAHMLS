---
phase: 25-favorite-groups-invite-availability
verified: 2026-08-07T01:50:48Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/6
  gaps_closed:
    - "Collapsed favorite sources remain rendered and receive deterministic focus after duplicate removal."
    - "Invite-only coordinators are probed from rendered shared messages and can enable Join when online."
    - "Unavailable invite descriptions have component-unique opaque IDs."
    - "Favorite reveal handoff clears after expanding the matching source card, with a second hidden favorite opening through the shared primary action."
  gaps_remaining: []
  regressions: []
---

# Phase 25: Favorite Groups & Invite Availability Verification Report

**Phase Goal:** Frequently used groups stay one click away without leaving their coordinator grouping, and room invites never imply that an offline coordinator can currently be joined.
**Verified:** 2026-08-07T01:50:48Z
**Status:** passed
**Re-verification:** Yes — after gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Every active group exposes an accessible 44px star on hover/focus and the same first-position room-menu action; its exact favorite state persists. | ✓ VERIFIED | One `CoordinatorRoomCard` renders the 44px `aria-pressed` star and passes the same callback to `RoomActionsMenu`; ledger unit tests and focused menu/star/reload browser tests pass. |
| 2 | Favorites appear above coordinator cards while their exact source rows remain; unfavoriting removes only the duplicate and returns focus safely. | ✓ VERIFIED | `favoriteRoomItems` projects above `.coordinator-card-list`; `revealRoomKey` forces a collapsed source to render before post-removal focus. The six-room browser regression passes. |
| 3 | Favorite duplicates preserve source navigation, active rail, unread/owner/preferences, and non-favorite room actions without changing coordinator order. | ✓ VERIFIED | Source and Favorites are the same `CoordinatorRoomCard` with the same props/callbacks. The seven-room regression opens a second previously-hidden Favorites duplicate through its primary action and verifies the matching source row becomes active; existing menu/star scenarios exercise the shared action surfaces. |
| 4 | A shared invite is actionable only for its exact `online` coordinator; non-online remains disabled and an online transition restores the established Join navigation. | ✓ VERIFIED | `reachabilityTargets()` parses rendered host and embedded invite messages, merges their public relay hints, and re-probes message updates. Browser tests prove disabled → online → enabled → existing autojoin navigation in both embedded and host paths. |
| 5 | Disabled invites are neutral/subdued, not-allowed, and expose exact offline copy by tooltip and unambiguous accessible description. | ✓ VERIFIED | `MessageGroup` fails closed to `unknown`, uses disabled/title/description/CSS unavailable state, and uses `$props.id()` in the opaque description ID. Browser tests verify cursor, copy, and two-streak unique resolving IDs. |
| 6 | Favorite persistence contains only validated composite room keys; no favorite metadata or sensitive invite/message material is introduced into sidebar storage or logs. | ✓ VERIFIED | Parser accepts unique `<64-hex-pubkey>\\0<nonempty-room-id>` values only; mutation uses `roomIdentityKey`; reconciliation retains active exact keys only. The phase diff adds no logging. |

**Score:** 6/6 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/chat/sidebar-ledger.ts` | Validated composite persistence/mutation/reconciliation | ✓ VERIFIED | Substantive, imported by workspace, and covered by 5 passing focused unit tests. |
| `src/components/CoordinatorRoomCard.svelte` | Shared source/favorite row renderer | ✓ VERIFIED | Renders both variants; `revealRoomKey` preserves a collapsed source for removal/focus. |
| `src/components/RoomActionsMenu.svelte` | First-position favorite action | ✓ VERIFIED | Favorite action remains first, shares callback, and has reduced-motion override. |
| `src/components/HostWorkspace.svelte` | Favorites projection and exact reachability resolver | ✓ VERIFIED | Traces storage → reconciliation → projection and parsed displayed invites → probe targets → resolver. |
| `src/components/MessageGroup.svelte` | Reactive online-only invite action | ✓ VERIFIED | Shared renderer defaults unknown, enables only online, and uses component-unique unavailable descriptions. |
| `src/components/ChatRoute.svelte` | Embedded availability forwarding | ✓ VERIFIED | Typed workspace resolver is forwarded without independently inferring availability. |
| `tests/unit/sidebar-ledger.test.ts` | Ledger recovery/composite identity evidence | ✓ VERIFIED | 5 tests passed. |
| `tests/e2e/workspace-lifecycle.spec.ts` | Browser proof for favorites/invites | ✓ VERIFIED | 6 targeted Phase 25 scenarios passed, including all prior failed paths. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `HostWorkspace.svelte` | `sidebar-ledger.ts` | Parse/reconcile/serialize at `SIDEBAR_LEDGER_KEY` | WIRED | Storage loads into `reconcileSidebarLedger`, feeds active/favorite projections, and persists exact-key mutation. |
| `CoordinatorRoomCard.svelte` | `RoomActionsMenu.svelte` | Shared favorite boolean/callback | WIRED | Star and menu receive the same room identity and `onFavorite` callback. |
| `HostWorkspace.svelte` | `MessageGroup.svelte` | Workspace reachability resolver | WIRED | Workspace parses displayed invite messages into probe targets and passes the exact resolver to host messages. |
| `ChatRoute.svelte` | `MessageGroup.svelte` | Embedded resolver forwarding | WIRED | `ChatRoute` forwards the workspace resolver to the invitee message renderer. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `HostWorkspace.svelte` | `sidebarLedger`, `activeSidebarRooms`, `favoriteRoomItems` | Browser storage + `listRooms()` → `reconcileSidebarLedger()` | Stored rooms and validated exact identities | ✓ FLOWING |
| `CoordinatorRoomCard.svelte` | `rooms`, `favoriteRoomKeys`, `revealRoomKey` | Workspace active/favorite projections | Actual room data and removal target | ✓ FLOWING |
| `HostWorkspace.svelte` / `MessageGroup.svelte` | reachability targets → `inviteOnline` | Parsed displayed invite content + public relay hints → heartbeat probe → exact resolver | Runtime online/offline state | ✓ FLOWING |
| `ChatRoute.svelte` | `inviteCoordinatorReachability` | Workspace prop | Same live resolver reaches embedded message renderer | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Ledger parsing, exact identity, malformed recovery, stale cleanup | `pnpm exec vitest run tests/unit/sidebar-ledger.test.ts` | 5 passed | ✓ PASS |
| Menu/star/reload, one-shot collapsed-source handoff plus duplicate primary navigation, embedded+host invite re-probe/autojoin, unique descriptions | Focused six-test Phase 25 browser run | 6 passed in current execution evidence | ✓ PASS |
| Type safety and whitespace | `pnpm exec tsc --noEmit && git diff --check` | passed | ✓ PASS |

The verifier's repeat of the browser command was blocked before test setup by an active, unrelated Playwright worker holding the suite's fixed mock-relay port 8765 (`EADDRINUSE`). This is an external runner collision, not an application assertion failure; the current focused-pass evidence and clean re-review cover the final commit.

### Probe Execution

Step 7c: SKIPPED — no Phase 25 probe is declared and no conventional repository probe exists.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| FAV-01 | `25-01-PLAN.md` | Accessible row/menu favorite controls with exact persisted identity | ✓ SATISFIED | Shared control wiring plus unit and focused browser evidence. |
| FAV-02 | `25-01-PLAN.md` | Favorites duplicate above coordinator sections while sources remain; duplicate-only unfavorite | ✓ SATISFIED | Projection, six-room collapsed-source/focus regression, and persistence evidence. |
| INVMSG-02 | `25-01-PLAN.md` | Exact-online-only actionable invite; disabled availability presentation | ✓ SATISFIED | Host and embedded disabled-to-online/autojoin tests plus unique accessible-description regression. |

No orphaned Phase 25 requirements: roadmap and plan both map exactly FAV-01, FAV-02, and INVMSG-02.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| — | — | No Phase 25-introduced debt marker, placeholder/stub, empty implementation, or console-only handler found. | — | No blocker |

## Visual Evidence Note

Authenticated screenshots of the Favorites and invite surfaces were not captured; the UI audit records this as a non-blocking visual-evidence limitation and otherwise gives **PASS WITH VISUAL-EVIDENCE LIMITATION** (22/24). Automated geometry, 320px containment, color/state, typography, spacing, reduced-motion, and runtime interaction checks cover the phase contract. Capture authenticated snapshots before release only if a separate human visual-signoff policy requires them.

## Gaps Summary

All prior gaps are closed; all roadmap success criteria and FAV-01, FAV-02, and INVMSG-02 are proven by implementation and focused automated evidence. No blocking human check remains.

---

_Verified: 2026-08-07T01:50:48Z_
_Verifier: the agent (gsd-verifier)_
