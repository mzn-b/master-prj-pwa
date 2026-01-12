import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
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
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
        ],
      },

      // ✅ Offline-first: public/ Dateien & build assets precachen
      includeAssets: [
        "pwa-192.png",
        "pwa-512.png",
        "favicon.svg",
        "robots.txt",

        // ✅ unsere MediaPipe Assets aus public/
        "mediapipe/models/*.task",
        "mediapipe/wasm/*",
      ],

      workbox: {
        // Workbox hat ein Default-Limit für precache (oft 2MB).
        // .task Dateien können größer sein -> Limit erhöhen
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, // 20MB

        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2,task,wasm}"],

        // Sicherheit: falls irgendwas nicht im precache landet, runtime cache fallback
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/mediapipe/"),
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
  ],
});
