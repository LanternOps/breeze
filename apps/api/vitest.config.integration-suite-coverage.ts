import { defineConfig } from 'vitest/config';

// Dedicated runner for the integration-suite coverage contract test
// (`src/__tests__/integration/integration-suite-coverage.integration.test.ts`,
// added for #4522).
//
// This test is pure static analysis — it walks `src/**/*.integration.test.ts`
// from disk and imports `vitest.integration.config.ts`'s own `include`/
// `exclude` arrays to check every file is actually wired into a CI job. It
// never touches Postgres, Redis, or any external service. It lives under
// `__tests__/integration/` because it is a coverage-style contract test
// (like `rls-coverage.integration.test.ts` and
// `site-scope-coverage.integration.test.ts`), but it must NOT be wired to
// `__tests__/integration/setup.ts`, which opens a real postgres pool and
// TRUNCATEs core tenant tables on beforeEach. Hence its own runner config.
//
// Run with: pnpm -F @breeze/api test:integration-suite-coverage
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/integration-suite-coverage.integration.test.ts'],
    // No setupFiles — the contract test reads `.ts` source from disk only.
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
