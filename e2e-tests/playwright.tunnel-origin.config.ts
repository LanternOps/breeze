import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';
import { appBaseUrl } from './helpers/tunnelOriginStack';

// Network Proxy dedicated tunnel origin (#8155 W03, plan Task 15). Needs a
// worktree stack (`pnpm wt-stack up`); global setup turns host mode on for
// that stack and its teardown turns it off again.
//
//   pnpm wt-stack test -- -c playwright.tunnel-origin.config.ts
//
// (`wt-stack test` supplies the seeded admin's credentials and REDIS_PASSWORD.)
//
// The app is served on app.localhost so the tunnel iframe is genuinely
// cross-site (different registrable domains). Gate: chromium + firefox.
// WebKit is not a project: it stores no `Secure` cookie on http://*.localhost
// (spec "W00 spike results"), so the host-mode cookies never stick and every
// flow would fail for a reason that is not the product's. Real Safari is a
// W04 lab-matrix row (TLS origin), not this suite.
// Deliberately NOT E2E_BASE_URL: `wt-stack test` sets that to the stack's
// bare-localhost URL, which would make the tunnel iframe same-site with the app.
const appURL = appBaseUrl();
const BLOCKED_3PC = /@3pc-blocked/;

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /network-proxy-tunnel-origin\.spec\.ts$/,
  globalSetup: ['./global-setup.ts', './helpers/tunnelOriginGlobalSetup.ts'],
  // One worker: the specs share one stack, and the partner opt-in is global state.
  workers: 1,
  fullyParallel: false,
  use: { ...base.use, baseURL: appURL },
  projects: [
    { name: 'chromium', grepInvert: BLOCKED_3PC, use: { ...devices['Desktop Chrome'], baseURL: appURL } },
    { name: 'firefox', grepInvert: BLOCKED_3PC, use: { ...devices['Desktop Firefox'], baseURL: appURL } },
    {
      // Firefox with every third-party cookie refused: the tunnel iframe's
      // cookie cannot stick, so the bootstrap page must report it and the
      // app must offer a new tab.
      name: 'firefox-3pc-blocked',
      grep: BLOCKED_3PC,
      use: {
        ...devices['Desktop Firefox'],
        baseURL: appURL,
        // 1 = reject every third-party cookie (partitioned included); first
        // party still works, so the app login does. (2 would block ALL cookies.)
        launchOptions: { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 1 } },
      },
    },
  ],
});
