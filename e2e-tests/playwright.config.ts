import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Breeze RMM E2E tests.
 *
 * Environment variables:
 *   E2E_BASE_URL      - Web app base URL (default: http://localhost:4321)
 *   E2E_API_URL       - API base URL (default: http://localhost:3001)
 *   E2E_ADMIN_EMAIL   - Admin email for login tests
 *   E2E_ADMIN_PASSWORD - Admin password for login tests
 *   CI                - Set by CI runners; enables retries and other CI behaviour
 */

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: isCI ? 'never' : 'on-failure' }],
  ],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4321',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
  },

  projects: [
    // Auth setup — runs once, stores auth state for "logged-in" tests
    {
      name: 'setup',
      testMatch: /global-setup\.ts/,
    },

    {
      name: 'chromium',
      testMatch: /\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      testMatch: /\.spec\.ts$/,
      use: {
        ...devices['Desktop Firefox'],
        storageState: '.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],

  /* Web server configuration — start the app before running tests in CI */
  // Uncomment if you want Playwright to start the dev servers automatically:
  // webServer: [
  //   {
  //     command: 'pnpm --filter @breeze/api dev',
  //     url: 'http://localhost:3001/health',
  //     reuseExistingServer: !isCI,
  //     timeout: 30_000,
  //   },
  //   {
  //     command: 'pnpm --filter @breeze/web dev',
  //     url: 'http://localhost:4321',
  //     reuseExistingServer: !isCI,
  //     timeout: 30_000,
  //   },
  // ],
});
