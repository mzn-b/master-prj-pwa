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
        // `npm run coverage`. main.tsx only mounts <App/> and registers the
        // service worker; it is left out rather than tested through a browser.
        coverage: {
            provider: "v8",
            include: ["src/**/*.{ts,tsx}"],
            exclude: ["src/**/__tests__/**", "src/main.tsx", "src/test-setup.ts", "src/vite-env.d.ts"],
        },
    },
});
