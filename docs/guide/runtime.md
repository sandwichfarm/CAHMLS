# Coordinator runtime

`CoordinatorRuntime` is the full lifecycle used by the CAHMLS web app. Use it when you want more than a transport: passphrase-protected identity, a single active instance per key, startup progress, hosted-room recovery, and profile publication.

## Create a runtime

The runtime reads settings through the `CoordinatorRuntimeConfig` interface, so configuration stays in your application.

```ts
import { CoordinatorRuntime } from "@cahmls/sdk/runtime";

const runtime = new CoordinatorRuntime({
  config: {
    isSetupComplete: true,
    coordinatorName: "My coordinator",
    enabledRelayUrls: ["wss://relay.example"],
    inviteRelayUrls: ["wss://relay.example"],
    coordinatorOptions: { announce: false, maxUsers: 64, coordinatorName: "My coordinator" },
    runtimeRevision: 1,
    lock() {},
    completeSetup: () => true,
    setCoordinatorName: () => true,
    resetToDefaults() {},
  },
});

await runtime.start();
console.log(runtime.status, runtime.identity.npub);
await runtime.stop();
```

## Lifecycle

```
idle ──start──▶ starting ──started──▶ running
 ▲                 │  │                  │
 │                 │  └──stop──┐         │ stop
 │               error         ▼         ▼
 ├─────────────────┘        stopping ◀───┘
 └──────── stopped ────────────┘
```

| Method | Behavior |
|---|---|
| `start()` | Acquires the instance lease, creates the transport, and recovers rooms. Concurrent calls share one startup. Requires `config.isSetupComplete`. |
| `stop()` | Cancels any startup and closes everything. Safe to call repeatedly and while idle. |
| `restart()` | Stops and starts when active, to apply changed settings. |
| `destroy()` | Cancels any startup, deletes hosted rooms and keys, and generates a new identity. |

Startup failures do not reject `start()`. Read `error` and `startupProgress`, or subscribe for changes.

## Bind a UI framework

`subscribe()` and `getSnapshot()` follow the external store contract. Snapshots are immutable, and a snapshot's identity changes only when state changes.

::: code-group

```ts [React]
import { useSyncExternalStore } from "react";

export function useCoordinator(runtime: CoordinatorRuntime) {
  return useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.getSnapshot(),
  );
}
```

```ts [Svelte 5]
class CoordinatorState {
  snapshot = $state.raw(runtime.getSnapshot());
  constructor() {
    runtime.subscribe(() => {
      this.snapshot = runtime.getSnapshot();
    });
  }
}
```

:::

## Hosted-room recovery

Register an adapter to restore your rooms during startup. Each room gets up to `ROOM_RECOVERY_POLICY.maxAttempts` attempts with increasing deadlines. If a room runs out of attempts, startup pauses at `startupProgress.roomRecovery.state === "exhausted"` until you call `retryRoomRecovery()` or remove the room with `resumeAfterRemovingFailedRoom()`.

```ts
const unregister = runtime.registerHostedRoomRecovery({
  listTargets: () => myRooms.map((room) => ({
    coordinatorPubkey: room.coordinatorPubkey,
    roomId: room.id,
    roomName: room.title,
    roomIdentityKey: roomIdentityKey(room.coordinatorPubkey, room.id),
  })),
  recover: (target, signal) => sessionFor(target).recover(signal),
  discard: (target) => sessionFor(target).stop(),
});
```

## Replacing side effects

Pass `deps` to replace any side effect. Unspecified entries use `defaultCoordinatorRuntimeDeps`. Resource monitoring does nothing by default; supply `startResourceMonitor` to attach a sink with `transport.adapter.setTelemetrySink()`.

## Identity and persistence

A new runtime generates a key unless its `KeyStorage` already holds one, in which case `loadState` is `"prompting"` until you call `loadFromPassphrase()` or `generateFreshKey()`.

Keys are encrypted with AES-GCM using a PBKDF2-SHA-256 key derived from the passphrase. `exportCoordinatorKeyBackup()` returns the encrypted blob after verifying the passphrase, never the plaintext key.

## Single-instance lease

`SingleInstanceGuard` refuses to start a coordinator whose key is already active, using Web Locks, `BroadcastChannel`, a storage lease, and signed Nostr heartbeats. When another instance is active, `start()` ends with the error `INSTANCE_RUNNING_MESSAGE`.
