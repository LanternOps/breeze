import { test, expect } from '../fixtures';
import { persistStorageState } from '../auth-state';
import { SitesPage } from '../pages/SitesPage';
import { DevicesPage } from '../pages/DevicesPage';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Sites reachability (#9791 wave E2): an org-scoped user finds Sites in the
// nav, creates a site, moves a device into it in bulk, and follows the site's
// device-count link back to a devices list. Plus the mixed-org disabled reason
// for the fleet admin. Seed: seed-sites-reachability.sql.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d.pgContainer) return d.pgContainer;
  }
  return 'breeze-postgres';
}

const camel = (k: string) => k.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Runs a seed file inside the stack's Postgres; returns the `KEY=<uuid>` ids it printed. */
function seedFromFile<T>(file: string, keys: string[]): T {
  const sqlPath = path.resolve(__dirname, '..', file);
  const out = execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(sqlPath, 'utf8') },
  );
  const result: Record<string, string> = {};
  for (const key of keys) {
    const id = new RegExp(`${key}=([0-9a-f-]{36})`).exec(out)?.[1];
    if (!id) throw new Error(`seed did not report ${key}:\n${out}`);
    result[camel(key)] = id;
  }
  return result as T;
}

interface Seed {
  orgAId: string;
  siteAId: string;
  deviceAId: string;
  orgBId: string;
  siteBId: string;
  deviceBId: string;
}

const ORG_USER_EMAIL = 'e2e-w06-orgadmin@breeze.local';

async function loginAsOrgUser(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!password) throw new Error('E2E_ADMIN_PASSWORD must be set (the org user shares the seeded admin password)');
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email-input').fill(ORG_USER_EMAIL);
  await page.getByTestId('login-password-input').fill(password);
  await page.getByTestId('login-submit').click();
  try {
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  } catch (err) {
    throw new Error(`org-scoped login did not leave /login (landed on ${page.url()}): ${String(err)}`);
  }
  await page.close();
  return ctx;
}

