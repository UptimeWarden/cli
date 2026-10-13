import { defineConfig } from "vitest/config";

// Tests run in the node environment (no DOM). Each test file isolates its
// state with mkdtemp(), so the suite is safe to run in parallel.
export default defineConfig({
  // The CLI processes no CSS. An inline (empty) PostCSS config stops Vite
  // from searching parent directories for one.
  css: { postcss: {} },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
