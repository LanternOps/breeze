import { test as base, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from './global-setup';

type Fixtures = {
  authedPage: Page;
  cleanPage: Page;
};

export const test = base.extend<Fixtures>({
  // Loads the shared storageState produced by globalSetup. Each test gets a
  // fresh BrowserContext, but no fresh login — that happens once per run.
  authedPage: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await ctx.newPage();
    await use(page);
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
