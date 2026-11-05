# Architecture

## Layers

```
                 ┌───────────────────────────────┐
 your UI ───────▶│ runtime   CoordinatorRuntime   │  lifecycle, leasing, recovery
                 └───────┬───────────────┬───────┘
                         │               │
                 ┌───────▼─────┐   ┌─────▼──────────┐
 your UI ───────▶│ client      │   │ server         │  ContextVM methods, abuse
                 │ rooms, MLS, │   │ TransportFactory│  protection, diagnostics
                 │ invites     │   └─────┬──────────┘
                 └───────┬─────┘         │
                         │         ┌─────▼──────────┐
                         │         │ coordinator    │  delivery service, storage
                         │         └────────────────┘
                 ┌───────▼─────────────────────────┐
                 │ relay  contracts  mls  crypto    │  shared foundations
                 └──────────────────────────────────┘
```

| Layer | Responsibility |
|---|---|
| `coordinator` | The Cordn delivery service: KeyPackages, Welcomes, join requests, and opaque group messages. It never sees plaintext. |
| `server` | Exposes the coordinator as ContextVM tools over Nostr, with rate limiting and key-package quotas. |
| `client` | Reaches a coordinator through its public contract, and manages MLS state for rooms. |
| `runtime` | Orchestrates a hosted coordinator: identity, single-instance lease, startup, room recovery, and profile publication. |
| `relay` | Bounded relay publishing with an optional local relay path. |
| `contracts` | Method names and Zod schemas for the Cordn wire contract. |
| `mls` | KeyPackage and Welcome codecs, and last-resort KeyPackage helpers. |
| `crypto` | Nostr signing and passphrase-encrypted key persistence. |

## Two ways to reach a coordinator

Rooms depend on the `ChatCoordinatorOperations` interface, which has two implementations:

- **`ChatCoordinatorClient`** speaks the public contract over Nostr, and works with any Cordn-compatible coordinator.
- **`LocalHostCoordinatorClient`** calls a coordinator in the same process, so a host's own rooms do not depend on relay latency.

## Message flow

1. A sender encrypts an MLS application message, seals it with the group's exporter secret, and adds it to `room.pending`.
2. The room is persisted before any network call, so a reload can retry delivery.
3. The session posts the opaque payload and receives its cursor.
4. Each sync fetches everything after `room.lastCursor` and decrypts it in order, skipping the session's own posts.

`lastCursor` moves only after a fetch. Advancing it when a post returns would skip messages other members sent in the meantime.

## Admission flow

1. A guest publishes a last-resort KeyPackage and stores a join request.
2. The host reads any delivered messages, because a commit makes messages from the older epoch unreadable.
3. The host consumes the exact KeyPackage named by the request, commits the addition, and posts the commit.
4. The Welcome goes into a durable outbox on the room before delivery, so a failed delivery is retried instead of stranding the guest.

## Design rules

- **No framework dependency.** The SDK imports no UI framework. Applications bind through `subscribe()` and `getSnapshot()`.
- **Injected side effects.** Notifications, room archiving, storage, and timers are supplied by the host application.
- **Relay-bounded operations.** Publishes have strict attempt limits so an unreachable relay cannot hold up a room.
