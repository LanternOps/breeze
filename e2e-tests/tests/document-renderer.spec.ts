import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { QuotesPage } from '../pages/QuotesPage';

/**
 * One Document Renderer — W1 slice (#9414, spec §8.2): the invoice on the web
 * Preview and the public portal link render the same shared composition.
 *
 * The API envelopes are fulfilled from one invented DTO so both surfaces get
 * byte-identical input; what is under test is the front end (shared package,
 * accent delivery, CSS isolation), not the assembler (covered by API tests).
 *
 * CSP: the dev portal deletes its CSP header (Astro hashes exist only in a
 * production build, and a strict script policy would stop dev hydration), so the
 * one production directive that bears on the accent, `style-src-attr 'none'`
 * (apps/portal/src/lib/csp.ts), is injected on the page response. The
 * `style.setProperty` accent write is then proven against exactly that directive.
 */

const ACCENT = '#0a7c5c';
const INVOICE_ID = '00000000-0000-4000-8000-0000000000a1';
const TOKEN = 'spec-token';

const LINES = [
  { id: '00000000-0000-4000-8000-000000000101', ticketNumber: '42', ticketCategory: 'Support', name: 'Remote support', description: 'Reset the mail profile\nVerified sync', quantity: '1.5', unitPrice: '100.00', taxable: false, lineTotal: '150.00', workedMinutes: 90, workDate: '2026-02-26' },
  { id: '00000000-0000-4000-8000-000000000102', ticketNumber: null, ticketCategory: null, name: null, description: 'Monthly monitoring', quantity: '1', unitPrice: '100.00', taxable: false, lineTotal: '100.00', workedMinutes: null, workDate: null },
];
const INVOICE = {
  id: INVOICE_ID, invoiceNumber: 'INV-0042', status: 'sent', displayStatus: 'sent', currencyCode: 'USD',
  issueDate: '2026-03-01', dueDate: '2026-03-31', subtotal: '250.00', taxRate: null, taxTotal: '0.00', total: '250.00',
  amountPaid: '0.00', balance: '250.00', depositDue: null, billToName: 'Acme Dental', billToAddress: null, billToTaxId: null,
  terms: null, notes: 'Thank you for your business.', termsAndConditions: 'Payment due within 30 days.',
  sellerSnapshot: { name: 'Example MSP', address: null, phone: null, email: 'billing@example-msp.test', website: null },
  lineGrouping: 'entry',
};
const BRANDING = { partnerName: 'Example MSP', contactEmail: 'billing@example-msp.test', logoUrl: null, primaryColor: ACCENT, theme: 'classic', pageSize: 'letter' };
const CUSTOMER_DOC = { invoice: INVOICE, lines: LINES, branding: BRANDING, documentLocale: 'en' };

// The staff workspace payload (only what the Preview tab and workspace chrome read).
const STAFF_DETAIL = {
  autopay: null,
  invoice: { ...INVOICE, orgId: '11111111-1111-4111-8111-111111111111', siteId: null, sentAt: '2026-03-01T00:00:00Z', createdAt: '2026-03-01T00:00:00Z' },
  lines: [],
  branding: null,
};

async function mockStaff(page: Page) {
  await page.route(new RegExp(`/api/v1/invoices/${INVOICE_ID}/customer-view(\\?.*)?$`), (r) => r.fulfill({ json: { data: CUSTOMER_DOC } }));
  await page.route(new RegExp(`/api/v1/invoices/${INVOICE_ID}(\\?.*)?$`), (r) => r.fulfill({ json: { data: STAFF_DETAIL } }));
}

async function mockPublic(page: Page) {
  await page.route(new RegExp(`/api/v1/invoices/public/${TOKEN}(\\?.*)?$`), (r) =>
    r.fulfill({ json: { data: { ...CUSTOMER_DOC, chargeNow: null, payable: false } } }));
}

/** Pin the document to one width so two layouts (web column vs portal column) are comparable. */
async function pinWidth(root: ReturnType<Page['getByTestId']>) {
  await root.evaluate((el) => { (el as HTMLElement).style.width = '768px'; (el as HTMLElement).style.maxWidth = '768px'; });
}

/** Take host chrome that floats over the paper out of the capture: every fixed or sticky element
 *  that is not the document itself (workspace header, payment rail, onboarding tour, dev toolbar). */
async function clearOverlays(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="document-root"]');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const pos = getComputedStyle(el).position;
      if ((pos === 'fixed' || pos === 'sticky') && root && !el.contains(root) && !root.contains(el)) el.style.visibility = 'hidden';
    }
  });
}

