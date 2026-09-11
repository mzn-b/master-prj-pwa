import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {VitePWA} from "vite-plugin-pwa";
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
    experimental: {
        /**
         * Bundle in dev too, so the dev server emits the same self-contained
         * classic worker the build does.
         *
         * `worker.format` below is a build-only option. In dev Vite normally
         * serves the worker through the plain ESM pipeline while still tagging
         * the `new Worker(...)` call `type=classic` (it infers the type from the
         * constructor, and we pass no `{type: "module"}`). The browser then
         * parses an ES module as a classic script and the worker dies before it
         * runs a line: "Cannot use import statement outside a module". The
         * production build was always fine, which is what made this look like a
         * code bug rather than a dev-server one.
         *
         * This is `command === "serve"` only, so nothing about the built PWA —
         * and therefore nothing about the measurements — changes.
         */
        bundledDev: true,
    },
    worker: {
        /**
         * The tracking worker is bundled as a classic worker, not an ES module.
         *
         * MediaPipe's WASM loader calls importScripts(), which a module worker
         * does not have — init fails with "ModuleFactory not set." The ES-module
         * variant of the loader exists, but using it would put the two threading
         * modes on two different WASM builds, and the whole point of measuring
         * both is that only the thread differs between them.
         */
        format: "iife",
    },
    plugins: [
        react(),
        basicSsl(),
        VitePWA({
            registerType: "autoUpdate",
            manifest: {
                name: "Tracking PWA",
                short_name: "Tracking",
                display: "standalone",
                start_url: "/",
                scope: "/",
                theme_color: "#111827",
                background_color: "#111827",
                icons: [
                    {src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any"},
                    {src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable"},
                ],
            },

            // ✅ Offline-first: public/ Dateien & build assets precachen
            includeAssets: [
                "pwa-192.png",
                "pwa-512.png",
                "favicon.svg",

                // ✅ unsere MediaPipe Assets aus public/
                "mediapipe/models/*.task",
                "mediapipe/wasm/*",

                // ✅ AR Filter Assets
                "filters/*",
            ],

            workbox: {
                // Workbox hat ein Default-Limit für precache (oft 2MB).
                // .task Dateien können größer sein -> Limit erhöhen
                maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, // 20MB

                globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2,task,wasm,glb}"],

                // Sicherheit: falls irgendwas nicht im precache landet, runtime cache fallback
                runtimeCaching: [
                    {
                        urlPattern: ({url}) => url.pathname.startsWith("/mediapipe/"),
                        handler: "CacheFirst",
                        options: {
                            cacheName: "mediapipe-assets",
                            expiration: {
                                maxEntries: 50,
                                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 Jahr
                            },
                        },
                    },
                ],
            },
        }),
    ]
});
