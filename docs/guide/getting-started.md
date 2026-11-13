# Getting started

`@sandwich/cahmls` is the JSR package name for the coordinator and client code behind the [CAHMLS](https://github.com/sandwichfarm/CAHMLS) web application, packaged without any UI framework. Use it to:

- host a [Cordn](https://github.com/Cordn-msg/cordn) MLS coordinator reachable over Nostr relays;
- create, join, and exchange encrypted messages in rooms on any Cordn-compatible coordinator;
- build your own interface on the same coordinator lifecycle the web app uses.

## Requirements

- Node.js 22 or later, or a current browser with WebCrypto.
- ESM. The package ships ES modules and TypeScript declarations only.

## Installation

Install from JSR:

```bash
pnpm dlx jsr add @sandwich/cahmls
```

For Deno, use `deno add jsr:@sandwich/cahmls`. The package and its subpath API are the same as the internal `@cahmls/sdk` workspace package. Other guides and the generated API reference use that workspace name; substitute `@sandwich/cahmls` in imports when using the JSR installation.

Inside this repository's workspace, depend on it directly:

```json
{
  "dependencies": {
    "@cahmls/sdk": "workspace:*"
  }
}
```

Releases are published by GitHub Actions after successful default-branch CI. See the [SDK release instructions](https://github.com/sandwichfarm/CAHMLS/tree/master/packages/sdk#releases) for registry setup and version updates.

## Choose an entry point

Import from the narrowest [entry point](/api/) you need. `@sandwich/cahmls/client` does not load the coordinator or SQLite.

```ts
import { ChatRoomSession, createHostedRoom } from "@sandwich/cahmls/client";
import { transportFactory } from "@sandwich/cahmls/server";
```

## Host a coordinator and a room

This example starts a coordinator, creates a room on it, and prints an invite link. It runs in a browser; see [Storage and environment](/guide/environment) for Node.js.

```ts
import {
  ChatRoomSession,
  LocalHostCoordinatorClient,
  createHostedRoom,
  createInviteUrl,
} from "@sandwich/cahmls/client";
import { BrowserNostrSigner, KeyManager } from "@sandwich/cahmls/crypto";
import { transportFactory } from "@sandwich/cahmls/server";

const relays = ["wss://relay.example"];
const coordinatorKey = KeyManager.generate();

const running = await transportFactory.create(
  coordinatorKey.getSecretKeyBytes(),
  relays,
  { announce: false, maxUsers: 64, coordinatorName: "My coordinator" },
  false, // keep coordinator state in memory only
);

const hostSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
const room = await createHostedRoom({
  title: "Team chat",
  coordinatorPubkey: coordinatorKey.identity.publicKeyHex,
  relayUrls: relays,
  signer: hostSigner,
  identityOwner: "external",
});

// A host in the same tab talks to its coordinator directly, with no relay round trip.
const session = new ChatRoomSession(
  room,
  hostSigner,
  () => new LocalHostCoordinatorClient(running.coordinator),
);
await session.start();

console.log(createInviteUrl(location.origin, {
  groupId: room.id,
  coordinatorPubkey: room.coordinatorPubkey,
  relayUrls: room.relayUrls,
  title: room.title,
  inviteToken: room.inviteToken,
}));
```

## Join a room and send a message

```ts
import { ChatRoomSession, createJoiningRoom, parseInviteUrl } from "@sandwich/cahmls/client";
import { BrowserNostrSigner, KeyManager } from "@sandwich/cahmls/crypto";

const invite = parseInviteUrl(inviteLink);
if (!invite) throw new Error("Not a valid invite");

const signer = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
const room = await createJoiningRoom({
  invite,
  name: "Ada",
  signer,
  identityOwner: "external",
});

const session = new ChatRoomSession(room, signer);
session.subscribe(() => render(session.room.messages, session.status));
await session.start();

// Throws until the host has admitted this member.
await session.send("Hello!");
```

Next, read [Architecture](/guide/architecture) for how the pieces fit together.
