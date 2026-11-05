# Hosting a coordinator

`TransportFactory` builds a complete coordinator: storage, delivery service, ContextVM tools, and a Nostr transport.

```ts
import { transportFactory } from "@cahmls/sdk/server";

const running = await transportFactory.create(
  secretKeyBytes,
  ["wss://relay.example"],
  { announce: true, maxUsers: 64, coordinatorName: "Community coordinator" },
  true, // persist coordinator state
  {
    onStartupPhase: ({ phase }) => console.log(phase),
    onStarted: ({ publicKeyHex }) => console.log("online as", publicKeyHex),
    onOutboundError: (error) => console.error(error),
  },
);

// later
running.close();
```

If startup fails, the factory releases its storage and connections before rejecting.

## Options

| Option | Description |
|---|---|
| `announce` | Publish discoverability announcements. |
| `maxUsers` | Key-package quota per identity. |
| `coordinatorName` | Advertised name. Defaults to `cordn-browser`. |

## Abuse protection

The factory enables a token-bucket rate limit (500 operations per minute with a burst of 160, per identity) and limits each identity to `maxUsers` key packages and one last-resort package. To use different limits, construct `CoordinatorAdapter` yourself and pass it to `registerCoordinatorMethods`.

## Diagnostics

`TransportDiagnostics` callbacks receive summaries of relay events, JSON-RPC traffic, and per-relay publish results. Summaries are truncated and contain no decrypted content, though they do include public keys and ciphertext prefixes. Treat them as sensitive operational data.

## Custom storage

Pass `createStorage` to use storage other than the browser default. Any `CoordinatorStorage` implementation works; `InMemoryCoordinatorStorage` also accepts a snapshot and a change callback, which is a simple way to add your own persistence:

```ts
import { InMemoryCoordinatorStorage } from "@cahmls/sdk/coordinator";
import { TransportFactory } from "@cahmls/sdk/server";

const factory = new TransportFactory({
  createStorage: () => new InMemoryCoordinatorStorage(
    loadSnapshot(),
    (snapshot) => saveSnapshot(snapshot),
  ),
});
```

## Using the coordinator directly

For tests, or to embed the delivery service in another transport, use `createCoordinator` without any networking:

```ts
import { createCoordinator } from "@cahmls/sdk/coordinator";

const coordinator = createCoordinator();
const unsubscribe = coordinator.subscribeJoinRequests(groupId, () => refresh());
```

## Method surface

`COORDINATOR_METHODS` lists the Cordn tools. Their schemas are exported from `@cahmls/sdk/contracts`.

| Key | Tool |
|---|---|
| `publishKeyPackage` | `kp_publish` |
| `listAvailableKeyPackages` | `kp_list` |
| `consumeKeyPackage` | `kp_take` |
| `removeKeyPackages` | `kp_remove` |
| `fetchPendingWelcomes` | `welcome_take` |
| `storeWelcome` | `welcome_store` |
| `storeJoinRequest` | `join_request_store` |
| `fetchPendingJoinRequests` | `join_request_take` |
| `fetchManyPendingJoinRequests` | `join_request_take_many` |
| `postGroupMessage` | `msg_post` |
| `fetchGroupMessages` | `msg_fetch` |
| `fetchManyGroupMessages` | `msg_fetch_many` |
| `subscribeGroupMessages` | `msg_sub` |
| `subscribeManyGroupMessages` | `msg_sub_many` |
