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
  },
});
