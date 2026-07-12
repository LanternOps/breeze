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
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
