---
phase: 26-offline-coordinator-room-disclosure
plan: "01"
status: complete
completed: 2026-08-07
requirements: [SIDE-07]
---

# Plan 26-01 Summary

Offline remote coordinator cards now rest as a compact, grammatical total count and omit their room controls from the DOM and accessibility tree. Hovering anywhere on the card or focusing its single group stop reveals the unchanged historical-room renderer; focus and pointer containment keep it open across room, favorite, continuation, and menu controls.

Entry uses only opacity and a 4px vertical transform for 150ms. Exit disables the fading subtree before removal, and reduced-motion users receive immediate transform-free insertion/removal. The existing five-room projection, active-room substitution, Favorites focus recovery, exact room navigation, and all non-eligible coordinator presentations remain unchanged.

Focused browser coverage proves singular/plural copy, keyboard and pointer traversal, normal/reduced motion, seven-room continuation behavior, 320px containment, favorite recovery, and existing sidebar navigation regressions.
