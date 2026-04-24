import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Load test environment variables (DATABASE_URL_APP etc) for the RLS contract
// test runner. This config is INTENTIONALLY separate from
// `vitest.integration.config.ts`: that config wires `setupFiles` to
// `__tests__/integration/setup.ts`, which TRUNCATEs core tenant tables on
// beforeEach. The RLS contract test is read-only — it inspects pg_catalog —
// and must never carry the truncate hazard.
//
// Run with: pnpm -F @breeze/api test:rls-coverage
config({ path: '../../.env.test' });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/rls-coverage.integration.test.ts'],
    // No setupFiles — the contract test opens its own read-only db connection
    // via the regular `db` import and queries pg_catalog. No fixtures needed.
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
