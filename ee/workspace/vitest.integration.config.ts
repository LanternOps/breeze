import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
// Repo-root .env.test (gitignored; breeze's own convention — see
// apps/api/vitest.integration.config.ts, which loads the same path from the
// same nesting depth: ee/workspace and apps/api both sit one level under the
// breeze repo root). A missing file is fine — CI sets DATABASE_URL /
// DATABASE_URL_APP directly via the job env. When DATABASE_URL is still unset
// after that, globalSetup (vitest.integration.globalSetup.ts) provisions a
// uniquely-named throwaway DB on the local test Postgres (:5433, or
// WORKSPACE_IT_PG_ADMIN_URL), migrates it, and drops it on teardown (#3475).
config({ path: '../../.env.test', quiet: true });

export default defineConfig({
  test: {
    // explicit: vitest 5 flips the default to true; flip per package in a follow-up
    clearMocks: false,
    globalSetup: ['./vitest.integration.globalSetup.ts'],
    include: ['src/__tests__/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
