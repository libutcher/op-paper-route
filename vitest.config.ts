import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Live tests talk to the real 1Password app and prompt for Touch ID.
    // They only run when explicitly asked for: PAPER_ROUTE_LIVE=1 npm test
    exclude: process.env.PAPER_ROUTE_LIVE ? [] : ["src/**/*.live.test.ts", "node_modules/**"],
  },
});
