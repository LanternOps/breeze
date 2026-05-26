import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Mirrors the `@breeze/shared` path in apps/web/tsconfig.json so vitest
      // can resolve workspace imports without a build step. Required for
      // testing any component that imports from `@breeze/shared`.
      '@breeze/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url)
      ),
      'astro:transitions/client': fileURLToPath(
        new URL('./src/__mocks__/astro-transitions-client.ts', import.meta.url)
      ),
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
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
