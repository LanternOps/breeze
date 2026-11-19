import { defineConfig } from 'vitest/config';
import path from 'path';

// S3-compatibility smoke test against a real object store (#8350). CI runs it
// against the digest-pinned RustFS from docker-compose.dev.yml; run locally with
//   S3_ENDPOINT=http://<store container IP>:9000 S3_ACCESS_KEY=... S3_SECRET_KEY=... pnpm test:storage
// The endpoint must not be loopback: backup destinations are dialled through
// the SSRF guard, which always refuses it. Excluded from vitest.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      '@breeze/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    clearMocks: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.storage.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Self-host posture: the SSRF guard admits private (LAN) store addresses.
    env: { IS_HOSTED: 'false', NODE_ENV: 'test' },
  },
});
