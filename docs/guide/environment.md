# Storage and environment

Room state lives in a key-value store, and defaults to `localStorage`. Applications connect their own services through one call, usually at startup:

```ts
import { configureRoomEnvironment } from "@cahmls/sdk/client";

const restore = configureRoomEnvironment({
  notifications: { record: (notification) => showToast(notification) },
  onRoomRemoved: (room, reason, label) => archive(room, reason, label),
});
```

| Setting | Default | Purpose |
|---|---|---|
| `storage` | `globalThis.localStorage` | Durable room records. |
| `events` | `globalThis`, or an internal `EventTarget` | Room events, and `online`/`offline` signals. |
| `origin()` | `location.origin` | Origin recorded on new rooms. |
| `notifications` | none | Receives metadata-only notifications. |
| `onRoomRemoved` | none | Lets an application archive a removed room. |

The configuration applies to the whole process. The function returned by `configureRoomEnvironment()` restores the previous settings.

## Node.js

Node.js has no `localStorage` or `location`, so provide them:

```ts
import { configureRoomEnvironment, createMemoryRoomStorage } from "@cahmls/sdk/client";
import { InMemoryCoordinatorStorage } from "@cahmls/sdk/coordinator";
import { KeyStorage } from "@cahmls/sdk/crypto";
import { CoordinatorRuntime } from "@cahmls/sdk/runtime";

configureRoomEnvironment({
  storage: createMemoryRoomStorage(),
  origin: () => "https://chat.example",
});

const keyBackend = createMemoryRoomStorage();
const runtime = new CoordinatorRuntime({
  config,
  keyStorage: new KeyStorage(keyBackend),
  deps: { createStorage: () => new InMemoryCoordinatorStorage() },
});
```

`createMemoryRoomStorage()` keeps data only for the life of the process. For durable hosting, implement `RoomStorage` on a real store.

A key is a Nostr identity, so back up anything you persist yourself and encrypt it at rest.

The `online` and `offline` signals come from `events`. Node.js does not emit them, so dispatch them on your target if you want connectivity changes to take effect immediately.

## Coordinator storage

`createBrowserCoordinatorStorage()` from `@cahmls/sdk/storage/browser` persists coordinator state in SQLite on `localStorage`, falling back to a plain `localStorage` snapshot if SQLite is unavailable. With `persistent` set to `false`, state stays in memory, except for deleted-room tombstones, which always survive so deleted rooms cannot return.

This entry point loads the SQLite WebAssembly module, so it is separate from `@cahmls/sdk/coordinator`.
