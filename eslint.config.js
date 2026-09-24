import js from "@eslint/js";
import tseslint from "typescript-eslint";

const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Request"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "ARCHITECTURE.md",
      // Generated: the badge bundle copied into the example, and the test vectors.
      "examples/plain-html/developer-footprint/**",
      "spec/test-vectors/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      eqeqeq: ["error", "always"],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // Plain JS config files are not part of any TypeScript project.
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Node scripts (tooling/) run on Node 22, which provides these globals.
    files: ["tooling/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "process",
          "console",
          "Buffer",
          "URL",
          "TextDecoder",
          "TextEncoder",
          "setTimeout",
          "WebSocket",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
  {
    // ARCHITECTURE.md §2.4: the core SDK is deterministic and never touches the network,
    // and stays portable (no Node-only APIs). §2.5: no telemetry of any kind.
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "http", "https", "net", "dns", "child_process"],
              message: "@developer-footprint/core must stay portable and network-free.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...NETWORK_GLOBALS.map((name) => ({
          name,
          message: "@developer-footprint/core must never perform network I/O.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "Use crypto.getRandomValues; Math.random is not suitable for identifiers or keys.",
        },
        {
          object: "globalThis",
          property: "fetch",
          message: "@developer-footprint/core must never perform network I/O.",
        },
      ],
    },
  },
);
