import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

import { promptCatalogAliases, promptCatalogFsAllow } from './promptCatalogAlias';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: promptCatalogAliases,
  },
  server: {
    port: 5173,
    strictPort: true,
    // The prompt catalog lives in packages/shared (#10190). Setting fs.allow
    // replaces Vite's default, so the workspace root is listed explicitly too.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), ...promptCatalogFsAllow],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
  },
});
