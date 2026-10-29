import type { APIRequestContext, BrowserContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { persistStorageState } from '../auth-state';

/**
 * Partner settings W2 (#9788): one header Save. One flow per save kind (spec
 * §11): a form field saved by the header Save, an autosave switch, a list row,
 * and the status line across tabs. W4 (#9790): the per-field badge and line,
 * and the org drill-down behind a count. data-testid selectors only.
 *
 * One browser context for the file (same reason as partner-sending-domains:
 * reloads rotate the refresh token, and a second fresh context would present
 * a stale cookie). Every flow puts back what it changed.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.beforeEach(clearRefreshState);

const PARTNERS_ME = '/api/v1/orgs/partners/me';
const LOGIN_BRANDING = '/api/v1/partners/me/login-branding';
const INHERITANCE = '/api/v1/orgs/partners/me/settings-inheritance';
const isWrite = (path: string, method: string) => (r: Request) =>
  new URL(r.url()).pathname === path && r.method() === method;

/** The app's own bearer token, lifted off one of its API calls (never minted: a refresh would rotate the cookie). */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
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

/** The seed's baseline org, selected by slug/name, never by list order. */
async function seededOrgId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get('/api/v1/orgs/organizations', { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok(), `GET organizations → ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { data?: Array<{ id: string; slug?: string; name?: string }> };
  const id = body.data?.find((o) => o.slug === 'default-organization' || o.name === 'Default Organization')?.id;
  expect(id, 'the seeded Default Organization').toBeTruthy();
  return id as string;
}

test.describe('Partner settings save model', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, workerStorageState }) => {
    ctx = await browser.newContext({ storageState: workerStorageState });
    page = await ctx.newPage();
  });
  test.afterAll(async ({ workerStorageState }) => {
    if (ctx) await persistStorageState(ctx, workerStorageState);
    await ctx?.close();
  });

  const status = () => page.getByTestId('partner-settings-status');
  const save = () => page.getByTestId('partner-settings-save');

  async function open(hash: string) {
    await page.goto(`/settings/partner#${hash}`);
    await expect(page.getByTestId('partner-settings-panel-heading')).toBeVisible();
    await expect(status()).toBeVisible();
  }

  async function headerSave(...expected: Array<(r: Request) => boolean>) {
    const requests: Request[] = [];
    const listener = (r: Request) => { if (expected.some(m => m(r))) requests.push(r); };
    page.on('request', listener);
    const responses = expected.map(m => page.waitForResponse(res => m(res.request())));
    await save().click();
    for (const res of await Promise.all(responses)) expect(res.status()).toBe(200);
    page.off('request', listener);
    await expect(status()).toHaveAttribute('data-state', 'clean');
    return requests;
  }

  test('form via header Save', async () => {
    await open('defaults');
    const ttl = page.getByTestId('partner-enrollment-ttl');
    const original = await ttl.inputValue();
    const values = await ttl.locator('option').evaluateAll(os => os.map(o => (o as HTMLOptionElement).value));
    const next = values.find(v => v !== original)!;
    await ttl.selectOption(next);
    await expect(status()).toHaveAttribute('data-state', 'dirty');
    await expect(status()).toContainText('Defaults');
    const [patch] = await headerSave(isWrite(PARTNERS_ME, 'PATCH'));
    expect(patch.postDataJSON().settings.defaults).toBeDefined();
    await expect(page.getByTestId('toast-container')).toContainText('Partner settings saved');
    await expect(save()).toBeDisabled();

    // Put it back.
    await ttl.selectOption(original);
    if (await save().isEnabled()) await headerSave(isWrite(PARTNERS_ME, 'PATCH'));
  });

  test('autosave switch', async () => {
    await open('ai-features');
    const ml = page.getByTestId('partner-ml-anomalies-enabled');
    await expect(ml).toHaveAttribute('role', 'switch');
    const before = await ml.getAttribute('aria-checked');

    // Nothing else dirty: the status line reports the autosave.
    const first = page.waitForRequest(isWrite(PARTNERS_ME, 'PATCH'));
    await ml.click();
    expect(Object.keys((await first).postDataJSON().settings)).toEqual(['ml']);
    await expect(status()).toContainText('Saved ·');
    await expect(ml).not.toHaveAttribute('aria-checked', before ?? 'false');

    // An unrelated Company draft survives the autosave and stays unsaved.
    await page.getByTestId('partner-settings-tab-company').click();
    await page.getByTestId('partner-email-signature').fill(`Draft ${Date.now()}`);
    await page.getByTestId('partner-settings-tab-aiFeatures').click();
    const second = page.waitForRequest(isWrite(PARTNERS_ME, 'PATCH'));
    await page.getByTestId('partner-ml-anomalies-enabled').click();
    const body = (await second).postDataJSON();
    expect(Object.keys(body)).toEqual(['settings']);
    expect(Object.keys(body.settings)).toEqual(['ml']);
    await expect(page.getByTestId('partner-ml-anomalies-enabled')).toHaveAttribute('aria-checked', before ?? 'false');
    await expect(status()).toHaveText('Unsaved changes in Company.');
  });

  test('list row', async () => {
    await open('known-guests');
    const mac = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
    await page.getByTestId('known-guests-mac').fill(mac);
    await page.getByTestId('known-guests-label').fill('E2E visitor');
    await page.getByTestId('known-guests-add').click();
    await expect(page.getByTestId(`known-guests-row-${mac}`)).toBeVisible();
    await expect(page.getByTestId('toast-container')).toContainText('Known guest added');
    await page.getByTestId(`known-guests-remove-${mac}`).click();
    await expect(page.getByTestId(`known-guests-row-${mac}`)).toHaveCount(0);
    await expect(page.getByTestId('toast-container')).toContainText('Known guest removed');
  });

  test('status across tabs', async () => {
    await open('login-branding');
    const headline = page.getByTestId('login-branding-headline');
    const originalHeadline = await headline.inputValue();
    await headline.fill(`E2E headline ${Date.now()}`);
    await page.getByTestId('partner-settings-tab-company').click();
    const signature = page.getByTestId('partner-email-signature');
    const originalSignature = await signature.inputValue();
    await signature.fill(`E2E signature ${Date.now()}`);
    await expect(status()).toHaveText('Unsaved changes in Company, Login Branding.');

    const requests = await headerSave(isWrite(PARTNERS_ME, 'PATCH'), isWrite(LOGIN_BRANDING, 'PUT'));
    // Rail order: partners/me (Company) before the Login page.
    expect(requests.map(r => new URL(r.url()).pathname)).toEqual([PARTNERS_ME, LOGIN_BRANDING]);

    // Put both back.
    await signature.fill(originalSignature);
    await page.getByTestId('partner-settings-tab-loginBranding').click();
    await page.getByTestId('login-branding-headline').fill(originalHeadline);
    if (await save().isEnabled()) {
      await save().click();
      await expect(status()).toHaveAttribute('data-state', 'clean');
    }
  });

  test('badge and line on Defaults', async () => {
    const read = page.waitForResponse(r => new URL(r.url()).pathname === INHERITANCE && new URL(r.url()).searchParams.get('tab') === 'defaults');
    await open('defaults');
    expect((await read).status()).toBe(200);
    await expect(page.getByTestId('partner-settings-badge-legend')).toBeVisible();
    await expect(page.getByTestId('partner-settings-badge-defaults.agentUpdatePolicy')).toHaveText('Locks orgs');
    await expect(page.getByTestId('partner-settings-badge-defaults.defaultEnrollmentTtlMinutes')).toContainText('Org can override, up to');
    await expect(page.getByTestId('partner-settings-badge-defaults.maxEnrollmentLinkTtlMinutes')).toHaveText('Partner-wide');
    await expect(page.getByTestId('partner-settings-line-defaults.agentUpdatePolicy')).toContainText(/\borgs?\b/i);
    await expect(page.getByTestId('partner-settings-line-defaults.maxEnrollmentLinkTtlMinutes')).toContainText('applies to all orgs');
    // The per-tab "enforced" banner is gone (spec §5.1).
    await expect(page.getByText(/enforced across all organizations/i)).toHaveCount(0);
  });

  test('drill-down opens and links to an org', async () => {
    // Give the seeded org its own default devices-per-link, from the org's own settings.
    const orgId = await seededOrgId(page.request, await readAccessToken(page));
    await page.goto(`/settings/organizations/${orgId}#general`);
    const orgCount = page.getByTestId('org-default-enrollment-device-count');
    await expect(orgCount).toBeVisible();
    const original = await orgCount.inputValue();
    const own = original === '7' ? '8' : '7';
    await orgCount.fill(own);
    const saved = page.waitForResponse(r => r.request().method() !== 'GET' && new URL(r.url()).pathname.includes(`/orgs/organizations/${orgId}`));
    await page.getByTestId('save-defaults').click();
    expect((await saved).ok()).toBeTruthy();

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open('defaults');
      const line = page.getByTestId('partner-settings-line-defaults.defaultEnrollmentDeviceCount');
      const count = line.locator('button');
      await expect(count).toBeVisible();
      await count.click();
      const drawer = page.getByTestId('partner-settings-drilldown-drawer');
      await expect(drawer).toBeVisible();
      const row = drawer.getByTestId(`partner-settings-drilldown-row-${orgId}`);
      await expect(row).toContainText(own);
      await expect(row.getByRole('link')).toHaveAttribute('href', `/settings/organizations/${orgId}#general`);
      await page.getByTestId('partner-settings-drilldown-drawer-close').click();

      // At 1920 px the same list opens in the side panel instead of a drawer.
      await page.setViewportSize({ width: 1920, height: 1080 });
      const panel = page.getByTestId('partner-settings-side-panel');
      await expect(panel).toBeVisible();
      await line.locator('button').click();
      await expect(panel.getByTestId(`partner-settings-drilldown-row-${orgId}`)).toBeVisible();
      await expect(drawer).toHaveCount(0);
    } finally {
      // Put it back.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`/settings/organizations/${orgId}#general`);
      await page.getByTestId('org-default-enrollment-device-count').fill(original);
      const restored = page.waitForResponse(r => r.request().method() !== 'GET' && new URL(r.url()).pathname.includes(`/orgs/organizations/${orgId}`));
      await page.getByTestId('save-defaults').click();
      await restored;
    }
  });
});
