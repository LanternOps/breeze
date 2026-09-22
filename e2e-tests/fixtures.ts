import { test as base, expect, type Page } from '@playwright/test';
import { loginAndSaveState, persistStorageState, workerStoragePath } from './auth-state';
import { clearLoginRateLimit } from './test-helpers';

type Fixtures = {
  authedPage: Page;
  cleanPage: Page;
};

type WorkerFixtures = {
  /**
   * Path of this worker's storageState file. Logged in once per worker, so
   * every worker owns its own refresh-token family (see auth-state.ts for why
   * one shared family cannot survive parallel workers). Available in
   * `beforeAll` for specs that hold one context for the whole file — pair it
   * with `persistStorageState` in `afterAll`.
   */
  workerStorageState: string;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
  workerStorageState: [
    async ({ browser }, use, workerInfo) => {
      const statePath = workerStoragePath(workerInfo.parallelIndex);
      const baseURL =
        (workerInfo.project.use.baseURL as string | undefined) ??
        process.env.E2E_BASE_URL ??
        'http://localhost:4321';
      clearLoginRateLimit();
      await loginAndSaveState(browser, baseURL, statePath);
      await use(statePath);
    },
    { scope: 'worker' },
  ],

  // Fresh BrowserContext seeded from this worker's storageState. The cookies
  // are written back on teardown so the next test on the worker continues
  // from the latest refresh rotation rather than replaying a stale one.
  authedPage: async ({ browser, workerStorageState }, use) => {
    const ctx = await browser.newContext({ storageState: workerStorageState });
    const page = await ctx.newPage();
    await use(page);
    await persistStorageState(ctx, workerStorageState);
    await ctx.close();
  },

  // Fresh BrowserContext, no cookies, no localStorage. Use for tests that
  // exercise real login/logout/redirect flows.
  cleanPage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

export { expect };
