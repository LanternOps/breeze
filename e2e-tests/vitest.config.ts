import { defineConfig } from 'vitest/config';

// Scope vitest to the live-signup monitor's unit tests only. The Playwright
// suite under tests/*.spec.ts is run by `playwright test`, NOT vitest — without
// this scoping a bare `vitest run` would try to load those specs and fail.
export default defineConfig({
  test: {
    include: ['live-signup/**/*.test.ts'],
  },
});
