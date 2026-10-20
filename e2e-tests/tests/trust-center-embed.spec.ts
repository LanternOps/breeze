import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { psql } from '../pages/TrustAccessPage';

/**
 * Trust Center W03a (#8771): the framable embed card and its live allowlist.
 *
 * publish → allow an origin in the editor → /portal/trust/embed/<p>/<o> answers 200 with the card, no-store →
 * clear the list → the next request is 404. The full page stays DENY throughout.
 *
 * Header note: the wt-stack portal runs `astro dev`, which drops CSP unless CSP_STRICT_DEV=1 (lib/csp.ts). With
 * no CSP emitted the middleware deliberately KEEPS X-Frame-Options: DENY (quorum A4), so this spec asserts the
 * carve-out (frame-ancestors <origin>, no XFO) whenever a CSP header is present, and the fail-safe otherwise.
 * The header logic itself is unit-tested in apps/portal/src/middleware.test.ts and lib/csp.test.ts.
 *
 * The seeded admin's JWT carries `mfa: true`, so the MFA-gated PUT /trust-page/embed needs no step-up here.
 */
const ORIGIN = 'https://www.example.com';

test.beforeEach(clearRefreshState);
test.describe.configure({ timeout: 180_000 });

test('embed allowlist → framable card; cleared list → 404; full page stays DENY', async ({ authedPage: page, baseURL }) => {
  // Its own organization (under the seeded org's partner): the trust specs run in parallel workers and the W1 spec
  // publishes/unpublishes the seeded org's page, so sharing it would race (trust-center-gated.spec.ts precedent).
  const stamp = `${Date.now()}`;
  const orgId = psql(`INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    SELECT partner_id, 'E2E Embed ${stamp}', 'e2e-embed-${stamp}', 'active', 'USD', now(), now()
    FROM organizations WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1 RETURNING id`);
  expect(orgId).toMatch(/^[0-9a-f-]{36}$/);

  try {
    await page.addInitScript(() => {
      try { localStorage.setItem('breeze-onboarding-complete', 'true'); } catch { /* private mode */ }
    });
    await page.goto(`/organizations/${orgId}#trust`);

    const publish = page.getByTestId('trust-publish');
    await expect(publish).toBeVisible({ timeout: 60_000 });
    await publish.click();
    await page.getByTestId('trust-publish-authorized-checkbox').check();
    await page.getByTestId('trust-publish-authorized-by').fill('E2E Approver, CTO');
    await page.getByTestId('trust-publish-confirm').click();
    await expect(page.getByTestId('trust-unpublish')).toBeVisible({ timeout: 30_000 });
    const shown = (await page.getByTestId('trust-public-url').textContent())!.trim();
    const fullPageUrl = new URL(new URL(shown, baseURL).pathname, baseURL).toString();

    await expect(page.getByTestId('trust-embed-section')).toBeVisible();
    await expect(page.getByTestId('trust-embed-empty')).toBeVisible();
    const save = page.getByTestId('trust-embed-save');

    // Allow the origin (typed un-normalized; the editor previews the normalized form). The snippet appears once saved.
    await page.getByTestId('trust-embed-origin-input').fill('https://WWW.example.com/');
    await expect(page.getByTestId('trust-embed-origin-preview')).toHaveText(ORIGIN);
    await page.getByTestId('trust-embed-add').click();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 30_000 });
    const snippet = await page.getByTestId('trust-embed-snippet').inputValue();
    const src = /src="([^"]+)"/.exec(snippet)![1]!;
    const embedUrl = new URL(new URL(src).pathname, baseURL).toString();
    expect(new URL(embedUrl).pathname).toMatch(new RegExp(`/portal/trust/embed/[a-z0-9-]+/e2e-embed-${stamp}$`));

    const res = await page.request.get(embedUrl);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('data-testid="trust-embed-card"');
    const h = res.headers();
    expect(h['cache-control']).toBe('no-store');
    if (h['content-security-policy']) {
      expect(h['content-security-policy']).toContain(`frame-ancestors ${ORIGIN}`);
      expect(h['x-frame-options']).toBeUndefined();
    } else {
      expect(h['x-frame-options']).toBe('DENY');
    }

    // The full page is never framable.
    const full = await page.request.get(fullPageUrl);
    expect(full.status()).toBe(200);
    expect(full.headers()['x-frame-options']).toBe('DENY');

    // Clear the list: the very next embed request is a 404 (nothing cached in between).
    await page.getByTestId('trust-embed-remove-0').click();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 30_000 });
    await expect(page.getByTestId('trust-embed-empty')).toBeVisible();
    const gone = await page.request.get(embedUrl);
    expect(gone.status()).toBe(404);
    expect(gone.headers()['cache-control']).toBe('no-store');
    expect(gone.headers()['x-frame-options']).toBe('DENY');
  } finally {
    // Unpublish through the UI (it also leaves the serving set), then retire this run's organization.
    if (await page.getByTestId('trust-unpublish').isVisible().catch(() => false)) {
      await page.getByTestId('trust-unpublish').click();
      await page.getByTestId('trust-unpublish-confirm').click();
      await expect(page.getByTestId('trust-unpublish')).toBeHidden({ timeout: 30_000 });
    }
    psql(`UPDATE organizations SET deleted_at = now() WHERE id = '${orgId}'`);
  }
});
