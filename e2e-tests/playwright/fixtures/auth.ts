// e2e-tests/playwright/fixtures/auth.ts
import { test as base, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.resolve(__dirname, '../.auth');

type AuthFixtures = {
  authedPage: Page;
};

// cleanPage is test-scoped (not worker-scoped): a fresh browser context with no
// storage state. Use it for tests that exercise real login/logout/redirect
// flows where pre-seeded auth state would interfere.
type CleanFixtures = {
  cleanPage: Page;
};

export const test = base.extend<CleanFixtures, AuthFixtures>({
  authedPage: [
    async ({ browser }, use, workerInfo) => {
      const storagePath = path.join(STORAGE_DIR, `worker-${workerInfo.workerIndex}.json`);
      await fs.mkdir(STORAGE_DIR, { recursive: true });

      // First test in this worker: log in via API + save state.
      let storage;
      try {
        storage = JSON.parse(await fs.readFile(storagePath, 'utf8'));
      } catch {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto('/login');
        await page.fill('[name=email]', process.env.E2E_ADMIN_EMAIL!);
        await page.fill('[name=password]', process.env.E2E_ADMIN_PASSWORD!);
        await page.click('button[type=submit]');
        await page.waitForURL('**/');
        storage = await ctx.storageState();
        await fs.writeFile(storagePath, JSON.stringify(storage));
        await ctx.close();
      }

      const ctx = await browser.newContext({ storageState: storage });
      const page = await ctx.newPage();
      await use(page);
      await ctx.close();
    },
    { scope: 'worker' },
  ],

  // Fresh context — no cookies, no localStorage. Each test gets its own
  // isolated browser context so login/logout flows don't bleed into each other.
  cleanPage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

export { expect };
