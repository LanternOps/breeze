import { defineConfig } from 'vitest/config';

import { promptCatalogAliases } from './promptCatalogAlias';

export default defineConfig({
  resolve: {
    // The same whitelist as vite.config.ts (#10190).
    alias: promptCatalogAliases,
  },
  test: {
    // explicit: vitest 5 flips the default to true; flip per package in a follow-up
    clearMocks: false,
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
