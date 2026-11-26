import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: ["src/index.ts"],
    dts: true,
    exports: true,
  },
  fmt: {
    // Server snapshots stay byte-identical; generated code is owned by its generator.
    // Traits owns the format of its Markdown files and skill links under .agents/.
    ignorePatterns: [".agents/**", "docs/research/**", "schema/**", "src/generated/**"],
  },
  lint: {
    ignorePatterns: [".agents/**", "src/generated/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "mcp/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
