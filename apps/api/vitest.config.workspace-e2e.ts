import { defineConfig } from 'vitest/config';

/**
 * Nightly real-Vercel workspace e2e runner (spec §12, §11 step 2: "nightly
 * real-Vercel suite green for a week").
 *
 * NOT part of PR CI and NOT part of the Integration Tests job: it needs live
 * Vercel credentials, it costs real sandbox-minutes, and it asserts egress is
 * blocked — which means every case deliberately waits for a network failure.
 * Run by .github/workflows/workspace-nightly.yml, or by hand with
 * `WORKSPACE_E2E=1 pnpm --filter @breeze/api test:workspace-e2e`.
 *
 * No Postgres, no Redis, no setupFiles: the suite drives the SandboxBackend
 * adapter directly and touches no Breeze table.
 */
export default defineConfig({
  test: {
    // explicit: vitest 5 flips the default to true; flip per package in a follow-up
    clearMocks: false,
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/workspace.vercel.e2e.test.ts'],
    fileParallelism: false,
    // A sandbox create is ~10 s and several cases wait out a deny-all timeout.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
