import { test, expect } from '../fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cross-tenant isolation through the browser.
 *
 * The RLS and route integration suites prove isolation at the database and
 * API layer. This spec proves it on the path a real user takes: signed in to
 * the web app as tenant A (the seeded admin), deep-link to tenant B's pages
 * and call tenant B's API resources with A's own session.
 *
 * Every probe has a POSITIVE CONTROL: the same URL, fetched as tenant B's own
 * admin, must return the resource and show the marker. Without it, a mistyped
 * id or a broken page would pass the negative probe and prove nothing.
 *
 * Tenant B is seeded by seed-tenant-isolation.sql. Every row B could leak
 * through carries MARKER.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MARKER = 'E2E-TENANT-B-SECRET';
const TENANT_B_EMAIL = 'tenant-b@breeze.local';
const LIST_PAGES = ['/devices', '/alerts', '/organizations'];

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d.pgContainer) return d.pgContainer;
  }
  return 'breeze-postgres';
}

interface TenantB {
  orgId: string;
  siteId: string;
  deviceId: string;
  alertId: string;
}

function seedTenantB(): TenantB {
  const out = execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(path.resolve(__dirname, '..', 'seed-tenant-isolation.sql'), 'utf8') },
  );
  const pick = (key: string) => {
    const id = new RegExp(`${key}=([0-9a-f-]{36})`).exec(out)?.[1];
    if (!id) throw new Error(`seed did not report ${key}:\n${out}`);
    return id;
  };
  return { orgId: pick('ORG_ID'), siteId: pick('SITE_ID'), deviceId: pick('DEVICE_ID'), alertId: pick('ALERT_ID') };
}

/** Captures the bearer token the app attaches to its own /api/v1 calls. */
async function sniffToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: { headers(): Record<string, string>; url(): string }) => {
    const header = req.headers()['authorization'];
    if (!token && header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/');
    await expect.poll(() => token, { message: 'an authenticated /api/v1 request', timeout: 30_000 }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

/** Signs tenant B's admin in through the real login form in a fresh context. */
async function loginAsTenantB(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!password) throw new Error('E2E_ADMIN_PASSWORD must be set (tenant B shares the seeded admin password)');
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('[data-testid="login-email-input"]').fill(TENANT_B_EMAIL);
  await page.locator('[data-testid="login-password-input"]').fill(password);
  await page.locator('[data-testid="login-submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await page.close();
  return ctx;
}

/** API resources that belong to tenant B. */
function apiProbes(b: TenantB): Array<{ name: string; url: string }> {
  return [
    { name: 'device detail', url: `/api/v1/devices/${b.deviceId}` },
    { name: 'organization detail', url: `/api/v1/orgs/organizations/${b.orgId}` },
    { name: 'site detail', url: `/api/v1/orgs/sites/${b.siteId}` },
    { name: 'alert detail', url: `/api/v1/alerts/${b.alertId}` },
    { name: 'device list filtered to B org', url: `/api/v1/devices?orgId=${b.orgId}` },
    { name: 'alert list filtered to B org', url: `/api/v1/alerts?orgId=${b.orgId}` },
  ];
}

/** Web pages that render tenant B's resources. */
function pageProbes(b: TenantB): Array<{ name: string; url: string; apiFragment: string }> {
  return [
    { name: 'device page', url: `/devices/${b.deviceId}`, apiFragment: b.deviceId },
    { name: 'organization page', url: `/organizations/${b.orgId}`, apiFragment: b.orgId },
    { name: 'alert page', url: `/alerts/${b.alertId}`, apiFragment: b.alertId },
  ];
}

/** Loads a page and waits for the app's API call for that resource to finish. */
async function loadResourcePage(page: Page, url: string, apiFragment: string): Promise<string> {
  const settled = page.waitForResponse(
    (r) => r.url().includes('/api/v1/') && r.url().includes(apiFragment),
    { timeout: 30_000 },
  );
  await page.goto(url);
  await settled;
  await page.waitForLoadState('networkidle');
  return page.content();
}

// Independent tests: a failing positive control must not hide a leaking negative probe.
test.describe.configure({ mode: 'default' });

test.describe('Tenant isolation (browser)', () => {
  let b: TenantB;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let tokenA: string;
  let tokenB: string;
  test.setTimeout(180_000);

  test.beforeAll(async ({ browser, workerStorageState }, testInfo) => {
    b = seedTenantB();
    const baseURL = testInfo.project.use.baseURL as string;
    ctxA = await browser.newContext({ baseURL, storageState: workerStorageState });
    ctxB = await loginAsTenantB(browser, baseURL);
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    tokenA = await sniffToken(pageA);
    tokenB = await sniffToken(pageB);
    expect(tokenA).not.toBe(tokenB);
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('tenant B can read its own resources (positive control)', async () => {
    for (const probe of apiProbes(b)) {
      const res = await pageB.request.get(probe.url, { headers: { authorization: `Bearer ${tokenB}` } });
      expect(res.status(), `${probe.name} as tenant B`).toBe(200);
      expect(await res.text(), `${probe.name} as tenant B carries the marker`).toContain(MARKER);
    }
  });

  test('tenant A cannot read tenant B resources through the API', async () => {
    for (const probe of apiProbes(b)) {
      const res = await pageA.request.get(probe.url, { headers: { authorization: `Bearer ${tokenA}` } });
      const body = await res.text();
      expect(body, `${probe.name} as tenant A leaked tenant B data (HTTP ${res.status()})`).not.toContain(MARKER);
      if (!probe.url.includes('?')) {
        expect([403, 404], `${probe.name} as tenant A → HTTP ${res.status()}`).toContain(res.status());
      }
    }
  });

  test('tenant B pages render its own data (positive control)', async () => {
    for (const probe of pageProbes(b)) {
      const html = await loadResourcePage(pageB, probe.url, probe.apiFragment);
      expect(html, `${probe.name} as tenant B shows the marker`).toContain(MARKER);
    }
  });

  test('tenant A deep links to tenant B pages show none of its data', async () => {
    for (const probe of pageProbes(b)) {
      const html = await loadResourcePage(pageA, probe.url, probe.apiFragment);
      expect(html, `${probe.name} as tenant A rendered tenant B data`).not.toContain(MARKER);
    }
  });

  test('tenant B lists include its own rows (positive control)', async () => {
    for (const url of LIST_PAGES) {
      await pageB.goto(url);
      await pageB.waitForLoadState('networkidle');
      await expect.poll(() => pageB.content(), { message: `${url} as tenant B shows the marker`, timeout: 15_000 }).toContain(MARKER);
    }
  });

  // The devices and alerts list pages are scoped to the viewer's selected org,
  // so for a multi-org tenant A they are a weak probe on their own; the
  // org-filtered API list probes above cover those two lists directly. The
  // organizations list is tenant-wide and was shown to catch a moved org.
  test('tenant A lists never include tenant B rows', async () => {
    for (const url of LIST_PAGES) {
      await pageA.goto(url);
      await pageA.waitForLoadState('networkidle');
      expect(await pageA.content(), `${url} as tenant A`).not.toContain(MARKER);
    }
  });
});
