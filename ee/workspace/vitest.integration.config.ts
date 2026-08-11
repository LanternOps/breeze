import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
// Repo-root .env.test (gitignored; see .env.test.example). The old
// '../../.env.test' path assumed this repo sat at extensions/workspace inside
// the monorepo and silently resolved to a nonexistent file standalone (#14).
// A missing file is fine — the suites fall back to the shared :5433 test-stack
// defaults baked into each *.integration.test.ts.
config({ path: '.env.test' });

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
