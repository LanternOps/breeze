import { defineConfig } from 'vitest/config';

// Two projects so only src/web runs in a DOM (happy-dom) environment; the
// rest of the unit suite keeps running in node exactly as before.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // explicit: vitest 5 flips the default to true; flip per package in a follow-up
          clearMocks: false,
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/__tests__/**/*.integration.test.ts', 'src/web/**'],
        },
      },
      {
        test: {
          name: 'web',
          // explicit: vitest 5 flips the default to true; flip per package in a follow-up
          clearMocks: false,
          environment: 'happy-dom',
          include: ['src/web/**/*.test.ts'],
        },
      },
    ],
  },
});
