import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { persistStorageState } from '../auth-state';
import { PartnerSendingDomainsPage } from '../pages/PartnerSendingDomainsPage';

/**
 * Partner sending domains W05 — the browser slice of spec §14's E2E bullet.
 *
 * Runs against the `fake` email-domain provider (EMAIL_DOMAINS_PROVIDER=fake in
 * the dev stack), whose behaviour is keyed on the DOMAIN NAME, so no seeding is
 * needed: `*.verify.test` verifies on the first check and `*.fail.test` fails.
 * Each test mints a unique label so re-running against a live stack cannot trip
 * the `UNIQUE (domain)` constraint.
 *
 * What only a browser proves here: that the tab is reachable from the URL hash
 * at all, that the DNS records the API returns actually render, and that the
 * add → verify → configure → test → remove loop survives the polling that
 * refreshes the page underneath each step.
 *
 * ONE browser context for the whole file, not the per-test `authedPage`
 * fixture: the first test's several reloads rotate the shared storageState's
 * refresh token forward, so a second test's fresh context presenting that
 * now-stale cookie is treated as replay by the API's family reuse-detection
 * and lands on "Your session expired" (same shape as
 * ai-script-proposals.spec.ts and multi-currency.spec.ts). Within one context
 * the cookie jar follows every rotation.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

function uniqueDomain(suffix: string): string {
  return `w04-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.${suffix}`;
}

test.describe('Partner sending domains', () => {
  let ctx: BrowserContext;
  let authedPage: Page;

  test.beforeAll(async ({ browser, workerStorageState }) => {
    ctx = await browser.newContext({ storageState: workerStorageState });
    authedPage = await ctx.newPage();
  });
  test.afterAll(async ({ workerStorageState }) => {
    if (ctx) await persistStorageState(ctx, workerStorageState);
    await ctx?.close();
  });

  test('add, verify, configure a sender address, test send and remove', async () => {
    const page = new PartnerSendingDomainsPage(authedPage);
    const domain = uniqueDomain('verify.test');
    let domainId = '';

    await test.step('1. The tab is offered and opens on its own hash', async () => {
      await page.goto();
      await expect(page.navTab()).toBeVisible();
      await expect(page.recommendation()).toBeVisible();
    });

    await test.step('2. Adding the domain creates a row', async () => {
      domainId = await page.addDomain(domain);
      await expect(page.domainRow(domainId)).toBeVisible();
    });

    await test.step('3. The DNS records appear', async () => {
      await expect(page.records()).toBeVisible({ timeout: 30_000 });
      await page.recordCopy(0).click();
    });

    await test.step('4. Check now drives it to verified', async () => {
      await expect(page.checkNow(domainId)).toBeVisible({ timeout: 30_000 });
      await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/${domainId}/check`),
        ),
        page.checkNow(domainId).click(),
      ]);
      await expect(page.domainStatus(domainId)).toHaveText('Verified', { timeout: 30_000 });
    });

    await test.step('5. The support stream takes an address on that domain', async () => {
      await page.identityLocalPart('support').fill('helpdesk');
      await page.identityDomain('support').selectOption(domainId);
      const [putResponse] = await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/identities/support'),
        ),
        page.identitySave('support').click(),
      ]);
      expect(putResponse.ok()).toBe(true);

      await authedPage.reload();
      await page.waitUntilReady();
      await expect(page.identityFrom('support')).toContainText(`helpdesk@${domain}`);
      await expect(page.identityClear('support')).toBeVisible();
    });

    await test.step('6. A test send is accepted and recorded on the row', async () => {
      const [testResponse] = await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/${domainId}/test`),
        ),
        page.testSubmit(domainId).click(),
      ]);
      expect(testResponse.status()).toBe(202);

      // The worker writes last_test_* asynchronously; a reload is deterministic
      // where waiting on the 15 s poll is not.
      await expect(async () => {
        await authedPage.reload();
        await page.waitUntilReady();
        await expect(page.testResult(domainId)).toBeVisible();
      }).toPass({ timeout: 60_000 });
    });

    await test.step('7. Removing it takes the row away', async () => {
      // The tab confirms removal with its own modal (`ConfirmDialog`,
      // confirmTestId="sending-domains-remove-confirm"), not a native
      // `confirm()`. A `once('dialog')` handler therefore never fires, the
      // modal stays open, and no DELETE is ever issued — which is exactly how
      // this step used to time out on every CI run.
      await page.remove(domainId).click();
      await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith(`/${domainId}`),
        ),
        page.removeConfirm().click(),
      ]);
      await expect(async () => {
        await authedPage.reload();
        await page.waitUntilReady();
        await expect(page.domainRow(domainId)).toHaveCount(0);
      }).toPass({ timeout: 60_000 });
    });
  });

  test('a domain the provider rejects explains itself and offers Try again and Remove', async () => {
    const page = new PartnerSendingDomainsPage(authedPage);
    await page.goto();

    const domainId = await page.addDomain(uniqueDomain('fail.test'));

    await expect(page.failedReason(domainId)).toBeVisible({ timeout: 60_000 });
    await expect(page.retry(domainId)).toBeVisible();
    await expect(page.remove(domainId)).toBeVisible();

    authedPage.once('dialog', (dialog) => void dialog.accept());
    await Promise.all([
      authedPage.waitForResponse(
        (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith(`/${domainId}`),
      ),
      page.remove(domainId).click(),
    ]);
  });

  test('an ineligible partner sees a locked card and no add form', async () => {
    // Trust mode is `off` on a self-hosted stack, so ineligibility cannot be
    // produced by seeding — the capability is rewritten on the wire instead.
    // Everything downstream of `eligible: false` is real UI.
    await authedPage.route('**/partner/sending-domains*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      body.capability = { ...body.capability, eligible: false, reason: 'probation_default_deny' };
      body.domains = [];
      body.identities = [];
      await route.fulfill({ response, json: body });
    });

    const page = new PartnerSendingDomainsPage(authedPage);
    await page.goto();

    await expect(page.lockedCard()).toBeVisible();
    await expect(page.lockedReason()).toContainText('still being verified');
    await expect(page.addSubmit()).toHaveCount(0);
  });
});
