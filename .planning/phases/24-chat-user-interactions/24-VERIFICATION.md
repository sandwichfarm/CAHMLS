---
phase: 24-chat-user-interactions
verified: 2026-08-07T00:12:00Z
status: passed
score: 30/30 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 25/30
  gaps_closed:
    - "Signed recipient metadata produces exact-viewer mention emphasis in both host and invitee chat surfaces."
    - "In-room invite targeting sends the selected active room's canonical invite only to the chosen participant."
    - "The App lifecycle owns exactly one active-identity kind-3 query/subscription and resets it on identity changes."
    - "Mention retains structured recipients after the visible token is edited and restores text plus targets after a failed send in both composers."
    - "Ignore disclosures preserve target filtering and all message presentation invariants after expansion in both panes."
  gaps_remaining: []
  regressions: []
---

# Phase 24: Chat User Interactions Verification Report

**Phase Goal:** Participants can address, personalize, moderate, invite, and follow people directly from the encrypted conversation without leaking targeted invite presentation to unrelated viewers.
**Verified:** 2026-08-07T00:12:00Z
**Status:** passed
**Re-verification:** Yes — after Plan 24-06 behavioral closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Non-self authors have one accessible, parity-preserving action menu. | ✓ VERIFIED | One shared `MessageGroup`; host/guest browser tests prove action parity, keyboard entry, focus/dismissal, 44px targets, and stable message geometry. |
| 2 | Signed kind-9 `p` tags drive mention emphasis and targeted-invite visibility; untagged invites are public. | ✓ VERIFIED | Recipient/projection units plus real three-member transport prove authenticated targeting and public/targeted projection. |
| 3 | Exact-room ignores collapse reversibly and private highlights survive reload without shared-message changes. | ✓ VERIFIED | Store units and host/guest browser evidence prove sparse local persistence, independent disclosures, named selected state, and reload. |
| 4 | Another active room can be selected and its current invite sent solely to the chosen participant. | ✓ VERIFIED | Real production chooser/send/decrypt test asserts the canonical selected-room URL, one recipient, valid auth, and non-target absence. |
| 5 | The active identity loads and live-maintains only the newest valid self-authored kind-3 event, and follow publication safely preserves its prior contact-list data. | ✓ VERIFIED | Mounted-App lifecycle E2E plus social-store race/order/relay-acceptance units pass. |
| 6 | Signed recipients round-trip through send, MLS encryption/decryption, persistence, and legacy decoding. | ✓ VERIFIED | Recipient protocol unit coverage and recipient-side real-session stored-message assertions pass. |
| 7 | Recipient mutation fails authentication and reactions cannot carry ordinary recipients. | ✓ VERIFIED | Authentication mutation and reaction-isolation unit cases pass. |
| 8 | Mention emphasis is exact-viewer only on the shared renderer. | ✓ VERIFIED | Real host target plus target/non-target invitee contexts prove one host marker and ordinary non-target rendering. |
| 9 | Non-target valid invites disappear before grouping and leave no render/layout artifact. | ✓ VERIFIED | Projection units, prior DOM/geometry browser assertions, and real non-target invite absence pass. |
| 10 | Editable names never determine recipients; malformed targets remain legacy-compatible absence. | ✓ VERIFIED | Array-only canonical normalization and real edited-visible-text delivery retain the structured target. |
| 11 | Ignore identity is exactly coordinator + room + participant, with no cross-coordinator collision. | ✓ VERIFIED | Composite-key store implementation and identity-boundary units pass. |
| 12 | Default preference state is sparse and clearing removes entries. | ✓ VERIFIED | Store clear/reload tests prove sparse deletion and map isolation. |
| 13 | Highlights are global-by-participant, palette-constrained, and isolated from ignores. | ✓ VERIFIED | Typed palette and persistence/corruption/isolation tests pass. |
| 14 | Preference persistence contains no message, invite, transport, decrypted, or signer material. | ✓ VERIFIED | Serializer emits only versioned preference identities and palette names; sensitive-field tests pass. |
| 15 | App starts/resets exactly one valid own-kind-3 owner across identity lifecycle changes. | ✓ VERIFIED | Mounted lifecycle test proves zero → A → zero → B → zero ownership and rejects valid stale-A ingress after B replacement. |
| 16 | Empty ingress stays reconnectable and failed refresh preserves validated contact state. | ✓ VERIFIED | Focused social-store tests pass. |
| 17 | Only valid, own, current-generation kind-3 events enter state, in deterministic order. | ✓ VERIFIED | Signature/author/generation/order and stale callback tests pass. |
| 18 | Follow serializes refresh, lossless merge, canonical dedupe, newer signing, and relay-accepted commit. | ✓ VERIFIED | Social unit tests cover concurrent follow, preservation, pending echo, acceptance, failure, and replacement generation. |
| 19 | Anonymous viewers cannot imitate a follow locally and receive sign-in guidance. | ✓ VERIFIED | Shared menu disables Follow with exact guidance; browser evidence passes. |
| 20 | Every visible non-self streak has one trigger; self streaks have none. | ✓ VERIFIED | Shared self branch and browser assertions pass. |
| 21 | Menu ordering, focus entry, dismissal, and focus restoration are correct. | ✓ VERIFIED | Browser tests cover ordered actions, Enter, outside focus/click, Escape, chooser success, and focus return. |
| 22 | Mention preserves structured targets through text editing and failed sends in both composers. | ✓ VERIFIED | Production host and invitee signer-rejection test restores exact edited text, then retries and verifies recipient-side canonical p metadata. |
| 23 | Ignore generates independent reversible disclosures without changing shared room data. | ✓ VERIFIED | Authenticated-host test expands separated streaks after a filtered invite, preserving independent state and hidden-invite absence. |
| 24 | Follow UI reports pending/error/success only from the acceptance-aware API. | ✓ VERIFIED | Shared UI fixture and relay-acceptance social tests pass. |
| 25 | Highlight applies privately and persists without replacing Mentioned you or reducing message text contrast. | ✓ VERIFIED | Shared presentation/store plus selected-state/reload browser assertions pass. |
| 26 | Participant trigger and interface meet the approved 44px accessibility contract. | ✓ VERIFIED | Shared CSS and host/guest geometry checks pass. |
| 27 | Participant UI uses the locked visual token contract. | ✓ VERIFIED | Computed-style browser checks prove the approved roles, weights, surfaces, and compact 16px side insets. |
| 28 | Ignore/highlight selection feedback is visibly present and persistent. | ✓ VERIFIED | Visible Show/Hide, `Highlight: {Name}`, `aria-pressed`, non-color selected marker, focus return, reopening, reload, and clear are tested. |
| 29 | No targeted-invite capability or private material is rendered or logged by Phase 24 UI. | ✓ VERIFIED | Visibility-first production projection, secret-free test fixture, privacy scan, and real public-transport boundary checks pass. |
| 30 | Self-directed participant actions are never exposed. | ✓ VERIFIED | The shared `mine` branch omits action controls and browser coverage confirms it. |

