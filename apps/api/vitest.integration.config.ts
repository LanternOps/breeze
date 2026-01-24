import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Load test environment variables
config({ path: '../../.env.test' });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/**/*.test.ts'],
    setupFiles: ['src/__tests__/integration/setup.ts'],
    // Integration tests run sequentially to avoid database conflicts
    sequence: {
      concurrent: false
    },
    // Longer timeouts for database operations
    testTimeout: 30000,
    hookTimeout: 30000,
    // Fail fast on first error for easier debugging
    bail: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        'src/db/schema/**',
        'src/index.ts'
      ]
    }
  }
});
