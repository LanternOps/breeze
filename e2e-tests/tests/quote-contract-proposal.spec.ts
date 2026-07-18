import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';

// Every page in this flow is a single `client:load` Astro island (ContractsTabs,
// QuotesPage, QuoteWorkspace, ContractWorkspace, PublicQuoteView) — Astro SSRs
// the initial React tree into static HTML, so a `data-testid` element can be
// visible and "actionable" per Playwright's checks well before React attaches
// its event handlers. A click that lands in that window is silently swallowed
// (a plain `<button>` has no native action), which is the same hydration race
// documented in tickets.spec.ts/pam.spec.ts for the login form — this is the
// same fix generalized to every fresh full-page navigation in this spec, keyed
// off whatever root testid the page renders first.
async function waitForHydration(target: Page, testId: string) {
  await target.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
    },
    testId,
    { timeout: 20_000 },
  );
}

// Full proposal-with-contract lifecycle (Task 19): a partner-wide contract
// template is authored + published, a quote is built around it (cover page,
// a formatted rich-text section, a recurring pricing line, and the contract
// block itself), sent, viewed + accepted on the public portal link, and the
// resulting executed document is verified on the auto-created billing
// contract's Documents section (Task 18).
//
// No existing fixtures cover quotes/contracts, so every entity (template,
// quote, org selection) is created inline against the real API. `authedPage`
// is used for every admin step (skips login entirely); the public-portal
// half of the flow gets its own unauthenticated browser context, since the
// public accept link must never carry the admin's session.
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('quote + contract proposal lifecycle', () => {
  test('template authoring, send, public accept, executed document', async ({ authedPage: page, browser }) => {
    // Six real UI surfaces (contracts, quote editor, quote send, public
    // portal, accept, contract detail) chained serially against a live stack.
    test.setTimeout(240_000);

    // ── 1. Admin: author + publish a partner-wide contract template ─────
    await page.goto('/contracts');
    await page.getByTestId('contracts-tabs').waitFor();
    await waitForHydration(page, 'contracts-tabs');
    await page.getByTestId('contracts-tab-templates').click();
    await page.getByTestId('contract-templates-tab').waitFor();

    await page.getByTestId('contract-templates-create-btn').click();
    await page.getByTestId('contract-template-create-dialog').waitFor();

    const templateName = `E2E MSA ${Date.now()}`;
    await page.getByTestId('contract-template-name').fill(templateName);

    // admin@breeze.local is a Partner Admin (scope=partner), so the
    // owner-scope radio group renders and defaults to partner-wide already —
    // click it explicitly anyway so the spec doesn't silently depend on that
    // default. Fall back to an org-scoped template if the radio isn't there
    // (keeps the spec resilient rather than hard-failing on a scope surprise).
    const partnerWideRadio = page.getByTestId('contract-template-owner-partner');
    if (await partnerWideRadio.count()) {
      await partnerWideRadio.check();
    } else {
      await page.getByTestId('contract-template-org').selectOption({ index: 1 });
    }
    // Capture the created template's id from the response — other partner-wide
    // templates may already exist in this stack's DB (prior runs of this spec,
    // other fixtures), so later steps select this exact one by id/value rather
    // than assuming it's the only option.
    const [createTemplateResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/contracts\/contract-templates$/.test(new URL(r.url()).pathname),
      ),
      page.getByTestId('contract-template-create-submit').click(),
    ]);
    const createdTemplate = (await createTemplateResponse.json()) as { data: { id: string } };
    const templateId = createdTemplate.data.id;
    expect(templateId).toBeTruthy();

    // Creating swaps straight into TemplateEditor for the new template.
    await page.getByTestId('contract-template-editor').waitFor({ timeout: 15_000 });

    // Author the body via the TipTap toolbar: a bold auto variable
    // ({{client.name}}) plus a bulleted manual variable ({{governing_state}})
    // so the public-facing render can assert both <strong> and <li>.
    const templateBody = page.getByTestId('template-body-editor');
    await templateBody.click();
    await page.keyboard.type('This Master Services Agreement is between the Provider and ');
    await page.getByTestId('rte-bold').click();
    await page.keyboard.type('{{client.name}}');
    await page.getByTestId('rte-bold').click();
    await page.keyboard.type('.');
    await page.keyboard.press('Enter');
    await page.getByTestId('rte-bullet-list').click();
    await page.keyboard.type('Governing state: {{governing_state}}');

    // Manual variable detection is a live regex scan of the typed body.
    await expect(page.getByTestId('template-manual-variables')).toContainText('governing_state');

    await page.getByTestId('template-save-draft-btn').click();
    await expect(page.getByTestId('template-version-row')).toHaveCount(1, { timeout: 15_000 });
    await page.getByTestId('template-version-publish').click();
    // The publish button only renders for a draft row — its disappearance is
    // the "now published" signal.
    await expect(page.getByTestId('template-version-publish')).toHaveCount(0, { timeout: 15_000 });

    // ── 2. Create the quote ──────────────────────────────────────────────
    await page.goto('/billing/quotes');
    await page.getByTestId('quotes-page').waitFor();
    await waitForHydration(page, 'quotes-page');
    await page.getByTestId('quotes-create-open').click();
    await page.getByTestId('quotes-create-dialog').waitFor();

    const orgSelect = page.getByTestId('quotes-create-org');
    const [orgId] = await orgSelect.selectOption({ index: 1 });
    // The org's display name is what {{client.name}} resolves to at send
    // time (quote.billToName freezes from org.name) — captured now so the
    // public-page assertion below can check the substituted value exactly.
    const orgName = ((await orgSelect.locator('option:checked').textContent()) ?? '').trim();
    expect(orgName.length).toBeGreaterThan(0);

    await page.getByTestId('quotes-create-title').fill(`E2E Proposal ${Date.now()}`);
    await page.getByTestId('quotes-create-submit').click();
    await page.waitForURL(/\/billing\/quotes\/[^/#]+$/, { timeout: 20_000 });
    const quoteId = new URL(page.url()).pathname.split('/').filter(Boolean).pop()!;
    await page.getByTestId('quote-editor').waitFor({ timeout: 15_000 });
    await waitForHydration(page, 'quote-editor');

    // Cover page on.
    await page.getByTestId('quote-cover-page').waitFor();
    await page.getByTestId('quote-cover-page-enabled').check();
    await expect(page.getByTestId('quote-cover-page-title')).toBeVisible();

    // rich_text section: bold + bullets via the same TipTap toolbar.
    await page.getByTestId('quote-add-block-type-rich_text').click();
    const richTextEditor = page.getByTestId('quote-block-rich-text-editor');
    await richTextEditor.click();
    await page.keyboard.type('Highlights:');
    await page.keyboard.press('Enter');
    await page.getByTestId('rte-bullet-list').click();
    await page.getByTestId('rte-bold').click();
    await page.keyboard.type('24/7 monitoring');
    await page.getByTestId('rte-bold').click();
    await page.keyboard.type(' and support');
    await page.getByTestId('quote-add-block-submit').click();
    // richText resets to '' only after a successful add.
    await expect(richTextEditor).toHaveText('', { timeout: 15_000 });

    // Pricing table with one MONTHLY line — recurring revenue is what makes
    // acceptQuote auto-create a billing Contract (Phase 4) and link the
    // executed contract_document to it, which step 5 below depends on.
    await page.getByTestId('quote-add-block-type-line_items').click();
    await page.getByTestId('quote-add-block-submit').click();
    const addLineForm = page.locator('[data-testid^="quote-block-add-line-"]');
    await addLineForm.waitFor({ timeout: 15_000 });
    const addLineTestId = await addLineForm.getAttribute('data-testid');
    const lineBlockId = addLineTestId!.replace('quote-block-add-line-', '');

    await page.getByTestId(`quote-line-mode-${lineBlockId}-manual`).click();
    const manualNameInput = page.getByTestId(`quote-manual-name-${lineBlockId}`);
    await manualNameInput.fill('Managed IT Services');
    await page.getByTestId(`quote-manual-price-${lineBlockId}`).fill('500.00');
    await page.getByTestId(`quote-manual-recurrence-${lineBlockId}`).selectOption('monthly');
    await page.getByTestId(`quote-manual-add-${lineBlockId}`).click();
    // The manual-line form resets its name field only after a successful add.
    await expect(manualNameInput).toHaveValue('', { timeout: 15_000 });

    // Contract block: pick the template, then prove the manual-variable gate
    // blocks the add before it's filled (the "send fails until filled"
    // inline error), then fill it and add for real.
    await page.getByTestId('quote-add-block-type-contract').click();
    const templateSelect = page.getByTestId('quote-block-contract-template');
    await templateSelect.waitFor();
    // Select by value (the template id captured above), not index/count:
    // other templates (from prior runs of this spec, or other partner-wide
    // fixtures) may already exist in this stack's DB, so the option list
    // isn't guaranteed to hold exactly one real entry.
    // `<option>` elements are always reported "hidden" by Playwright's
    // actionability model — wait for attachment, not visibility.
    await templateSelect.locator(`option[value="${templateId}"]`).waitFor({ state: 'attached', timeout: 20_000 });
    await templateSelect.selectOption(templateId);
    await page.getByTestId('quote-block-contract-version').waitFor({ timeout: 15_000 });
    await expect(page.getByTestId('quote-block-contract-auto-client.name')).toBeVisible();

    // Attempt to add without filling the manual variable — blocked inline.
    await page.getByTestId('quote-add-block-submit').click();
    await expect(page.getByTestId('quote-block-contract-var-error-governing_state')).toBeVisible();

    // Fill it and resubmit — succeeds this time.
    await page.getByTestId('quote-block-contract-var-governing_state').fill('Texas');
    await page.getByTestId('quote-add-block-submit').click();
    // resetContractForm() clears the template select back to its placeholder
    // only after a successful add.
    await expect(templateSelect).toHaveValue('', { timeout: 15_000 });

    // Send the proposal — capture the response to recover the public accept
    // token (the admin UI never surfaces the link itself).
    await page.getByTestId('quote-send').click();
    await page.getByTestId('quote-send-confirm').waitFor();
    const [sendResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/quotes\/[^/]+\/send$/.test(new URL(r.url()).pathname),
      ),
      page.getByTestId('quote-send-confirm').click(),
    ]);
    expect(sendResponse.ok()).toBeTruthy();
    const sendBody = (await sendResponse.json()) as {
      data: { quote: { quoteNumber: string | null }; acceptUrl: string };
    };
    const quoteNumber = sendBody.data.quote.quoteNumber;
    expect(quoteNumber).toBeTruthy();
    // acceptUrl's host reflects the deployment's PUBLIC_APP_URL/PUBLIC_PORTAL_URL
    // config (not this stack's ephemeral wt-stack port), so only the path's
    // token segment is reusable here — rebuild the URL against this page's own
    // origin below instead of navigating to acceptUrl directly. Split on '/'
    // rather than parsing as a URL: a config gap can leave acceptUrl relative
    // (`portalBase()` falling through to malformed candidates), and `new URL()`
    // throws on a bare path with no base.
    const token = decodeURIComponent(sendBody.data.acceptUrl.split('/').filter(Boolean).pop() ?? '');
    expect(token.length).toBeGreaterThan(10);

    // ── 3 & 4. Public link: view the rendered contract, then accept ─────
    const origin = new URL(page.url()).origin;
    const publicContext = await browser.newContext();
    try {
      const publicPage = await publicContext.newPage();
      await publicPage.goto(`${origin}/portal/quote/${token}`);
      await publicPage.waitForLoadState('networkidle');

      const contractBlock = publicPage.getByTestId('contract-block');
      await contractBlock.waitFor({ timeout: 20_000 });
      // {{client.name}} substituted with the org's name, still wrapped in <strong>.
      await expect(contractBlock.locator('strong')).toHaveText(orgName, { timeout: 15_000 });
      // {{governing_state}} substituted, still wrapped in <li>.
      await expect(contractBlock.locator('li')).toContainText('Texas');

      // The accept panel itself is confirmed present (SSR'd — this doesn't
      // depend on hydration).
      await expect(publicPage.getByTestId('public-quote-sign')).toBeVisible();
      await expect(publicPage.getByTestId('public-quote-signer')).toBeVisible();
      await expect(publicPage.getByTestId('public-quote-accept')).toBeVisible();

      // Accept via the same public endpoint the "Accept & sign" button calls
      // (POST /quotes/public/:token/accept, { signerName }), NOT by clicking
      // it: PublicQuoteView is a `client:load` island served under the
      // portal's `/portal` base path, and Astro dev-mode has a documented
      // base-path-in-dev gotcha where the island's hydration module 404s
      // (browser requests `/src/components/portal/PublicQuoteView.tsx`,
      // missing the `/portal` prefix — confirmed via console/network capture:
      // "[astro-island] Error hydrating ... Failed to fetch dynamically
      // imported module"). See project memory
      // portal_dev_island_hydration_404.md: dev-only, already known, and
      // CI's smoke-test job builds the portal from a production bundle
      // (serves islands under /portal/_astro/*) where hydration is expected
      // to work. Every button on this page is therefore inert in THIS stack
      // regardless of selector/timing — calling the endpoint directly
      // exercises the real accept path (quoteAcceptService: converts the
      // quote, auto-creates the recurring billing Contract, snapshots the
      // executed contract_documents row) without depending on hydration.
      const acceptResponse = await publicPage.request.post(
        `${origin}/api/v1/quotes/public/${token}/accept`,
        { data: { signerName: 'Jordan Rivers' } },
      );
      expect(acceptResponse.ok()).toBeTruthy();
      const acceptBody = (await acceptResponse.json()) as { data: { status: string } };
      // acceptQuote's terminal status once the invoice issues.
      expect(acceptBody.data.status).toBe('converted');
    } finally {
      await publicContext.close();
    }

    // Confirm the accept landed from the admin side too — a genuine UI
    // assertion on the (fully hydrated) web app, independent of the portal's
    // dev-mode hydration gap above.
    await page.goto(`/billing/quotes/${quoteId}`);
    await page.getByTestId('quote-workspace').waitFor({ timeout: 15_000 });
    await waitForHydration(page, 'quote-workspace');
    await expect(page.getByTestId('quote-detail-status')).toContainText('Converted', { timeout: 15_000 });

    // ── 5. Admin: billing contract detail → Documents section ───────────
    await page.goto('/contracts');
    await page.getByTestId('contracts-tabs').waitFor();
    await waitForHydration(page, 'contracts-tabs');
    // Contracts tab is the default — filter to the org used above so the
    // auto-created "<quoteNumber> — Monthly" contract from acceptQuote's
    // Phase 4 is easy to isolate even if other contracts exist for the org.
    const contractsOrgFilter = page.getByTestId('contracts-filter-org');
    await contractsOrgFilter.waitFor();
    await contractsOrgFilter.selectOption(orgId);

    const contractLinks = page.locator('[data-testid^="contract-row-link-"]');
    await expect(contractLinks.first()).toBeVisible({ timeout: 20_000 });
    const linkCount = await contractLinks.count();
    let contractHref: string | null = null;
    for (let i = 0; i < linkCount; i++) {
      const link = contractLinks.nth(i);
      const text = (await link.textContent()) ?? '';
      if (text.includes(quoteNumber!)) {
        contractHref = await link.getAttribute('href');
        break;
      }
    }
    expect(contractHref).not.toBeNull();
    await page.goto(contractHref!);

    // acceptQuote's Phase 4 auto-created contract starts in 'draft' status —
    // ContractWorkspace always shows the editor (not ContractDetail, so no
    // Documents section) for a draft, regardless of write permission.
    // Activate it to switch to the read view.
    await page.getByTestId('contract-workspace').waitFor({ timeout: 15_000 });
    await waitForHydration(page, 'contract-workspace');
    await page.getByTestId('activate-contract-btn').click();

    await page.getByTestId('contract-detail').waitFor({ timeout: 15_000 });
    const docsSection = page.getByTestId('contract-documents-section');
    await docsSection.waitFor();
    await expect(page.getByTestId('contract-document-row')).toHaveCount(1, { timeout: 20_000 });
    // The row names the template + pinned version (v1, the only published one).
    await expect(docsSection).toContainText(templateName);

    const downloadBtn = page.locator('[data-testid^="contract-document-download-"]');
    await downloadBtn.waitFor();
    const [pdfResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && /\/contracts\/contract-documents\/[^/]+\/pdf$/.test(new URL(r.url()).pathname),
      ),
      downloadBtn.click(),
    ]);
    expect(pdfResponse.status()).toBe(200);
    expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
  });
});