/** Bearer token the page's own API calls carry (for best-effort cleanup requests). */
async function sniffToken(page: Page): Promise<string> {
  let token: string | null = null;
  page.on('request', (req) => {
    const header = req.headers()['authorization'];
    if (!token && header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  });
  await page.goto('/');
  await expect.poll(() => token, { timeout: 30_000 }).toBeTruthy();
  return token!;
}

test.describe.configure({ mode: 'serial' });

test.describe('Sites reachability', () => {
  test.setTimeout(90_000);

  let seed: Seed;

  test.beforeAll(() => {
    seed = seedFromFile<Seed>('seed-sites-reachability.sql', [
      'ORG_A_ID',
      'SITE_A_ID',
      'DEVICE_A_ID',
      'ORG_B_ID',
      'SITE_B_ID',
      'DEVICE_B_ID',
    ]);
  });

  test.describe('org-scoped user', () => {
    let ctx: BrowserContext;
    let page: Page;
    let token = '';
    let newSiteId = '';
    let siteACountBefore = -1;

    test.beforeAll(async ({ browser }, workerInfo) => {
      const baseURL = (workerInfo.project.use.baseURL as string | undefined) ?? process.env.E2E_BASE_URL ?? 'http://localhost:4321';
      ctx = await loginAsOrgUser(browser, baseURL);
      // "Sites" lives in the Fleet Management sidebar section, which is collapsed
      // until the user expands it (or visits a page inside it); that section
      // header has no data-testid (gap, see PR). Expand it through the sidebar's
      // own persisted preference, exactly what a user's earlier toggle leaves.
      await ctx.addInitScript(() => {
        try {
          const raw = localStorage.getItem('sidebar-sections');
          const saved = raw ? JSON.parse(raw) : {};
          localStorage.setItem('sidebar-sections', JSON.stringify({ ...saved, 'fleet-management': true }));
        } catch {
          /* storage unavailable */
        }
      });
      page = await ctx.newPage();
      token = await sniffToken(page);
    });

    test.afterAll(async () => {
      // Best effort: move the device home, then drop the created site. The
      // seed's cleanup block is the backstop for a crashed run.
      try {
        if (newSiteId && page) {
          const headers = { authorization: `Bearer ${token}` };
          await page.request.post('/api/v1/devices/bulk/site', {
            headers,
            data: { siteId: seed.siteAId, devices: [{ id: seed.deviceAId, expectedSiteId: newSiteId }] },
          });
          await page.request.delete(`/api/v1/orgs/sites/${newSiteId}`, { headers });
        }
      } catch {
        /* never fail the suite on cleanup */
      }
      await ctx?.close();
    });

    test('nav-sites reaches the Sites page with an add button', async () => {
      const sites = new SitesPage(page);
      await page.goto('/');
      await expect(sites.navSites()).toBeVisible({ timeout: 20_000 });
      await sites.navSites().click();
      await page.waitForURL(/\/settings\/sites$/);
      await expect(sites.root()).toBeVisible({ timeout: 15_000 });
      await expect(sites.row(seed.siteAId)).toBeVisible();
      await expect(sites.addButton()).toBeVisible();
      siteACountBefore = await sites.deviceCount(seed.siteAId);
      expect(siteACountBefore).toBeGreaterThanOrEqual(1);
    });

    test('creates a site (no org picker for an org-scoped user)', async () => {
      const sites = new SitesPage(page);
      await sites.goto();
      await sites.addButton().click();
      await expect(sites.formName()).toBeVisible();
      expect(await sites.orgPicker().count(), 'an org-scoped user must never be asked to pick an org').toBe(0);
      await sites.formName().fill(`E2E W06 Target ${Date.now()}`);
      const [response] = await Promise.all([
        page.waitForResponse((r) => /\/orgs\/sites$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
        sites.formSubmit().click(),
      ]);
      expect([200, 201]).toContain(response.status());
      newSiteId = ((await response.json()) as { id: string }).id;
      expect(newSiteId).toBeTruthy();
      await expect(sites.row(newSiteId)).toBeVisible({ timeout: 15_000 });
      await expect(sites.deviceCountLink(newSiteId)).toHaveText(/^\s*0\b/);
    });

    test('bulk-moves a device into the new site from the devices list', async () => {
      const devices = new DevicesPage(page);
      await devices.gotoAgents();
      await expect(devices.rowSelect(seed.deviceAId)).toBeVisible({ timeout: 15_000 });
      await devices.rowSelect(seed.deviceAId).check();
      await devices.bulkActionsTrigger().click();
      await expect(devices.bulkActionsMenu()).toBeVisible();
      await expect(devices.bulkMoveSite()).toBeEnabled();
      await expect(devices.bulkMoveSiteDisabledReason()).toHaveCount(0);
      await devices.bulkMoveSite().click();
      await expect(devices.moveSiteCurrent()).toBeVisible();
      await devices.moveSiteSelect().selectOption(newSiteId);
      const [response] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/devices/bulk/site') && r.request().method() === 'POST'),
        devices.moveSiteSubmit().click(),
      ]);
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { results: Array<{ outcome: string }>; summary: { moved: number } };
      expect(body.summary.moved).toBe(1);
      expect(body.results[0]?.outcome).toBe('moved');
    });

    test('the new site count is 1 and its link lands on that device', async () => {
      const sites = new SitesPage(page);
      const devices = new DevicesPage(page);
      await sites.goto();
      await expect(sites.deviceCountLink(newSiteId)).toHaveText(/^\s*1\b/,{ timeout: 15_000 });
      const href = (await sites.deviceCountLink(newSiteId).getAttribute('href')) ?? '';
      expect(href).toContain(`orgId=${seed.orgAId}`);
      expect(href).toContain('deviceClass=agent');
      expect(href).toContain('filtersV2=');
      expect(await sites.deviceCount(seed.siteAId), 'Default Site count after the move').toBe(siteACountBefore - 1);

      await sites.deviceCountLink(newSiteId).click();
      await expect(devices.heading()).toBeVisible({ timeout: 15_000 });
      // "{shown} of {fleet total}": the site filter leaves exactly one row.
      await expect(devices.countLine()).toHaveText(/^\s*1 of \d+ devices?/, { timeout: 15_000 });
      await expect(devices.rowCell(seed.deviceAId)).toBeVisible();
    });
  });

  test.describe('fleet admin, mixed organizations', () => {
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser, workerStorageState }) => {
      ctx = await browser.newContext({ storageState: workerStorageState });
      // Fleet view: the header's org switcher has no data-testid, so choose
      // "All organizations" through its persisted selection (what the pill
      // leaves behind); otherwise the list is scoped to the Default Organization.
      await ctx.addInitScript(() => {
        try {
          const raw = localStorage.getItem('breeze-org');
          const saved = raw ? JSON.parse(raw) : { state: {}, version: 0 };
          saved.state = { ...saved.state, currentOrgId: null, allOrgs: true };
          localStorage.setItem('breeze-org', JSON.stringify(saved));
        } catch {
          /* storage unavailable */
        }
      });
      page = await ctx.newPage();
    });
    test.afterAll(async ({ workerStorageState }) => {
      if (ctx) await persistStorageState(ctx, workerStorageState);
      await ctx?.close();
    });

    test('bulk move is disabled with a reason for devices of two organizations', async () => {
      const devices = new DevicesPage(page);
      await devices.gotoAgents();
      await expect(devices.rowSelect(seed.deviceAId)).toBeVisible({ timeout: 15_000 });
      await expect(devices.rowSelect(seed.deviceBId)).toBeVisible();
      await devices.rowSelect(seed.deviceAId).check();
      await devices.rowSelect(seed.deviceBId).check();
      await devices.bulkActionsTrigger().click();
      await expect(devices.bulkMoveSite()).toBeDisabled();
      await expect(devices.bulkMoveSiteDisabledReason()).toHaveText('Selected devices belong to more than one organization');
    });
  });
});
