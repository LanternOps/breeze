import { defineConfig } from '@playwright/test';
// Isolated production frontend gate. No global DB seed or shared test services.
export default defineConfig({
  testDir: './tests', testMatch: 'topology-worker.spec.ts', workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:14397', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node ../apps/web/dist/server/entry.mjs', url: 'http://127.0.0.1:14397/login', env: { HOST: '127.0.0.1', PORT: '14397' }, reuseExistingServer: !process.env.CI },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
