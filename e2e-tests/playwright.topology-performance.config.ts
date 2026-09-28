import { defineConfig } from '@playwright/test';
// Manual M1 enablement gate: topology explorer browser performance (design
// spec §9). NOT a CI job — it is meaningful only on the reference host, takes
// 15+ minutes, and a shared runner's timings are not evidence. See the
// "Topology browser performance gate" section of e2e-tests/README.md.
//
// Same shape as playwright.topology-worker.config.ts: the BUILT production web
// server (real module worker, real ELK engine worker, shipped CSP), no DB/API.
export default defineConfig({
  testDir: './tests', testMatch: /topology-performance\.spec\.ts$/,
  // One browser, one test at a time: parallel workers would compete for the
  // CPU the measurement is timing.
  workers: 1, fullyParallel: false, retries: 0,
  // Per-test timeouts are set in the spec (they scale with the sample count).
  timeout: 60 * 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:14398', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    screenshot: 'only-on-failure', trace: 'off',
  },
  // Never reuse: a server left over from an earlier run silently serves a stale bundle.
  webServer: { command: 'node ../apps/web/dist/server/entry.mjs', url: 'http://127.0.0.1:14398/login', env: { HOST: '127.0.0.1', PORT: '14398' }, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
