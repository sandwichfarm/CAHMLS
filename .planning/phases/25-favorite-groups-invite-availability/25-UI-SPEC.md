# Phase 25 UI Specification

## Sidebar hierarchy

`Favorites` is a lightweight fieldset rendered immediately above `.coordinator-card-list` contents. It is absent when empty. It is the sidebar’s secondary navigation focal point; the active-room rail remains the primary selection cue. Favorite rows retain the active rail, unread badge, owner-avatar hover behavior, and three-dot actions. All active group rows intentionally grow from the legacy 36px minimum to a 44px minimum so the star target fits without overlap or clipping.

The favorite star is a 44px keyboard target on both source and duplicate rows. Non-selected stars use low-contrast outline styling and become visible on row hover or `:focus-within`. Selected stars use the existing green accent and remain visible. The accessible labels are `Favorite # {room}` and `Unfavorite # {room}`.

## Color roles

The existing green accent is reserved for the active-room rail, selected favorite stars, and keyboard focus. Ordinary row hover and unselected-star affordances use neutral existing sidebar colors. Existing red remains destructive-only and is not used by favorite or availability states. Offline invites use subdued neutral text/background/border colors rather than red because offline is unavailable, not destructive. The visual allocation follows the existing system’s approximate 60/30/10 distribution: base surfaces dominate, neutral structure/content supports them, and green accent is sparse.

## Typography and spacing

Reuse a constrained sidebar/menu scale: 8px metadata, 10px labels, 12px room/action text, and 14px overlay/action text; use regular (400) and semibold (600) weights only. Readable explanatory copy keeps at least 1.45 line-height.

Phase 25 layout spacing uses the existing 4, 8, 16, 24, 32, 48, and 64px grid. The 44px row/control minimum is an accessibility touch-target dimension, not a spacing token.

## Room actions menu

The first preference/action item is `Add to favorites` or `Remove from favorites`. Activating it updates both visible copies immediately and returns focus safely if the source duplicate disappears.

## Offline invite state

The invite card remains readable. The action has reduced contrast and no hover lift/border accent. Its containing availability surface supplies `title="Coordinator is offline"`, `cursor: not-allowed`, and an accessible description with identical text. Online transition restores the ordinary button without replacing surrounding message layout.

## Responsive and motion

Favorites use the same sidebar width and overflow rules as coordinator cards. No new horizontal scrolling is allowed at 320px. State transitions use the existing 150ms color/opacity timing and honor reduced motion.

## Registry and design-system safety

No third-party registry blocks are introduced. Phase 25 uses the repository’s existing manual Svelte design system, tokens, overlay primitive, room badges, unread badges, and menu structure.
