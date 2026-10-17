import { test, expect } from '../fixtures';
import { waitForHydration } from '../pages/hydration';
import { clearRefreshState } from '../test-helpers';

/**
 * Trust Center W02e (#8770 of #8768): choose frameworks -> publish -> the public page shows the framework view.
 *
 * The stack runs with BREEZE_TRUST_CIS_FRAMEWORK_VIEW unset, so CIS v8 must be unselectable. The seed carries no
 * posture telemetry, so the assertions are on structure and on the framework totals ("of 106", "of 8"), not on
 * how many safeguards are evidenced.
 */
test.beforeEach(clearRefreshState);
test.describe.configure({ timeout: 180_000 });

test('framework picker -> publish -> public framework view', async ({ authedPage: page, browser, baseURL }) => {
  await page.goto('/organizations');
  const orgLink = page.locator('a[href^="/organizations/"]').filter({ hasNot: page.locator('[href="/organizations/"]') }).first();
  await expect(orgLink).toBeVisible({ timeout: 60_000 });
  const orgHref = (await orgLink.getAttribute('href'))!.split('#')[0];
  await page.goto(`${orgHref}#trust`);

  const unpublish = page.getByTestId('trust-unpublish');
  const publish = page.getByTestId('trust-publish');
  await expect(publish).toBeVisible({ timeout: 60_000 });
  if (await unpublish.isVisible()) {
    await unpublish.click();
    await page.getByTestId('trust-unpublish-confirm').click();
    await expect(unpublish).toBeHidden();
  }

  // CIS is gated off on this stack: visible, but not selectable.
  await expect(page.getByTestId('trust-frameworks-option-cis_v8')).toBeDisabled();
  await expect(page.getByTestId('trust-frameworks-cis-hint')).toBeVisible();

  // NIST CSF 2.0 + Essential Eight.
  const nist = page.getByTestId('trust-frameworks-option-nist_csf_2');
  const e8 = page.getByTestId('trust-frameworks-option-essential_eight');
  if (!(await nist.isChecked())) await nist.check();
  if (!(await e8.isChecked())) await e8.check();
  await page.getByTestId('trust-frameworks-save').click();
  await expect(page.getByTestId('trust-frameworks-source')).toBeVisible();

  await publish.click();
  const change = page.getByTestId('trust-publish-change');
  if (await change.isVisible()) await change.click();
  await page.getByTestId('trust-publish-authorized-checkbox').check();
  await page.getByTestId('trust-publish-authorized-by').fill('E2E Approver, CTO');
  await page.getByTestId('trust-publish-confirm').click();
  await expect(page.getByTestId('trust-public-url')).toBeVisible({ timeout: 30_000 });

  const shown = (await page.getByTestId('trust-public-url').textContent())!.trim();
  const publicUrl = new URL(new URL(shown, baseURL).pathname, baseURL).toString();

  const anon = await browser.newContext();
  try {
    const pub = await anon.newPage();
    const res = await pub.goto(publicUrl);
    expect(res?.status()).toBe(200);
    await waitForHydration(pub, 'trust-page');
    await expect(pub.getByTestId('trust-framework-view')).toBeVisible();
    await expect(pub.getByTestId('trust-framework-tab-nist_csf_2')).toBeVisible();
    await expect(pub.getByTestId('trust-framework-tab-essential_eight')).toBeVisible();
    await expect(pub.getByTestId('trust-framework-tab-cis_v8')).toHaveCount(0);

    await pub.getByTestId('trust-framework-tab-nist_csf_2').click();
    await expect(pub.getByTestId('trust-framework-summary')).toContainText('of 106');
    await pub.getByTestId('trust-framework-tab-essential_eight').click();
    await expect(pub.getByTestId('trust-framework-summary')).toContainText('of 8');
    await expect(pub.getByTestId('trust-framework-view')).not.toContainText(/compliant|certified/i);
  } finally {
    await anon.close();
  }

  // Leave the org unpublished, as the other trust specs do.
  await page.getByTestId('trust-unpublish').click();
  await page.getByTestId('trust-unpublish-confirm').click();
  await expect(page.getByTestId('trust-unpublish')).toBeHidden({ timeout: 30_000 });
});
