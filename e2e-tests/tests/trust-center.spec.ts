import { test, expect } from '../fixtures';
import { waitForHydration } from '../pages/hydration';
import { clearRefreshState } from '../test-helpers';

/**
 * Trust Center W1 (#8768): publish -> public page renders -> unpublish -> 404.
 *
 * The seeded admin satisfies the platform MFA requirement on the wt-stack
 * (its JWT carries `mfa: true`, same as ai-script-proposals.spec.ts), so the
 * `requireMfa()` publish/unpublish routes need no extra step-up here.
 * The seed carries no posture telemetry, so the public page is asserted by
 * structure ("Not assessed" pills), not green results.
 */
// The seeded org id is random per stack, so it is resolved from the org list.

test.beforeEach(clearRefreshState);
test.describe.configure({ timeout: 180_000 });

test('publish -> public page renders -> unpublish -> 404', async ({ authedPage: page, browser, baseURL }) => {
  await page.goto('/organizations');
  const orgLink = page.locator('a[href^="/organizations/"]').filter({ hasNot: page.locator('[href="/organizations/"]') }).first();
  await expect(orgLink).toBeVisible({ timeout: 60_000 });
  const orgHref = (await orgLink.getAttribute('href'))!.split('#')[0];
  await page.goto(`${orgHref}#trust`);

  // Leave the org unpublished first if an earlier failed run left it published.
  const unpublish = page.getByTestId('trust-unpublish');
  const publish = page.getByTestId('trust-publish');
  await expect(publish).toBeVisible({ timeout: 60_000 });
  if (await unpublish.isVisible()) {
    await unpublish.click();
    await page.getByTestId('trust-unpublish-confirm').click();
    await expect(unpublish).toBeHidden();
  }

  await publish.click();
  // A previously recorded attestation is shown read-only until changed.
  const change = page.getByTestId('trust-publish-change');
  if (await change.isVisible()) await change.click();
  await page.getByTestId('trust-publish-authorized-checkbox').check();
  await page.getByTestId('trust-publish-authorized-by').fill('E2E Approver, CTO');
  await page.getByTestId('trust-publish-confirm').click();
  await expect(page.getByTestId('trust-public-url')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('trust-unpublish')).toBeVisible();

  // The stack's configured public base may differ from the browser origin; the
  // path is what identifies the page.
  const shown = (await page.getByTestId('trust-public-url').textContent())!.trim();
  const publicUrl = new URL(new URL(shown, baseURL).pathname, baseURL).toString();

  const anon = await browser.newContext();
  try {
    const pub = await anon.newPage();
    const res = await pub.goto(publicUrl);
    expect(res?.status()).toBe(200);
    await expect(pub).toHaveTitle(/Security posture/);
    await expect(pub.locator('meta[property="og:title"]')).toHaveCount(1);
    await waitForHydration(pub, 'trust-page');
    await expect(pub.getByText(/Breeze-verifiable controls/).first()).toBeVisible();
    await expect(pub.getByText('Not assessed').first()).toBeVisible();
    // The disclaimer lives in the collapsed methodology disclosure.
    await pub.getByText('How this page is verified').click();
    await expect(pub.getByText(/not a certification/i).first()).toBeVisible();
  } finally {
    await anon.close();
  }

  await page.getByTestId('trust-unpublish').click();
  await page.getByTestId('trust-unpublish-confirm').click();
  await expect(page.getByTestId('trust-unpublish')).toBeHidden({ timeout: 30_000 });

  const anon2 = await browser.newContext();
  try {
    const gone = await anon2.newPage();
    const res = await gone.goto(publicUrl);
    expect(res?.status()).toBe(404);
  } finally {
    await anon2.close();
  }
});
