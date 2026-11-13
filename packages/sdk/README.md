# @sandwich/cahmls

Host and connect to [Cordn](https://github.com/Cordn-msg/cordn) MLS coordinators over Nostr and [ContextVM](https://github.com/ContextVM), from a browser tab or Node.js. This is the coordinator and client code behind [CAHMLS](https://github.com/sandwichfarm/CAHMLS), with no UI framework dependency.

## Install from JSR

```bash
pnpm dlx jsr add @sandwich/cahmls
```

For Deno, use `deno add jsr:@sandwich/cahmls`.
The repository's internal pnpm workspace remains named `@cahmls/sdk`; installed JSR consumers use `@sandwich/cahmls` with the same API and subpaths.

## Entry points

| Import | Contents |
|---|---|
| `@sandwich/cahmls/client` | Room sessions, coordinator clients, MLS protocol, invites, room store |
| `@sandwich/cahmls/contracts` | Cordn method names and Zod schemas |
| `@sandwich/cahmls/coordinator` | The delivery service and in-memory storage |
| `@sandwich/cahmls/crypto` | Key management, signing, encrypted key storage |
| `@sandwich/cahmls/mls` | KeyPackage and Welcome codecs |
| `@sandwich/cahmls/relay` | Bounded relay pool and relay URL helpers |
| `@sandwich/cahmls/runtime` | `CoordinatorRuntime`, single-instance guard, profile publishing |
| `@sandwich/cahmls/server` | `TransportFactory` and the ContextVM method surface |
| `@sandwich/cahmls/storage/browser` | SQLite-on-`localStorage` coordinator storage |
| `@sandwich/cahmls` | All of the above |

## Example

```ts
import { ChatRoomSession, createJoiningRoom, parseInviteUrl } from "@sandwich/cahmls/client";
import { BrowserNostrSigner, KeyManager } from "@sandwich/cahmls/crypto";

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
cd packages/sdk
pnpm dlx jsr@0.14.3 publish --dry-run
```

## Releases

The [`Publish SDK to JSR` workflow](https://github.com/sandwichfarm/CAHMLS/blob/master/.github/workflows/publish-jsr.yml) publishes TypeScript sources after `CI` succeeds for a push to `master` or `main`. It checks out the exact commit that passed CI. Pull requests and feature branches run the dry run only.

Before the first release, create `@sandwich/cahmls` on JSR and [link it to `sandwichfarm/CAHMLS` in the package settings](https://jsr.io/docs/publishing-packages#publishing-from-github-actions). GitHub OIDC authenticates publishing; no JSR token or repository publishing secret is needed. The workflow becomes active once merged into the default branch.

For each release, update `version` in both `packages/sdk/package.json` and `packages/sdk/jsr.json` and refresh the pnpm lockfile if needed. Package verification rejects version and export-map drift. Merge the change after CI passes; successful default-branch CI triggers publication. Already-published versions are skipped, so unrelated pushes do not create releases. If publication fails after successful CI, fix any registry setup issue and rerun that default-branch CI run to trigger publication again. Inspect the publishing run and registry version before announcing a release.