**Score:** 30/30 truths verified (0 present-but-behavior-unverified).

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/chat/protocol.ts` | Signed canonical recipient metadata | ✓ VERIFIED | Normalization/auth/event conversion is substantive and covered through MLS + production transport. |
| `src/chat/room-store.ts` | Queued recipient-aware send | ✓ VERIFIED | Normalizes, signs, encrypts, persists, and synchronizes in the production queue. |
| `src/chat/message-presentation.ts` | Visibility-first and ignore projection | ✓ VERIFIED | Both panes project before keyed rendering; real host expansion verifies composed behavior. |
| `src/chat/chat-participant-preferences.svelte.ts` | Private exact-room/global preference store | ✓ VERIFIED | Defensive sparse local-only persistence; no wire/shared-data mutation. |
| `src/invites/nostr-social.svelte.ts` | Valid kind-3 state and safe follow | ✓ VERIFIED | Generation-safe reducer and relay-accepted follow are covered by units and mounted-App evidence. |
| `src/App.svelte` | Identity lifecycle binding | ✓ VERIFIED | Existing effect is mounted in lifecycle E2E; its E2E-only observation seam is absent from the normal production build. |
| `src/components/MessageGroup.svelte` | Shared participant surface | ✓ VERIFIED | One production surface provides menu, chooser, feedback, highlight, ignore, and mention presentation. |
| `src/components/HostWorkspace.svelte` / `src/components/ChatRoute.svelte` | Parity callbacks and production composer paths | ✓ VERIFIED | Real host/invitee retries, send/decrypt, chooser, and projections are exercised. |
| `tests/e2e/chat-user-interactions-fixture.ts` | Secret-safe real-session test controls | ✓ VERIFIED | Page-lifetime in-memory NIP-07/social fixture observes recipient storage, not relay ciphertext or key material. |
| `tests/e2e/chat-user-interactions.spec.ts` | Phase browser proof | ✓ VERIFIED | Contains direct tests for all five formerly human-needed runtime invariants. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `room-store.ts` | `protocol.ts` | recipient normalization/sign/encrypt | ✓ WIRED | Recipient metadata stays inside `runExclusive` and authenticated envelopes. |
| `protocol.ts` | `MessageGroup.svelte` | stored decrypted recipients → exact viewer | ✓ WIRED | Real host/target/non-target sessions exercise the shared renderer. |
| `message-presentation.ts` | host/invitee logs | pre-layout visibility and ignore projection | ✓ WIRED | Both panes call the projector before keyed streak rendering. |
| preferences store | parents / `MessageGroup` | local ignores and global highlight | ✓ WIRED | Exact-room ignore and typed highlight flow into real presentation. |
| `App.svelte` | social store | authenticated lifecycle effect | ✓ WIRED | Mounted E2E observes start/cleanup across logout/replacement. |
| social store | Nostr relays | validation/reduction/accepted publish | ✓ WIRED | `verifyEvent` and acceptance-gated publish remain on the production path. |
| shared menu | host/invitee parents | typed participant callbacks | ✓ WIRED | One callback contract is exercised by both production panes. |
| host/invitee parents | `room-store.ts` | selected-room invite → sole recipient send | ✓ WIRED | Real chooser produces recipient-side canonical stored invite metadata. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `MessageGroup.svelte` | `message.recipientPubkeys` | signed/decrypted stored envelope | Canonical authenticated metadata | ✓ FLOWING |
| host/invitee logs | projected streaks | room messages → visibility filter → ignore predicate | Actual connected room data plus local preferences | ✓ FLOWING |
| participant chooser | `participantRooms` | active `listRooms()` choices | Current room metadata, revalidated at dispatch | ✓ FLOWING |
| social store | contact identity/following | verified query/subscription reducer | Valid current-identity kind-3 events | ✓ FLOWING |
| preferences | ignore/highlight maps | versioned browser storage | Sparse local-only data | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Real target mention and selected-room invite transport | `CI=1 PLAYWRIGHT_PORT=4316 pnpm exec playwright test tests/e2e/chat-user-interactions.spec.ts --grep "real targeted message and room invite cross production transport" --workers=1` | Pass (current recheck: 20.1s) | ✓ PASS |
| Composer edit/failure/retry in both panes | `CI=1 PLAYWRIGHT_PORT=4317 pnpm exec playwright test tests/e2e/chat-user-interactions.spec.ts --grep "both composers restore edited mentions after signer failure" --workers=1` | Pass (20.9s) | ✓ PASS |
| Authenticated-host filtered ignore expansion | `CI=1 PLAYWRIGHT_PORT=4320 pnpm exec playwright test tests/e2e/chat-user-interactions.spec.ts --grep="authenticated host expands filtered ignored streaks" --workers=1` | Pass (20.5s) | ✓ PASS |
| Mounted App kind-3 lifecycle | `CI=1 PLAYWRIGHT_PORT=4321 pnpm exec playwright test tests/e2e/chat-user-interactions.spec.ts --grep="App owns one current kind-3 lifecycle across logout and replacement" --workers=1` | Pass (0.9s) | ✓ PASS |
| Full browser suite | `pnpm test:e2e` | 110 passed; one unrelated existing invite-redemption timeout, whose isolated rerun passed 1/1 in 11.9s | ℹ️ NOT A PHASE 24 FAILURE |
| Lint, types, build, build seam, diff integrity | `pnpm lint && pnpm exec tsc --noEmit && pnpm build && ! rg 'contact-lifecycle-probe' dist && git diff --check` | Passed; normal build omits E2E probe | ✓ PASS |
| Full units / Cordn parity / interoperability | `pnpm test`, `pnpm check:upstream`, `pnpm test:upstream-interop` | 347 unit passed; parity 11 methods/7 schemas; interop 3 passed (current completion evidence) | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| USER-01 | 24-04/24-05 | Shared accessible participant actions | ✓ SATISFIED | Shared menu, 44px geometry, focus, keyboard, and self-exclusion evidence. |
| MENTION-01 | 24-01/24-04/24-06 | Editable signed mention | ✓ SATISFIED | Both real composers recover edited text and deliver exact canonical recipients. |
| MENTION-02 | 24-01/24-06 | Exact-viewer emphasis in both panes | ✓ SATISFIED | Real host target/non-target contexts prove the presentation rule. |
| INVMSG-01 | 24-01/24-06 | Public/targeted invite projection | ✓ SATISFIED | Unit/browser projection plus real target/non-target production transport evidence. |
| IGNORE-01 | 24-02/24-04/24-05/24-06 | Exact-room reversible disclosures | ✓ SATISFIED | Persistence, visible feedback, independent authenticated-host expansion, and filtered-invite absence pass. |
| INVUSER-01 | 24-04/24-06 | Selected-room targeted invite | ✓ SATISFIED | Production chooser creates/decrypts canonical sole-recipient invite. |
| FOLLOW-01 | 24-03/24-06 | Valid live kind-3 lifecycle | ✓ SATISFIED | Mounted App test proves ownership transitions and stale-A rejection. |
| FOLLOW-02 | 24-03 | Safe serialized follow publication | ✓ SATISFIED | Merge/order/sign/relay-acceptance/failure unit evidence. |
| HILITE-01 | 24-02/24-04/24-05 | Private persisted highlight | ✓ SATISFIED | Palette/store plus persistent named selected-state browser evidence. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| Phase 24 production/test files | — | `TBD` / `FIXME` / `XXX` | ✓ NONE | No unresolved debt marker found. |
| Normal production build | — | E2E-only probe/harness markers | ✓ NONE | Build artifact contains neither lifecycle probe nor test harness marker. |
| Full browser suite | — | Existing invite-redemption timeout | ℹ️ INFO | Outside Phase 24 scope; the exact test immediately passed in isolated rerun. |
| Build dependencies | — | Rolldown pure-annotation/chunk-size notices | ℹ️ INFO | Build succeeds; warnings are upstream/pre-existing and unrelated to Phase 24. |

### Gaps Summary

All prior UI and behavioral verification gaps are closed. Plan 24-06 replaces callback/static evidence with real production chat transport, both production composer rollback paths, authenticated host projection, and a mounted App lifecycle test. No Phase 24 must-have, artifact, wiring link, prohibition, or requirement remains failed or behavior-unverified.

---

_Verified: 2026-08-07T00:12:00Z_
_Verifier: the agent (gsd-verifier)_
