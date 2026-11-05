---
phase: 24-sdk-extraction
plan: "01"
status: complete
requirements: [SDK-01, SDK-02, SDK-03, SDK-04, SDK-05, SDK-06, SDK-07]
completed: 2026-11-05
---

# Plan 24-01 Summary

Moved the coordinator, server, relay, crypto, MLS, and client modules to the framework-free `@cahmls/sdk` workspace package. Added `CoordinatorRuntime` with a `subscribe`/`getSnapshot` contract, and reduced `CoordinatorStore` to a Svelte binding over it. Added package verification and enforced coverage thresholds to CI, and VitePress guides with a TypeDoc reference.

Testing the extracted code exposed defects that are fixed with regression tests. They include lost messages around cursors and epoch changes, rooms that could not reconnect on ordinary networks, stuck lifecycle states, and resource leaks.

Deviations from the plan:

- The first relay fix lengthened attempt budgets and regressed startup. The browser suite caught this, and it was replaced by a bounded retry window.
- The mock relay moved to `127.0.0.1` on a free port, after a fixed port silently connected tests to an unrelated local process.

Deferred: #18, on storage behavior when persistence fails after an in-memory change.
