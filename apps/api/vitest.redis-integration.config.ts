import path from 'node:path';
import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.DATABASE_URL ||= 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
process.env.DATABASE_URL_APP ||= 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';

export default defineConfig({
  resolve: {
    alias: {
      '@breeze/extension-api': path.resolve(__dirname, '../../packages/extension-api/src'),
      '@breeze/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/mfa-pending-concurrency.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
