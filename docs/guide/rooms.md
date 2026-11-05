# Rooms and clients

## Coordinator clients

`ChatCoordinatorClient` calls the public contract over Nostr. It connects lazily, retries the idempotent key-package and join-request writes, and rejects every call after `close()`.

```ts
import { ChatCoordinatorClient } from "@cahmls/sdk/client";

const client = new ChatCoordinatorClient(
  { coordinatorPubkey, relayUrls: ["wss://relay.example"] },
  signer,
);
try {
  const messages = await client.fetchMessages(groupId);
} finally {
  await client.close();
}
```

Use `ChatRoomSession` unless you need this low-level access.

## Room sessions

`ChatRoomSession` owns one room's MLS state and network loop. Calls are serialized, so sends and syncs never interleave.

```ts
const session = new ChatRoomSession(room, signer);
const unsubscribe = session.subscribe(() => update(session));

await session.start();         // sync once, then poll every 4 seconds
await session.send("Hello");
await session.toggleReaction(messageId, "👍");
session.markRead();

session.stop();                // restartable with start()
session.discard();             // permanent; in-flight work cannot rewrite the room
```

| Member | Purpose |
|---|---|
| `status` | `connecting`, `connected`, or `offline`, with an optional detail. |
| `room` | The live `StoredRoom`, including messages and read state. |
| `pendingJoinRequests` | Requests awaiting approval when `autoApprove` is off. |
| `recover(signal)` | One startup-only sync that throws on failure, for a retry owner. |
| `activateSteadyState()` | Begins polling after a successful `recover()`. |
| `approveJoinRequests()` | Admits pending guests. |
| `setAutoApprove(enabled)` | Changes the admission policy. |
| `setIdentity(identity)` | Updates the display identity on future messages. |

`send()` throws unless the session is connected and the member has been admitted. After that, it succeeds even if delivery fails: the message remains in `room.pending` and is retried on later syncs, sealed again if the group has moved to a new epoch.

## Creating rooms

- `createHostedRoom()` creates an MLS group owned by the signer and saves it.
- `createJoiningRoom()` publishes a KeyPackage, stores a join request, and saves the room only after both succeed.

Set `identityOwner` to `"anonymous"` for a key your application can retire and `"external"` for a user-controlled signer. `retireAnonymousMemberships()` affects only anonymous rooms.

## Invites

`createInviteUrl()` and `parseInviteUrl()` produce and read Cordn-compatible links. Local and insecure relay URLs are left out of invites, since other clients cannot reach them.

Treat invite contents as hints. Once a member has joined, `hostIdentityForRoom()` trusts a claimed host only if MLS proves the same creator key, and otherwise reports `Unknown host`. While a guest is still waiting for admission, it returns the invite's unverified claim, so label it accordingly.

## Room events

Sessions and the room store dispatch these `CustomEvent`s on `getRoomEnvironment().events`. None contain message content.

| Constant | Fires when |
|---|---|
| `ROOMS_CHANGED_EVENT` | A room is saved, removed, or retired. |
| `ROOM_UNREAD_CHANGED_EVENT` | An exact room's unread count changes. |
| `SERVER_ONLINE_EVENT` | A session reaches its coordinator. |
| `SERVER_OFFLINE_EVENT` | A session loses its coordinator. |

## Low-level MLS

`createKeyPackage`, `createRoomState`, `addMember`, `joinWelcome`, `encryptMessage`, and `decryptMessage` provide the protocol operations directly. Encrypting moves the MLS ratchet forward, so always persist the returned state before sending.

## Direct invites

`createGiftWrap()` and `unwrapGiftWrap()` carry invites between Nostr identities with NIP-59-style gift wrapping and NIP-44 encryption. `unwrapGiftWrap()` verifies the seal signature and checks that the inner sender matches it.
