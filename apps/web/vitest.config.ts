import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

// monaco-editor >=0.56's package.json `exports` map only publishes
// `"./*.js"` / `"./*"` -> `esm/vs/*.js` — it no longer exposes the AMD
// `min/vs/**` assets (including CSS) via any subpath specifier, so
// `ScriptForm.tsx`'s `import 'monaco-editor/min/vs/editor/editor.main.css'`
// fails module resolution under Vite. Mirrored from the same alias in
// astro.config.mjs — keep both in sync.
const require = createRequire(import.meta.url);
const monacoRoot = path.dirname(path.dirname(path.dirname(require.resolve('monaco-editor'))));
const monacoEditorMainCss = path.join(monacoRoot, 'min/vs/editor/editor.main.css');

export default defineConfig({
  resolve: {
    alias: {
      'monaco-editor/min/vs/editor/editor.main.css': monacoEditorMainCss,
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Mirrors the `@breeze/shared` path in apps/web/tsconfig.json so vitest
      // can resolve workspace imports without a build step. Required for
      // testing any component that imports from `@breeze/shared`.
      // Subpath exports (e.g. `/reportPdf`) need their own alias entry, listed
      // BEFORE the bare `@breeze/shared` entry below. Vite's object-form
      // `resolve.alias` does prefix-match (it checks whether the import path
      // starts with `key + '/'`), so alias order matters: if the bare
      // `@breeze/shared` entry came first, it would win the prefix match on
      // `@breeze/shared/reportPdf` and resolve it to the package root instead
      // of the reportPdf subpath — the more specific alias must be listed first.
      '@breeze/shared/reportPdf': fileURLToPath(
        new URL('../../packages/shared/src/reportPdf/index.ts', import.meta.url)
      ),
      '@breeze/shared/testing': fileURLToPath(new URL('../../packages/shared/src/testing', import.meta.url)),
      '@breeze/shared/validators': fileURLToPath(new URL('../../packages/shared/src/validators', import.meta.url)),
      '@breeze/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url)
      ),
      '@breeze/extension-web-sdk': fileURLToPath(
        new URL('../../packages/extension-web-sdk/src/index.ts', import.meta.url)
      ),
      'astro:transitions/client': fileURLToPath(
        new URL('./src/__mocks__/astro-transitions-client.ts', import.meta.url)
      ),
      'astro:middleware': fileURLToPath(
        new URL('./src/__mocks__/astro-middleware.ts', import.meta.url)
      ),
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    // Reset mock call history + restore spied implementations between tests so a
    // stub one test sets (e.g. fetchWithAuth.mockResolvedValue) can't leak into
    // the next and break it. Without this the suite has order-dependent
    // cross-file failures whose victim varies by shard ordering.
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/__tests__/**',
        'src/env.d.ts'
      ]
    }
  }
});
