// The timezone is pinned HERE, in the config, not in the suites that need it.
//
// `process.env.TZ = '...'` at the top of a test file works under the default
// forks pool and silently does NOT under `--pool=threads`: Node does not
// re-read TZ inside a worker thread, so the assignment applies to nothing and
// every local/UTC assertion runs in the runner's own zone. That made
// screens/time/timesheetLocalDays.test.ts pass locally and fail on the
// documented `--pool=threads --maxWorkers=2` invocation. Setting it before the
// config is even evaluated puts it in the environment every worker inherits.
//
// America/New_York is UTC-4 in August and UTC-5 in January, so it exercises
// both a non-zero offset and a DST change. Suites that depend on it assert the
// zone actually applied rather than trusting this line.
process.env.TZ = 'America/New_York';

import { defineConfig } from 'vitest/config';

// Pure-logic smoke tests only. The mobile app has no React Native test
// runtime configured — we deliberately keep the include pattern at .ts
// (not .tsx) so component imports never pull RN/Expo modules into Vitest.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'ios/**', 'android/**'],
    alias: {
      // The package's ESM build imports './createAsyncStorage' with no
      // extension, which Node cannot resolve — so any suite that transitively
      // reaches it fails at import time, storage-related or not. A suite that
      // asserts on storage still declares its own vi.mock, which wins over this.
      '@react-native-async-storage/async-storage': '/src/testing/asyncStorageStub.ts',
    },
  },
});
