# Deferred Items

- Full `workspace-lifecycle.spec.ts` run: the pre-existing invite-only delivery scenario timed out waiting for its shared-invite action after the guest room became offline (`tests/e2e/workspace-lifecycle.spec.ts:2259`). The failure is outside this plan's IndexedDB/storage lifecycle paths; the focused storage stop lifecycle case passed.
