---
phase: 26-offline-coordinator-room-disclosure
requirements: [SIDE-07]
status: specified
---

# Phase 26 Context

Offline remote coordinator cards currently render every known room row, which burdens the sidebar even though those rooms cannot synchronize. Replace those rows at rest with a compact count summary: “1 chat offline” or “N chats offline.”

The card itself is the interaction boundary. Pointer hover and keyboard focus reveal the existing room rows, and moving from the summary into a row must not collapse the content. Revealed rows keep their established navigation and actions; this is presentation-only and must not mutate room history, favorites, ordering, or coordinator reachability.

Only remote coordinators in the exact `offline` state collapse. Local coordinator, Favorites, online, connecting, and unknown presentations remain unchanged. Motion must be restrained, use layout-safe properties, and become immediate under `prefers-reduced-motion: reduce`.
