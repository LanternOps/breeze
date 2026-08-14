import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
// Repo-root .env.test (gitignored; breeze's own convention — see
// apps/api/vitest.integration.config.ts, which loads the same path from the
// same nesting depth: ee/workspace and apps/api both sit one level under the
// breeze repo root). A missing file is fine — CI sets DATABASE_URL /
// DATABASE_URL_APP directly via the job env, and locally the suites fall
// back to the shared :5433 test-stack defaults baked into each
// *.integration.test.ts.
config({ path: '../../.env.test' });

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
