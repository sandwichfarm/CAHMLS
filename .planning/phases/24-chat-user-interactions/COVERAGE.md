# API Coverage — Nostr relay contact-list integration

> Full coverage by default for the external kind-3 capability surface used by this phase.

| capability | decision | reason |
|---|---|---|
| bounded query of the active identity's kind-3 events | INTEGRATE | |
| live subscription to active-identity kind-3 replacements | INTEGRATE | |
| NIP-01 signature and author validation | INTEGRATE | |
| deterministic replaceable-event selection | INTEGRATE | |
| full-list kind-3 merge/sign publication | INTEGRATE | |
| relay-acceptance-aware publication result | INTEGRATE | |
| kind-3 unfollow mutation | OPT-OUT | not requested in Phase 24; the context menu adds Follow only |
| relay discovery beyond configured social relays | OPT-OUT | existing configured social relay policy remains authoritative for this phase |
