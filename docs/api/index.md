# Entry points

Every symbol is documented in the generated [API reference](/reference/).

| Import | Contents | Loads SQLite |
|---|---|---|
| [`@cahmls/sdk/client`](/reference/client/) | `ChatRoomSession`, coordinator clients, MLS protocol, invites, gift wraps, room store, room environment | No |
| [`@cahmls/sdk/contracts`](/reference/contracts/) | `COORDINATOR_METHODS` and Zod schemas | No |
| [`@cahmls/sdk/coordinator`](/reference/coordinator/) | `Coordinator`, `createCoordinator`, `InMemoryCoordinatorStorage`, `CoordinatorStorage` | No |
| [`@cahmls/sdk/crypto`](/reference/crypto/) | `KeyManager`, `BrowserNostrSigner`, `KeyStorage` | No |
| [`@cahmls/sdk/mls`](/reference/mls/) | KeyPackage and Welcome codecs, last-resort helpers | No |
| [`@cahmls/sdk/relay`](/reference/relay/) | `createRequiredRelayPool`, relay URL helpers, publish diagnostics | No |
| [`@cahmls/sdk/runtime`](/reference/runtime/) | `CoordinatorRuntime`, `SingleInstanceGuard`, profile publishing, validators | Yes |
| [`@cahmls/sdk/server`](/reference/server/) | `TransportFactory`, `CoordinatorAdapter`, `registerCoordinatorMethods`, rate limiter | Yes |
| [`@cahmls/sdk/storage/browser`](/reference/storage-browser/) | `createBrowserCoordinatorStorage`, `clearPersistedCoordinatorState` | Yes |
| `@cahmls/sdk` | All of the above. `contracts` and `mls` are exposed as namespaces because their names overlap. | Yes |
