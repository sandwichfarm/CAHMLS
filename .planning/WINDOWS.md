---
schema_version: 1
open_count: 8
waived_count: 0
fixed_count: 0
total_count: 8
last_updated: 2026-08-06T22:13:03.599Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 15 | deviation | src/identity/anonymous-identity.ts |  | Verified persisted writes through the strict parser | open |  | 2026-08-02T16:00:06.156Z |  |
| 2 | 15 | deviation | src/components/UserProfile.svelte |  | Removed coordinator-to-profile prop path required for durable anonymous identity | open |  | 2026-08-02T16:00:06.218Z |  |
| 3 | 15 | deviation | tests/unit/user-profile.test.ts |  | Avoided raw persisted credential values in assertion diagnostics | open |  | 2026-08-02T16:00:06.284Z |  |
| 4 | 15 | unrun-verify | tests/e2e/phase-one.spec.ts | 406 | Full Playwright suite remains blocked by the unrelated narrow-viewport operator-shell height assertion. | open |  | 2026-08-02T16:26:18.963Z |  |
| 5 | 21 | deviation | tests/e2e/nip07-session-restoration.spec.ts |  | Profile browser suites require a completed-setup fixture after Phase 21 hides UserProfile on incomplete fresh installs. | open |  | 2026-08-05T11:23:07.105Z |  |
| 6 | 24 | unrun-verify | tests/e2e/workspace-lifecycle.spec.ts |  | Full pnpm test:e2e could not complete because the shared mock relay port 8765 was occupied and the clean retry left a Playwright worker running; rerun at Phase 24 close-out. | open |  | 2026-08-06T18:47:59.271Z |  |
| 7 | 24 | unrun-verify | tests/e2e |  | Complete pnpm test:e2e left a worker running; focused Phase 24 browser coverage passed. | open |  | 2026-08-06T19:04:57.470Z |  |
| 8 | 24 | deviation | src/components/MessageGroup.svelte |  | Removed raw participant and room identifiers from affected DOM IDs while preserving focus restoration. | open |  | 2026-08-06T22:13:03.599Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "15",
    "file": "src/identity/anonymous-identity.ts",
    "line": null,
    "description": "Verified persisted writes through the strict parser",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-02T16:00:06.156Z",
    "resolved_at": null
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "15",
    "file": "src/components/UserProfile.svelte",
    "line": null,
    "description": "Removed coordinator-to-profile prop path required for durable anonymous identity",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-02T16:00:06.218Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "15",
    "file": "tests/unit/user-profile.test.ts",
    "line": null,
    "description": "Avoided raw persisted credential values in assertion diagnostics",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-02T16:00:06.284Z",
    "resolved_at": null
  },
  {
    "id": 4,
    "kind": "unrun-verify",
    "phase": "15",
    "file": "tests/e2e/phase-one.spec.ts",
    "line": 406,
    "description": "Full Playwright suite remains blocked by the unrelated narrow-viewport operator-shell height assertion.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-02T16:26:18.963Z",
    "resolved_at": null
  },
  {
    "id": 5,
    "kind": "deviation",
    "phase": "21",
    "file": "tests/e2e/nip07-session-restoration.spec.ts",
    "line": null,
    "description": "Profile browser suites require a completed-setup fixture after Phase 21 hides UserProfile on incomplete fresh installs.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T11:23:07.105Z",
    "resolved_at": null
  },
  {
    "id": 6,
    "kind": "unrun-verify",
    "phase": "24",
    "file": "tests/e2e/workspace-lifecycle.spec.ts",
    "line": null,
    "description": "Full pnpm test:e2e could not complete because the shared mock relay port 8765 was occupied and the clean retry left a Playwright worker running; rerun at Phase 24 close-out.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-06T18:47:59.271Z",
    "resolved_at": null
  },
  {
    "id": 7,
    "kind": "unrun-verify",
    "phase": "24",
    "file": "tests/e2e",
    "line": null,
    "description": "Complete pnpm test:e2e left a worker running; focused Phase 24 browser coverage passed.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-06T19:04:57.470Z",
    "resolved_at": null
  },
  {
    "id": 8,
    "kind": "deviation",
    "phase": "24",
    "file": "src/components/MessageGroup.svelte",
    "line": null,
    "description": "Removed raw participant and room identifiers from affected DOM IDs while preserving focus restoration.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-06T22:13:03.599Z",
    "resolved_at": null
  }
]
````
