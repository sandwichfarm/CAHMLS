# Phase 24: Chat User Interactions — Context

## Goal

Make the author identity in each encrypted conversation actionable: mention, ignore, invite to another group, follow on Nostr, or apply a private persistent highlight.

## Locked product decisions

- The participant menu belongs to the visible author identity (name/avatar) and is available only for other participants, never for the viewer's own messages.
- Mentions remain editable human-readable composer text, but recipient identity is carried by signed structured metadata (`p` tags) so presentation does not depend on ambiguous names.
- A message explicitly mentioning the viewer is more prominent. A normal message mentioning someone else stays visually ordinary for the viewer.
- Invite messages use the same structured targets. Untagged invites are public to the room; tagged invites are rendered only for tagged viewers. Non-target viewers see no bubble, author row, or placeholder for that invite. This is a UX filter, not a confidentiality boundary.
- Mention tokens accompanying an invite are never rendered as chat text; the invite is represented only by its join action.
- Ignore state is private, local, persisted, and scoped to the exact `(coordinatorPubkey, roomId, participantPubkey)` identity. Each existing consecutive author streak becomes one centered disclosure with its message count and can be expanded independently.
- Invite-from-user opens a compact chooser of other active stored rooms, excluding the current room and retired history. Choosing a room sends its current canonical invite URL into the current conversation with the selected user's pubkey as the sole target.
- Follow modifies the signed-in operator's Nostr kind-3 contact list. Anonymous operators see the action disabled with sign-in guidance rather than silently creating a local-only follow.
- Contact-list ingress accepts only signature-valid kind-3 events authored by the active pubkey. Newest selection uses `created_at`, then event id as a deterministic tie-break. A live subscription keeps the selected event current.
- Follow publication is serialized, refreshes before mutation, preserves content and all unrelated tags, deduplicates `p` tags, signs a strictly newer replacement, and updates local state only after at least one relay accepts it.
- Highlight colors are private presentation preferences keyed by participant pubkey and persist locally across sessions. The palette is constrained to accessible theme-compatible accents and includes a clear/default choice.

## Interaction and accessibility

- Clicking or keyboard-activating the author identity opens the context menu; Escape closes it and focus returns to the trigger.
- Mention places focus in the composer and inserts `@display-name` at the caret when practical; sending retains the structured target even if the visible token is edited.
- Ignore summaries are buttons/disclosures with an explicit accessible name and `aria-expanded` state.
- Mention emphasis and highlights cannot rely on color alone; mentioned messages include an accessible “Mentioned you” label.
- Follow and invite actions expose pending, success, and actionable error states without logging message content, invite secrets, or private keys.

## Non-goals

- Targeted invite messages are not cryptographically hidden from other room members.
- This phase does not add blocking, reporting, moderation authority, server-side profiles, or cross-device preference synchronization.
- This phase does not rewrite historical plaintext mention text into structured targets.