/** Fraction of pixels differing by more than a small per-channel threshold, computed in the browser. */
async function diffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(async ([x, y]) => {
    const load = (b64: string) => new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = `data:image/png;base64,${b64}`;
    });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return 1;
    const px = (img: HTMLImageElement) => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const da = px(ia), db = px(ib);
    let diff = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > 24 || Math.abs(da[i + 1] - db[i + 1]) > 24 || Math.abs(da[i + 2] - db[i + 2]) > 24) diff++;
    }
    return diff / (da.length / 4);
  }, [a.toString('base64'), b.toString('base64')] as const);
}

// Sub-pixel font metrics may differ between the two apps' Tailwind builds; the
// tolerance below is the value tuned on the first run (stated in the PR body).
const MAX_DIFF_RATIO = 0.02;

test('public invoice under style-src-attr none: accent present, no CSP violations', async ({ cleanPage }) => {
  const consoleCsp: string[] = [];
  cleanPage.on('console', (m) => { if (/content security policy/i.test(m.text())) consoleCsp.push(m.text()); });
  await cleanPage.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(`${e.violatedDirective} ${e.blockedURI} <${(e.target as Element | null)?.tagName ?? '?'} ${((e.target as Element | null)?.getAttribute?.('class') ?? '').slice(0, 60)} ${((e.target as Element | null)?.getAttribute?.('data-testid') ?? '')}> ${e.sample}`));
  });
  await cleanPage.route(`**/portal/invoice/${TOKEN}*`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "style-src-attr 'none'" } });
  });
  await mockPublic(cleanPage);
  await cleanPage.goto(`/portal/invoice/${TOKEN}`);

  const root = cleanPage.getByTestId('document-root');
  await expect(root).toBeVisible();
  // D17: the accent arrives after the client fetch, through CSSOM on the host wrapper.
  const bar = root.locator('.doc-accent-bg').first();
  await expect.poll(() => bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(10, 124, 92)');
  // Astro's dev toolbar (dev-only, absent from a production build) writes its own style attributes; not the document's.
  const violations = (await cleanPage.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations))
    .filter((v) => !v.includes('<ASTRO-DEV-TOOLBAR'));
  expect(violations).toEqual([]);
  // The console reports the same blocked styles the events above name; the toolbar's account for all of them.
  expect(consoleCsp.length).toBe((await cleanPage.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).length - violations.length);
});

test('Preview and public page render the same invoice (screenshot pair at 1280px)', async ({ authedPage, cleanPage }) => {
  await authedPage.setViewportSize({ width: 1280, height: 1500 });
  await cleanPage.setViewportSize({ width: 1280, height: 1500 });
  await mockStaff(authedPage);
  await mockPublic(cleanPage);

  await authedPage.goto(`/billing/invoices/${INVOICE_ID}#preview`);
  const previewRoot = authedPage.getByTestId('document-root');
  await expect(previewRoot).toBeVisible();
  await cleanPage.goto(`/portal/invoice/${TOKEN}`);
  const publicRoot = cleanPage.getByTestId('document-root');
  await expect(publicRoot).toBeVisible();
  await expect(publicRoot.locator('.doc-accent-bg').first()).toHaveCSS('background-color', 'rgb(10, 124, 92)');

  await pinWidth(previewRoot);
  await pinWidth(publicRoot);
  await clearOverlays(authedPage);
  await clearOverlays(cleanPage);
  const a = await previewRoot.screenshot();
  const b = await publicRoot.screenshot();
  const ratio = await diffRatio(authedPage, a, b);
  test.info().annotations.push({ type: 'diff-ratio', description: String(ratio) });
  writeFileSync(test.info().outputPath('preview.png'), a);
  writeFileSync(test.info().outputPath('public.png'), b);
  await test.info().attach('preview.png', { body: a, contentType: 'image/png' });
  await test.info().attach('public.png', { body: b, contentType: 'image/png' });
  expect(ratio).toBeLessThanOrEqual(MAX_DIFF_RATIO);
});

test('web dense density does not re-space the Preview paper', async ({ authedPage }) => {
  await authedPage.setViewportSize({ width: 1280, height: 1500 });
  await mockStaff(authedPage);
  await authedPage.goto(`/billing/invoices/${INVOICE_ID}#preview`);
  const root = authedPage.getByTestId('document-root');
  await expect(root).toBeVisible();
  await pinWidth(root);
  await clearOverlays(authedPage);

  await authedPage.evaluate(() => document.documentElement.setAttribute('data-density', 'comfortable'));
  const comfortable = await root.screenshot();
  const padComfortable = await root.locator('> div').nth(1).evaluate((el) => getComputedStyle(el).padding);
  await authedPage.evaluate(() => document.documentElement.setAttribute('data-density', 'dense'));
  const dense = await root.screenshot();
  const padDense = await root.locator('> div').nth(1).evaluate((el) => getComputedStyle(el).padding);

  expect(padDense).toBe(padComfortable);
  expect(await diffRatio(authedPage, comfortable, dense)).toBe(0);
});

