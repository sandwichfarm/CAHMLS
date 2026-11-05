import js from "@eslint/js";
import globals from "globals";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "playwright-report/**", "test-results/**", "docs/reference/**", "docs/.vitepress/cache/**", "docs/.vitepress/dist/**"],
  },
  {
    files: ["**/*.{ts,svelte,mjs}"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "svelte/store",
              message: "Use Svelte 5 runes state instead of svelte/store.",
            },
          ],
        },
      ],
    },
  },
);
