import path from "path"
import { defineConfig, loadEnv } from "vite"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { VitePWA } from "vite-plugin-pwa"
import { worldCountriesFilter } from "./scripts/vite-plugin-world-countries-filter"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_")
  // 开发时 /api 代理的目标：极简探针（Monitor）Hub（可用 SSH 隧道映射到本机端口）
  const apiTarget = (env.VITE_API_TARGET || "http://127.0.0.1:7980").trim()

  return {
    plugins: [
      // Strip the unused fields from `world-countries` so the globe chunk only
      // ships what we actually read at runtime. Mode `"merge"` = auto-detect
      // referenced fields + the explicit `fields` list below. To pin extra
      // fields without touching code, append them here; to opt out of the
      // scanner entirely, switch to `mode: "manual"`.
      worldCountriesFilter({
        mode: "merge",
        fields: ["flag", "latlng", "name"],
      }),
      tailwindcss(),
      react(),
      // ── PWA ────────────────────────────────────────────────────────────
      // This is a *Monitor theme*, served at the site root "/". The service
      // worker therefore has scope "/" and could otherwise hijack pages that
      // are NOT controlled by the theme (`/admin`, `/terminal`) and the live
      // data channel (`/api/*`, including the WebSocket). We deliberately:
      //   • precache only the static app shell (fonts are self-hosted),
      //   • use `prompt` updates (user-driven, no silent reload),
      //   • deny-list `/admin`, `/terminal`, `/api` from the SPA navigate
      //     fallback so those keep hitting the real backend,
      //   • never runtime-cache the live API/WebSocket (offline data is
      //     handled at the app layer via localStorage snapshots instead).
      VitePWA({
        registerType: "prompt",
        injectRegister: null,
        includeAssets: ["favicon.ico", "favicon.svg", "apple-touch-icon.png"],
        manifest: {
          id: "/",
          name: "Monitor Commander",
          short_name: "Commander",
          description: "Monitor Commander — a monitoring theme for the Monitor probe.",
          lang: "en",
          theme_color: "#0a0e14",
          background_color: "#0a0e14",
          display: "standalone",
          orientation: "any",
          scope: "/",
          start_url: "/",
          icons: [
            { src: "/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,ico,webp,woff,woff2}"],
          // Globe / charts chunks can be large; precache them for offline shell.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          // SPA fallback — but keep non-theme + live API routes off the SW.
          navigateFallback: "index.html",
          navigateFallbackDenylist: [/^\/admin/, /^\/terminal/, /^\/api/],
        },
        devOptions: {
          // Keep the SW off during `vite dev` so it can't interfere with the
          // /api proxy or HMR. Enable manually when debugging PWA behaviour.
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      outDir: "dist",
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          // Split long-lived, rarely-changing vendor code into its own
          // cacheable chunks. First-paint download size is unchanged (all of
          // these are needed on first paint), but shipping an app-code edit no
          // longer busts the hash of React/router/i18n/motion/icons — repeat
          // visitors only re-download the small `entry` chunk. Lazy view code
          // (charts/globe) stays isolated so it never enters first paint.
          manualChunks: {
            "react-vendor": ["react", "react-dom", "react-router-dom"],
            i18n: ["i18next", "react-i18next", "i18next-browser-languagedetector"],
            charts: ["recharts"],
            globe: ["cobe", "world-countries"],
            motion: ["motion"],
            icons: ["react-icons/si", "react-icons/fa", "lucide-react"],
            sonner: ["sonner"],
          },
          chunkFileNames: "assets/chunk-[name]-[hash].js",
          entryFileNames: "assets/entry-[name]-[hash].js",
        },
      },
    },

    // 开发模式下，代理 /api 到极简探针（Monitor）Hub
    ...(mode === "development"
      ? {
          server: {
            // 多项目并行开发时避免都抢 5173：本仓库默认 5174，可用 VITE_DEV_SERVER_PORT 覆盖
            port: Number.parseInt(env.VITE_DEV_SERVER_PORT || "5174", 10),
            strictPort: false,
            proxy: {
              "/api": {
                target: apiTarget,
                changeOrigin: true,
                rewriteWsOrigin: true,
                ws: true, // WebSocket 代理（/api/ws 实时帧）
                secure: false, // 允许代理到 HTTPS（含自签名证书）
              },
            },
          },
        }
      : {}),
  }
})
