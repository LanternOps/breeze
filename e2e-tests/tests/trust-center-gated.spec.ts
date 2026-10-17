import { test, expect } from '../fixtures';
import { waitForHydration } from '../pages/hydration';
import { clearRefreshState } from '../test-helpers';
import { TrustAccessPage, knownToken, plantToken, psql } from '../pages/TrustAccessPage';

/**
 * Trust Center W2 gated documents (#8770 W02d):
 *   link a document as "Available on request" → publish → anonymous request → verify (POST on click)
 *   → admin approves → download (POST) → admin revokes → the same link is dead.
 *
 * Tokens are emailed, never shown, so the test plants the hash of a token it knows on the request's live
 * token row (plantToken) — the same value the mailed fragment link would carry. The seeded admin satisfies
 * requireMfa() on the wt-stack (see trust-center.spec.ts), so approve needs no step-up here.
 */
test.beforeEach(clearRefreshState);
test.describe.configure({ timeout: 240_000 });

test('gated document: request → verify → approve → download → revoke', async ({ authedPage: page, browser, baseURL }) => {
  const stamp = `${Date.now()}`;
  const email = `gated-${stamp}@example.test`;
  const verifyRaw = knownToken(`verify-${stamp}`);
  const downloadRaw = knownToken(`download-${stamp}`);

  // Its own organization (under the seeded org's partner): the trust specs run in parallel workers, and the W1
  // spec publishes/unpublishes the seeded org's page, so sharing it would race.
  const orgId = psql(`INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    SELECT partner_id, 'E2E Gated ${stamp}', 'e2e-gated-${stamp}', 'active', 'USD', now(), now()
    FROM organizations WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1 RETURNING id`);
  expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
  const orgHref = `/organizations/${orgId}`;

  // A db-backed document in the org library (superuser insert; no upload UI round trip needed for this flow).
  const docId = psql(`INSERT INTO org_documents (org_id, title, category, storage_backend, data, content_type, byte_size, sha256, original_filename)
    VALUES ('${orgId}', 'E2E Gated SOC 2 ${stamp}', 'report', 'db', '\\x25504446'::bytea, 'application/pdf', 4, '${'a'.repeat(64)}', 'soc2-${stamp}.pdf') RETURNING id`);
  expect(docId).toMatch(/^[0-9a-f-]{36}$/);

  try {
    // The onboarding tour opens ~1.5 s after load in a fresh context and its card intercepts clicks in the
    // disclosure dialog; it keys off one localStorage flag (ScriptProposalsPage precedent).
    await page.addInitScript(() => {
      try { localStorage.setItem('breeze-onboarding-complete', 'true'); } catch { /* private mode */ }
    });
    await page.goto(`${orgHref}#trust`);
    const publish = page.getByTestId('trust-publish');
    await expect(publish).toBeVisible({ timeout: 60_000 });

    const editor = new TrustAccessPage(page);
    await expect(page.getByTestId(`trust-doc-add-${docId}`)).toBeVisible({ timeout: 30_000 });
    await editor.linkGated(docId);
    // The access section reports the unpublished state while a gated document is linked.
    await expect(page.getByTestId('trust-access-unpublished')).toBeVisible({ timeout: 30_000 });

    await publish.click();
    const change = page.getByTestId('trust-publish-change');
    if (await change.isVisible()) await change.click();
    await page.getByTestId('trust-publish-authorized-checkbox').check();
    await page.getByTestId('trust-publish-authorized-by').fill('E2E Approver, CTO');
    await page.getByTestId('trust-publish-confirm').click();
    await expect(page.getByTestId('trust-public-url')).toBeVisible({ timeout: 30_000 });
    const shown = (await page.getByTestId('trust-public-url').textContent())!.trim();
    const publicUrl = new URL(new URL(shown, baseURL).pathname, baseURL).toString();
    const portalBase = new URL(shown, baseURL).pathname.split('/trust/')[0];   // e.g. "/portal"
    const accessUrl = (kind: 'verify' | 'download', raw: string) => `${new URL(`${portalBase}/trust/access/${kind}`, baseURL)}#${raw}`;

    const anon = await browser.newContext({ acceptDownloads: true });
    try {
      const pub = await anon.newPage();
      // Review Focus 3: a token never appears in a request path or query string, only in the fragment.
      const leaked: string[] = [];
      pub.on('request', (r) => { if (r.url().includes(verifyRaw) || r.url().includes(downloadRaw)) leaked.push(r.url()); });

      expect((await pub.goto(publicUrl))?.status()).toBe(200);
      await waitForHydration(pub, 'trust-page');
      await expect(pub.getByTestId(`trust-document-on-request-${docId}`)).toBeVisible();
      await new TrustAccessPage(pub).requestAccess({ name: 'Ina Surer', email, company: 'Example Insurance', purpose: 'Cyber policy underwriting review.' });

      const findRequest = () => psql(`SELECT id FROM trust_page_access_requests WHERE requester_email = '${email}'`);
      await expect.poll(findRequest, { timeout: 30_000 }).toMatch(/^[0-9a-f-]{36}$/);
      const requestId = findRequest();
      plantToken(requestId, 'verify_email', verifyRaw);

      // Verify: the page clears the fragment and POSTs only on click.
      await pub.goto(accessUrl('verify', verifyRaw));
      await expect(pub.getByTestId('trust-access-confirm')).toBeVisible({ timeout: 30_000 });
      expect(pub.url()).not.toContain(verifyRaw);
      expect(psql(`SELECT status FROM trust_page_access_requests WHERE id = '${requestId}'`)).toBe('pending_verification');
      await pub.getByTestId('trust-access-confirm').click();
      await expect(pub.getByTestId('trust-access-verified')).toBeVisible({ timeout: 30_000 });
      expect(psql(`SELECT status FROM trust_page_access_requests WHERE id = '${requestId}'`)).toBe('pending_approval');

      // The admin approves in the editor.
      await page.reload();
      await expect(page.getByTestId(`trust-access-approve-${requestId}`)).toBeVisible({ timeout: 60_000 });
      await page.getByTestId(`trust-access-approve-${requestId}`).click();
      await expect.poll(() => psql(`SELECT status FROM trust_page_access_requests WHERE id = '${requestId}'`), { timeout: 30_000 }).toBe('approved');
      plantToken(requestId, 'download', downloadRaw);

      // Download: list the grant, then a POST streams the attachment.
      await pub.goto(accessUrl('download', downloadRaw));
      await expect(pub.getByTestId(`trust-access-doc-${docId}`)).toBeVisible({ timeout: 30_000 });
      expect(pub.url()).not.toContain(downloadRaw);
      await expect(pub.getByTestId('trust-access-expires')).toBeVisible();
      const [download] = await Promise.all([
        pub.waitForEvent('download'),
        pub.getByTestId(`trust-access-download-${docId}`).click(),
      ]);
      expect(download.suggestedFilename()).toBe(`soc2-${stamp}.pdf`);
      await expect.poll(() => psql(`SELECT download_count FROM trust_page_access_requests WHERE id = '${requestId}'`)).toBe('1');

      // Revoke: the same link stops working.
      await page.getByTestId(`trust-access-revoke-${requestId}`).click();
      await page.getByTestId('trust-access-revoke-confirm').click();
      await expect.poll(() => psql(`SELECT status FROM trust_page_access_requests WHERE id = '${requestId}'`), { timeout: 30_000 }).toBe('revoked');
      const again = await anon.newPage();
      await again.goto(accessUrl('download', downloadRaw));
      await expect(again.getByTestId('trust-access-invalid')).toBeVisible({ timeout: 30_000 });

      expect(leaked).toEqual([]);
    } finally {
      await anon.close();
    }
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
