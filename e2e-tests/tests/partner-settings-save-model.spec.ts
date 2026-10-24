import type { BrowserContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { persistStorageState } from '../auth-state';

/**
 * Partner settings W2 (#9788): one header Save. One flow per save kind (spec
 * §11): a form field saved by the header Save, an autosave switch, a list row,
 * and the status line across tabs. data-testid selectors only.
 *
 * One browser context for the file (same reason as partner-sending-domains:
 * reloads rotate the refresh token, and a second fresh context would present
 * a stale cookie). Every flow puts back what it changed.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.beforeEach(clearRefreshState);

const PARTNERS_ME = '/api/v1/orgs/partners/me';
const LOGIN_BRANDING = '/api/v1/partners/me/login-branding';
const isWrite = (path: string, method: string) => (r: Request) =>
  new URL(r.url()).pathname === path && r.method() === method;

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
    const next = original === '72' ? '48' : '72';
    await ttl.fill(next);
    await expect(status()).toHaveAttribute('data-state', 'dirty');
    await expect(status()).toContainText('Defaults');
    const [patch] = await headerSave(isWrite(PARTNERS_ME, 'PATCH'));
    expect(patch.postDataJSON().settings.defaults).toBeDefined();
    await expect(page.getByTestId('toast-container')).toContainText('Partner settings saved');
    await expect(save()).toBeDisabled();

    // Put it back.
    await ttl.fill(original);
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
    const mac = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':').toUpperCase();
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
});
