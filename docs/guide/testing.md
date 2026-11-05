# Testing

## Running the SDK tests

```bash
pnpm --filter @cahmls/sdk test           # unit and integration tests
pnpm --filter @cahmls/sdk test:coverage  # with enforced coverage thresholds
pnpm sdk:verify-package                  # build, then load every published entry point
```

## Testing your application

Isolate room storage in each test:

```ts
import { beforeEach, afterEach } from "vitest";
import { configureRoomEnvironment, createMemoryRoomStorage } from "@cahmls/sdk/client";

let restore: () => void;
beforeEach(() => {
  restore = configureRoomEnvironment({ storage: createMemoryRoomStorage() });
});
afterEach(() => restore());
```

Run real MLS rooms without relays by giving sessions a `LocalHostCoordinatorClient` over a shared `Coordinator`:

```ts
const coordinator = createCoordinator();
const session = new ChatRoomSession(
  room,
  signer,
  () => new LocalHostCoordinatorClient(coordinator),
);
```

To test startup behavior, inject `deps` into `CoordinatorRuntime` with a fake `createTransport` and `acquireInstanceLease`, as `packages/sdk/tests/support/runtime-harness.ts` does.

## Upstream interoperability

Changes to the coordinator, contracts, or admission paths must also pass the gates against pinned upstream Cordn, because tests using this SDK on both sides cannot prove compatibility with other clients:

```bash
pnpm check:upstream
pnpm test:upstream-interop
```
