import { defineConfig } from 'vitest/config';

// Two projects so only src/web runs in a DOM (happy-dom) environment; the
// rest of the unit suite keeps running in node exactly as before.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/__tests__/**/*.integration.test.ts', 'src/web/**'],
        },
      },
      {
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['src/web/**/*.test.ts'],
        },
      },
    ],
  },
});
