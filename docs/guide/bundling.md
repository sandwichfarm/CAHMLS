# Bundling for browsers

The package is ESM with `sideEffects: false`, so unused entry points are removed from production bundles.

## Vite

The built package needs no special Vite settings. (The CAHMLS app aliases `@cahmls/sdk` to its source, but only so that development never uses a stale build.) If the dev server cannot find SQLite's WebAssembly file, exclude the module from dependency pre-bundling:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
```

## Node built-ins

Some transitive dependencies can reference `fs`, `path`, and `crypto`. If your bundler reports them, alias them to small browser shims, as the CAHMLS app does in [`vite.config.ts`](https://github.com/sandwichfarm/CAHMLS/blob/master/vite.config.ts) and [`src/shims`](https://github.com/sandwichfarm/CAHMLS/tree/master/src/shims).

## Reducing bundle size

- Import from subpaths such as `@cahmls/sdk/client`, instead of the root.
- Only `@cahmls/sdk/server`, `@cahmls/sdk/runtime`, `@cahmls/sdk/storage/browser`, and the root load SQLite.
