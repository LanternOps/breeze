import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // Tauri wraps a modern WKWebView (macOS) / WebView2 (Windows) that
    // supports top-level await. The default Vite target (chrome87/safari14)
    // rejects TLA, so we target esnext to allow novnc's async module pattern.
    target: 'esnext',
  },
  // Same rationale for the dev server's dependency pre-bundler — without this
  // override, `pnpm tauri dev` fails to prebundle @novnc/novnc (TLA in
  // core/util/browser.js).
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
});
