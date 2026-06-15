import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Office hosts refuse to load task panes over plain http (except localhost in
// some hosts, but Office on the web always requires https). office-addin-dev-certs
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
    resolve: { dedupe: ['react', 'react-dom'] },
    server: {
      port: 3002,
      strictPort: true,
      https,
      fs: { allow: ['../../packages/office-addin-core', '../..'] },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { taskpane: fileURLToPath(new URL('./taskpane.html', import.meta.url)) },
      },
    },
  };
});
