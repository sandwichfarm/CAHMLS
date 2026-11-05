import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

const sdkSource = fileURLToPath(new URL("./packages/sdk/src", import.meta.url));

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: [
      // The application consumes the SDK from source so `pnpm dev`, `pnpm build`,
      // and unit tests never depend on a stale `packages/sdk/dist`.
      { find: /^@cahmls\/sdk$/, replacement: `${sdkSource}/index.ts` },
      { find: /^@cahmls\/sdk\/storage\/browser$/, replacement: `${sdkSource}/storage-browser.ts` },
      { find: /^@cahmls\/sdk\/([^/]+)$/, replacement: `${sdkSource}/$1/index.ts` },
      { find: "fs", replacement: fileURLToPath(new URL("./src/shims/node-fs.ts", import.meta.url)) },
      { find: "path", replacement: fileURLToPath(new URL("./src/shims/node-path.ts", import.meta.url)) },
      { find: "crypto", replacement: fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url)) },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "app",
          environment: "jsdom",
          globals: true,
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["tests/setup.ts"],
        },
      },
      "packages/sdk/vitest.config.ts",
    ],
  },
});
