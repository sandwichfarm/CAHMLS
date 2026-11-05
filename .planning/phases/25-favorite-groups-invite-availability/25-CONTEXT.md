# Phase 25 Context: Favorite Groups & Invite Availability

## Decisions

- A favorite is scoped by the composite room identity `coordinatorPubkey + roomId`; titles and invite URLs are not identity.
- Favoriting duplicates the room above coordinator cards under a `Favorites` heading. The source row remains visible in its coordinator card.
- The row star is hidden at rest for non-favorites, revealed for hover and keyboard focus, and remains visible when selected. The three-dot menu always includes the same toggle.
- Both the source row and duplicate can remove the favorite. Removal never leaves or deletes the room.
- Invite coordinator availability is supplied by the workspace’s existing reachability state. Only `online` enables Join; `connecting`, `offline`, and `unknown` are disabled.
- Disabled invites keep their content visible but subdued. Hover uses `cursor: not-allowed`, and both a tooltip and screen-reader description say `Coordinator is offline`.

## Non-goals

- Favorites do not sync between devices or identities.
- Favorites do not reorder coordinator cards or remove rooms from their original coordinator.
- Offline invite disabling is a UX availability rule, not cryptographic access control.
- Cached group navigation remains available even when a remote coordinator is offline.

## Evidence

- Unit coverage proves persistence, composite identity, malformed storage recovery, and removal.
- Browser coverage proves row/menu toggles, duplicate placement, persistence after reload, no loss of the original row, and disabled-to-enabled invite transitions.
