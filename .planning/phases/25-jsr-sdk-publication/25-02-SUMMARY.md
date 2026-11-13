---
phase: 25-jsr-sdk-publication
plan: 02
status: complete
requirements: [JSR-01, JSR-02]
---

# Type fidelity and parity gaps closed

Commit `3112ab1` restores exact baseline return types for five `CoordinatorAdapter` methods, including `NostrEvent`, required `invite_token: string | undefined`, and boolean subscription acknowledgements. Independent type equality and bidirectional compatibility checks pass for all 14 adapter methods. Runtime JavaScript is byte-identical to the pre-publication source.

The parity check's schema parser accepts optional explicit annotations before `z.object` initializers. Fixtures prove annotated and inferred shapes match, removed runtime fields remain observable, and absent schemas still throw. Live upstream parity and pinned interoperability pass. SDK type checks, package verification, lint, unit coverage, docs and builds pass. The phase remains incomplete because the license/publication gaps are separate and unresolved.
