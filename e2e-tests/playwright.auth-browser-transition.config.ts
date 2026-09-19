import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './browser-contracts',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: isCI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.E2E_AUTH_TRANSITION_API_URL ?? 'http://localhost:3005',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'auth-transition-chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
});
