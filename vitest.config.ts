import { defineConfig } from "vitest/config";

/**
 * Kept separate from vite.config.ts so the test run does not pull in the PWA
 * plugin, which would precache ~50 MB of models and WASM on every invocation.
 */
export default defineConfig({
    test: {
        environment: "jsdom",
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        setupFiles: ["src/test-setup.ts"],
    },
});
