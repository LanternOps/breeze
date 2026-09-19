import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // explicit: vitest 5 flips the default to true; flip per package in a follow-up
    clearMocks: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
