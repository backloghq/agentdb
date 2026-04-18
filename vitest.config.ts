import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/examples/**"],
    coverage: {
      // Default 'text' + 'html' for local viewing; 'text-summary' for console
      // one-liner; 'json-summary' for CI to parse into a GITHUB_STEP_SUMMARY table.
      reporter: ["text", "html", "text-summary", "json-summary"],
    },
  },
});
