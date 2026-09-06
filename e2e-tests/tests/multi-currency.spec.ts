import type { APIRequestContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { waitForAppReady, waitForHydration } from '../pages/hydration';
import { OrgBillingSettingsPage } from '../pages/OrgBillingSettingsPage';
import { InvoicesPage } from '../pages/InvoicesPage';
import { QuotesPage } from '../pages/QuotesPage';

/**
 * Multi-currency wave 6 (#3778) — the §14 browser slices.
 *
 * Spec §14 asks for the wave-6 release-gate slices "run against a non-USD org
 * on a USD partner". The seven gate slices themselves live under
 * `apps/api/src/__tests__/integration/multiCurrencyWave6*.integration.test.ts`,
 * against real Postgres — that is where a zero-decimal persistence boundary, a
 * Stripe minor-unit payload and a two-client lock race are actually provable,
 * and a browser cannot prove any of them. What a browser CAN prove is the part
 * a user drives, so this spec covers the three UI-reachable slices:
 *
 *   A. org currency selection — preview, confirm, round-trip, and the
 *      future-only guarantee (an already-issued USD invoice is untouched);
 *   B. a manual invoice created and issued inside the non-USD org renders that
 *      org's currency and never `$`;
 *   C. a quote sent from the non-USD org, accepted on the public portal link,
 *      produces an invoice that also renders that currency.
 *
 * Fixtures are created inline against the real API (the same approach
 * `quote-contract-proposal.spec.ts` takes — no seeded quote/invoice/org
 * fixtures exist): a fresh org under the stack's USD partner, which slice A
 * itself is what moves to EUR. That ordering is deliberate — it makes the org
 * currency a THING THE TEST CHANGED THROUGH THE UI rather than a seeded
 * constant, and it gives slice A a real "existing document" to protect.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

/** Serial-mode state produced by slice A and consumed by slices B and C. */
let orgId = '';
let issuedUsdInvoiceId = '';

const stamp = Date.now();

/**
 * Recover the access token the app itself is using, by watching one of its own
 * authenticated API calls.
 *
 * The auth store persists only the user profile to localStorage — the access
 * token lives in memory and the durable credential is the httpOnly refresh
 * cookie. Minting a fresh token here (POST /auth/refresh) would ROTATE that
 * cookie and revoke the page's own JTI mid-test, so the token is lifted off an
 * outgoing request header instead: read-only, and always the exact token the
 * session is already using.
 */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    if (token) return;
    const header = req.headers()['authorization'];
    if (header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    // The dashboard fires several authenticated API calls on load.
    await page.goto('/');
    await expect.poll(() => token, {
      message: 'an authenticated /api/v1 request from the app',
      timeout: 30_000,
    }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

async function apiJson<T>(
  request: APIRequestContext, token: string, method: 'get' | 'post' | 'patch',
  path: string, data?: unknown,
): Promise<T> {
  const res = await request[method](path, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

test.describe('multi-currency — non-USD org browser slices', () => {
  // All three slices run inside ONE test, one browser context, one login — the
  // same shape quote-contract-proposal.spec.ts uses. Splitting them into
  // separate tests hands each a fresh context built from the SAME storageState,
  // so the second context replays an already-rotated refresh token; the API's
  // reuse detection then revokes the whole family and the page bounces to
  // /login ("Your session expired"). `clearRefreshState` clears `refresh:*` and
  // `token:refresh:revoked:*` but not the family/grace keys, so it does not
  // cover that case. The slices are sequential by nature anyway — B and C need
  // the EUR org that A creates.
  test('org currency selection, manual invoice, and quote acceptance in a EUR org', async ({ authedPage: page, browser }) => {
    test.setTimeout(300_000);
    const billing = new OrgBillingSettingsPage(page);
    const invoices = new InvoicesPage(page);
    const quotes = new QuotesPage(page);

    const token = await readAccessToken(page);

    await test.step('slice A: org currency selection previews, confirms, and leaves issued documents alone', async () => {
      // ── Fixture: a fresh org, which inherits the partner's currency ──────
      // NOTE the response shapes here are not uniform: the organizations routes
      // return the row unwrapped, the billing/invoice routes wrap in `data`.
      const created = await apiJson<{ id: string; currencyCode: string }>(
        page.request, token, 'post', '/api/v1/orgs/organizations',
        { name: `E2E Multi-Currency ${stamp}`, slug: `e2e-multi-currency-${stamp}` },
      );
      orgId = created.id;
      // The org is created on a USD partner and inherits USD — the "non-USD org
      // on a USD partner" fixture §14 asks for only exists after slice A runs.
      expect(created.currencyCode).toBe('USD');

      // A billing contact (needed by the quote send composer in slice C) and an
      // org default hourly rate — the rate is what makes the pre-flight panel's
      // configuration warning non-vacuous below.
      await apiJson(page.request, token, 'patch', `/api/v1/orgs/${orgId}/billing-settings`,
        { billingContactEmail: `e2e-billing-${stamp}@example.com`, billingContactName: 'E2E Billing' });
      await apiJson(page.request, token, 'patch', `/api/v1/orgs/organizations/${orgId}/ticket-settings`,
        { defaultHourlyRate: 150 });

      // Two USD documents before the change: one ISSUED (the amount that must
      // never move) and one DRAFT (so the advisory count is a real 1, not a 0).
      const issued = await apiJson<{ data: { id: string } }>(page.request, token, 'post', '/api/v1/invoices', { orgId });
      issuedUsdInvoiceId = issued.data.id;
      await apiJson(page.request, token, 'post', `/api/v1/invoices/${issuedUsdInvoiceId}/lines`,
        { name: 'Pre-change USD work', quantity: 1, unitPrice: 250, taxable: false });
      await apiJson(page.request, token, 'post', `/api/v1/invoices/${issuedUsdInvoiceId}/issue`, {});
      const draft = await apiJson<{ data: { id: string } }>(page.request, token, 'post', '/api/v1/invoices', { orgId });
      await apiJson(page.request, token, 'post', `/api/v1/invoices/${draft.data.id}/lines`,
        { name: 'Open USD draft', quantity: 1, unitPrice: 90, taxable: false });

      // ── Step 1: select the new currency — a PREVIEW, never a mutation ────
      await billing.goto(orgId);
      await expect(billing.currencySelect()).toHaveValue('USD');

      await billing.selectCurrency('EUR');
      await expect(billing.loading()).toHaveCount(0, { timeout: 15_000 });

      // Counts are grouped by the ROW's own stamped currency (USD here), never
      // by the target, and are never summed across currencies.
      await expect(billing.group('USD')).toBeVisible();
      await expect(billing.impactCount('USD', 'draftInvoices')).toHaveText('1');
      await expect(billing.impactCount('USD', 'draftQuotes')).toHaveText('0');
      // The org default rate is stamped USD, so it stops applying after the move.
      await expect(billing.warningRate()).toBeVisible();
      // Spec §7 recovery: an explicit same-currency assembly, never a conversion.
      await expect(billing.recovery('USD')).toContainText('USD');
      await expect(billing.retention()).toBeVisible();
      await expect(billing.advisory()).toBeVisible();

      // Nothing was written yet — the STORED code is still USD.
      const beforeConfirm = await apiJson<{ currencyCode: string }>(
        page.request, token, 'get', `/api/v1/orgs/organizations/${orgId}`);
      expect(beforeConfirm.currencyCode).toBe('USD');

      // ── Step 2: confirm, then prove it round-trips across a reload ───────
      const patch = await billing.confirmChange();
      expect(patch.status()).toBe(200);

      await page.reload();
      await waitForAppReady(page, 'org-billing-settings');
      await expect(billing.currencySelect()).toHaveValue('EUR');

      // ── Step 3: no amount on an existing document changed ────────────────
      const after = await apiJson<{ data: { invoice: { currencyCode: string; total: string } } }>(
        page.request, token, 'get', `/api/v1/invoices/${issuedUsdInvoiceId}`);
      expect(after.data.invoice.currencyCode).toBe('USD');
      expect(after.data.invoice.total).toBe('250.00');

      // The org itself really did move.
      const afterOrg = await apiJson<{ currencyCode: string }>(
        page.request, token, 'get', `/api/v1/orgs/organizations/${orgId}`);
      expect(afterOrg.currencyCode).toBe('EUR');

      // …and it still RENDERS as USD, from the document's own stamp rather than
      // the org's (now EUR) setting.
      await invoices.open(issuedUsdInvoiceId);
      await expect(invoices.detailSummary()).toContainText('$250.00');
      await expect(invoices.detailSummary()).not.toContainText('€');
    });

    await test.step('slice B: a manual invoice in the EUR org renders EUR end to end', async () => {
      await invoices.goto();
      const invoiceId = await invoices.createBlankDraft(orgId);
      expect(invoiceId).toBeTruthy();

      await invoices.addManualLine(`EUR services ${stamp}`, '2', '125.50');
      // 2 × €125.50 — the editor rail formats from the invoice's stamped code.
      await expect(invoices.editorTotal()).toHaveText('€251.00');
      await expect(invoices.editorTotal()).not.toContainText('$');

      await invoices.issue();
      await expect(invoices.detailSummary()).toContainText('€251.00');
      await expect(invoices.detailSummary()).not.toContainText('$');
      await expect(invoices.detailBalance()).toHaveText('€251.00');
    });

    await test.step('slice C: quote → public acceptance → invoice, all in EUR', async () => {
      await quotes.goto();
      const quoteId = await quotes.create(orgId, `E2E EUR Proposal ${stamp}`);
      await quotes.addManualPricingLine(`Onboarding ${stamp}`, '400.00');
      await expect(quotes.totalGrand()).toHaveText('€400.00');

      const { acceptUrl } = await quotes.send();
      // acceptUrl's host reflects PUBLIC_APP_URL/PUBLIC_PORTAL_URL config, not
      // this stack's ephemeral port, so only the token segment is reusable —
      // rebuild against this page's own origin (same reasoning, and the same
      // split-on-'/' guard for a relative acceptUrl, as
      // quote-contract-proposal.spec.ts).
      const acceptToken = decodeURIComponent(acceptUrl.split('/').filter(Boolean).pop() ?? '');
      expect(acceptToken.length).toBeGreaterThan(10);

      const origin = new URL(page.url()).origin;
      const publicContext = await browser.newContext();
      try {
        const publicPage = await publicContext.newPage();
        await publicPage.goto(`${origin}/portal/quote/${acceptToken}`);
        const doc = publicPage.getByTestId('public-quote');
        await doc.waitFor({ timeout: 20_000 });
        // The customer-facing document renders the quote's stamped currency.
        await expect(doc).toContainText('€400.00');
        await expect(doc).not.toContainText('$');
        await expect(publicPage.getByTestId('public-quote-accept')).toBeVisible();

        // Hydration guard (#3906) — see the same note in
        // quote-contract-proposal.spec.ts: the portal dev server used to emit
        // this `client:load` island's module URL without the `/portal` prefix,
        // so Caddy dropped it into the web catch-all and it never hydrated even
        // though the SSR'd markup above looked correct. The portal dev server
        // now serves its whole module graph under the base path, so fail loud
        // here if that regresses.
        await waitForHydration(publicPage, 'public-quote-accept');

        // Accept through the same public endpoint the "Accept & sign" button
        // calls, rather than by clicking it, so this stays deterministic
        // regardless of the signer-name input's exact UI validation.
        const acceptResponse = await publicPage.request.post(
          `${origin}/api/v1/quotes/public/${acceptToken}/accept`,
          { data: { signerName: 'Jordan Rivers' } },
        );
        expect(acceptResponse.ok(), await acceptResponse.text()).toBeTruthy();
        const acceptBody = (await acceptResponse.json()) as { data: { status: string } };
        expect(acceptBody.data.status).toBe('converted');
      } finally {
        await publicContext.close();
      }

      // Admin side: the quote converted…
      await quotes.open(quoteId);
      await expect(quotes.detailStatus()).toContainText('Converted', { timeout: 20_000 });

      // …and the invoice acceptance issued is EUR, both in the payload and on
      // the rendered page.
      const list = await apiJson<{ data: { id: string; currencyCode: string; total: string; createdAt: string }[] }>(
        page.request, token, 'get', `/api/v1/invoices?orgId=${orgId}&limit=50`);
      const acceptInvoice = list.data
        .filter((i) => i.total === '400.00')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      expect(acceptInvoice, 'invoice created by quote acceptance').toBeTruthy();
      expect(acceptInvoice.currencyCode).toBe('EUR');

      await invoices.open(acceptInvoice.id);
      await expect(invoices.detailSummary()).toContainText('€400.00');
      await expect(invoices.detailSummary()).not.toContainText('$');
    });
  });
});
