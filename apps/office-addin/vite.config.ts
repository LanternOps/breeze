import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Office hosts refuse to load task panes over plain http (except localhost in
// some hosts, but Excel on the web always requires https). office-addin-dev-certs
// installs a locally-trusted CA + localhost cert (~/.office-addin-dev-certs) and
// getHttpsServerOptions() returns { ca, key, cert } for Vite. Set
// ADDIN_NO_HTTPS=1 to opt out (plain-browser debugging only).
export default defineConfig(async () => {
  let https: { ca: Buffer; key: Buffer; cert: Buffer } | undefined;
  if (!process.env.ADDIN_NO_HTTPS) {
    const { getHttpsServerOptions } = await import('office-addin-dev-certs');
    https = await getHttpsServerOptions();
  }
  return {
    plugins: [react()],
    server: {
      port: 3000,
      strictPort: true,
      https,
      // WebKit (Safari / Excel-mac WebView) blocks fetch from this https pane to a
      // plain-http API as mixed content. Proxy /api/v1 same-origin so the browser
      // only ever talks to https://localhost:3000 (trusted cert), and Vite forwards
      // to the http API server-side. Also supplies the /api/v1 prefix the add-in omits.
      proxy: {
        '/api/v1': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          secure: false,
        },
      },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { taskpane: fileURLToPath(new URL('./taskpane.html', import.meta.url)) },
      },
    },
  };
});
