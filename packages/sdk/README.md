# @cahmls/sdk

Host and connect to [Cordn](https://github.com/Cordn-msg/cordn) MLS coordinators over Nostr and [ContextVM](https://github.com/ContextVM), from a browser tab or Node.js. This is the coordinator and client code behind [CAHMLS](https://github.com/sandwichfarm/CAHMLS), with no UI framework dependency.

## Entry points

| Import | Contents |
|---|---|
| `@cahmls/sdk/client` | Room sessions, coordinator clients, MLS protocol, invites, room store |
| `@cahmls/sdk/contracts` | Cordn method names and Zod schemas |
| `@cahmls/sdk/coordinator` | The delivery service and in-memory storage |
| `@cahmls/sdk/crypto` | Key management, signing, encrypted key storage |
| `@cahmls/sdk/mls` | KeyPackage and Welcome codecs |
| `@cahmls/sdk/relay` | Bounded relay pool and relay URL helpers |
| `@cahmls/sdk/runtime` | `CoordinatorRuntime`, single-instance guard, profile publishing |
| `@cahmls/sdk/server` | `TransportFactory` and the ContextVM method surface |
| `@cahmls/sdk/storage/browser` | SQLite-on-`localStorage` coordinator storage |
| `@cahmls/sdk` | All of the above |

## Example

```ts
import { ChatRoomSession, createJoiningRoom, parseInviteUrl } from "@cahmls/sdk/client";
import { BrowserNostrSigner, KeyManager } from "@cahmls/sdk/crypto";

const invite = parseInviteUrl(inviteLink);
if (!invite) throw new Error("Not a valid invite");

const signer = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
const room = await createJoiningRoom({ invite, name: "Ada", signer, identityOwner: "external" });

const session = new ChatRoomSession(room, signer);
session.subscribe(() => console.log(session.status, session.room.messages));
await session.start();
```

## Documentation

The full guide and API reference live in [`docs/`](https://github.com/sandwichfarm/CAHMLS/tree/master/docs). From the repository root, run `pnpm docs:dev` to read them locally.

## Development

```bash
pnpm --filter @cahmls/sdk test           # tests
pnpm --filter @cahmls/sdk test:coverage  # tests with enforced coverage thresholds
pnpm sdk:verify-package                  # build, then load every published entry point
```
