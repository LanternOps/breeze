import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/db/requestDatabaseRole.integration.test.ts'],
    // No shared integration setup: this suite only manages a temporary role
    // and must never inherit the core-table TRUNCATE hooks.
    sequence: { concurrent: false },
    fileParallelism: false,
    // Cold transformation of db/index.ts can exceed 30s on CI. A timeout leaves
    // that dynamic import running while afterEach mutates DATABASE_URL_APP for
    // the next test, producing cross-test role contamination instead of a clean
    // timeout. Keep the sequential suite above that observed cold-start ceiling.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
