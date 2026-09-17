import { defineConfig } from '@playwright/test';
// Isolated production frontend gate. No global DB seed or shared test services.
export default defineConfig({
  // Both topology browser gates run against the BUILT production server.
  testDir: './tests', testMatch: /topology-(worker|baseline)\.spec\.ts$/, workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:14397', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // Never reuse: this gate exists to exercise the freshly BUILT bundle, and a
  // server left over from an earlier run silently serves a stale one.
  webServer: { command: 'node ../apps/web/dist/server/entry.mjs', url: 'http://127.0.0.1:14397/login', env: { HOST: '127.0.0.1', PORT: '14397' }, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