// ---- W2b (#9419): the quote pair ------------------------------------------------------------
// The public proposal page is server-rendered, so its API call cannot be intercepted from the
// browser: these tests drive a REAL quote (create → one manual line → send) and compare the
// staff Preview with the customer's public link for it.

async function sendRealQuote(authedPage: Page): Promise<{ quoteId: string; token: string }> {
  const quotes = new QuotesPage(authedPage);
  await quotes.goto();
  await quotes.createOpen().click();
  await quotes.createDialog().waitFor();
  const orgId = await quotes.createOrg().locator('option:not([value=""])').first().getAttribute('value');
  await quotes.createDialog().press('Escape');
  const quoteId = await quotes.create(orgId!, `Renderer proposal ${Date.now()}`);
  await quotes.addManualPricingLine('Onboarding', '400.00');
  await quotes.sendButton().click();
  await quotes.sendConfirm().waitFor();
  await authedPage.getByTestId('quote-send-to').fill('e2e-recipient@example.com');
  const [scheduled] = await Promise.all([
    authedPage.waitForResponse((r) => r.request().method() === 'POST' && /\/quotes\/[^/]+\/schedule-send$/.test(new URL(r.url()).pathname), { timeout: 20_000 }),
    quotes.sendConfirm().click(),
  ]);
  expect(scheduled.ok()).toBeTruthy();
  const [sent] = await Promise.all([
    authedPage.waitForResponse((r) => r.request().method() === 'POST' && /\/quotes\/[^/]+\/send$/.test(new URL(r.url()).pathname), { timeout: 30_000 }),
    quotes.sendNow().click(),
  ]);
  expect(sent.ok()).toBeTruthy();
  const { acceptUrl } = (await sent.json()).data as { acceptUrl: string };
  const token = decodeURIComponent(acceptUrl.split('/').filter(Boolean).pop() ?? '');
  expect(token.length).toBeGreaterThan(10);
  return { quoteId, token };
}

test('public quote under style-src-attr none: renders the shared document, no CSP violations', async ({ authedPage, cleanPage }) => {
  const { token } = await sendRealQuote(authedPage);
  await cleanPage.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(`${e.violatedDirective} <${(e.target as Element | null)?.tagName ?? '?'}>`));
  });
  await cleanPage.route(`**/portal/quote/${token}*`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "style-src-attr 'none'" } });
  });
  const origin = new URL(authedPage.url()).origin;
  await cleanPage.goto(`${origin}/portal/quote/${token}`);
  const root = cleanPage.getByTestId('document-root');
  await expect(root).toBeVisible();
  await expect(root.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(root).toContainText('Onboarding');
  await expect(root.locator('.doc-accent-bg').first()).toBeVisible();
  const violations = (await cleanPage.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations))
    .filter((v) => !v.includes('<ASTRO-DEV-TOOLBAR'));
  expect(violations).toEqual([]);
});

test('quote Preview and public page render the same proposal (screenshot pair at 1280px)', async ({ authedPage, cleanPage }) => {
  await authedPage.setViewportSize({ width: 1280, height: 1500 });
  await cleanPage.setViewportSize({ width: 1280, height: 1500 });
  const { quoteId, token } = await sendRealQuote(authedPage);
  await authedPage.goto(`/billing/quotes/${quoteId}#preview`);
  const previewRoot = authedPage.getByTestId('document-root');
  await expect(previewRoot).toBeVisible();
  const origin = new URL(authedPage.url()).origin;
  await cleanPage.goto(`${origin}/portal/quote/${token}`);
  const publicRoot = cleanPage.getByTestId('document-root');
  await expect(publicRoot).toBeVisible();

  // The signature region is host chrome (inert marker vs the real panel) and the pill reads the
  // same on both; hide the slot so the pair compares the document itself.
  for (const page of [authedPage, cleanPage]) {
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('[data-slot="signature"]').forEach((el) => { el.style.display = 'none'; }));
  }
  await pinWidth(previewRoot);
  await pinWidth(publicRoot);
  await clearOverlays(authedPage);
  await clearOverlays(cleanPage);
  const a = await previewRoot.screenshot();
  const b = await publicRoot.screenshot();
  const ratio = await diffRatio(authedPage, a, b);
  test.info().annotations.push({ type: 'diff-ratio', description: String(ratio) });
  await test.info().attach('quote-preview.png', { body: a, contentType: 'image/png' });
  await test.info().attach('quote-public.png', { body: b, contentType: 'image/png' });
  expect(ratio).toBeLessThanOrEqual(MAX_DIFF_RATIO);
});
