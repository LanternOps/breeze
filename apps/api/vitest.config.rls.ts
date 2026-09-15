import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // explicit: vitest 5 flips the default to true; flip per package in a follow-up
    clearMocks: false,
    globals: true,
    environment: 'node',
    include: [
      'src/__tests__/integration/rls.integration.test.ts',
      'src/__tests__/integration/auth-browser-transition-rls.integration.test.ts',
    ],
    exclude: [],
  }
});
