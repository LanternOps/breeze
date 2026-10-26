import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { waitForHydration } from '../pages/hydration';

// Standalone agreement signing (#9075, spec 2026-10-15 §8 E2E): an agreement
// sent for signature on its own — no $0 quote — signed on the public link and
// filed straight onto the contract; an agreement signed elsewhere recorded with
// an uploaded scan; and a voided request whose link stops working.
//
// Fixture data is created through the real API with the admin's own bearer
// token (captured from the app's requests), so the spec owns every entity it
// touches and never depends on what else the stack's DB holds. Every UI
// locator is a data-testid. Synthetic names/emails only (public repo).

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

// 1×1 PNG — an "externally signed scan".
const PNG_SCAN = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface Setup {
  origin: string;
  bearer: string;
  orgId: string;
  orgName: string;
  templateId: string;
  templateName: string;
  contractId: string;
}

let setup: Setup | null = null;

/** The admin's bearer token, read off the app's own authenticated requests. */
async function captureBearer(page: Page): Promise<string> {
  let bearer = '';
  const onRequest = (req: { url(): string; headers(): Record<string, string> }) => {
    const header = req.headers()['authorization'];
    if (!bearer && req.url().includes('/api/v1/') && header?.startsWith('Bearer ')) bearer = header.slice('Bearer '.length);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/agreements/signed');
    await page.getByTestId('signed-agreements-tab').waitFor({ timeout: 30_000 });
    await expect.poll(() => bearer, { timeout: 30_000, message: 'an authenticated /api/v1 request from the app' }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return bearer;
}

async function api<T>(page: Page, s: Pick<Setup, 'origin' | 'bearer'>, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${s.origin}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.bearer}`, 'Content-Type': 'application/json' },
    data: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await res.text();
  expect(res.ok(), `${method} ${path} -> ${res.status()} ${text.slice(0, 300)}`).toBeTruthy();
  return (JSON.parse(text) as { data: T }).data;
}

/** A partner-wide published template, a customer org and an ACTIVE contract
 *  for it (an active contract renders its Signed agreements section). */
async function ensureSetup(page: Page): Promise<Setup> {
  if (setup) return setup;
  const bearer = await captureBearer(page);
  const origin = new URL(page.url()).origin;
  const base = { origin, bearer };

  const orgsRes = await page.request.fetch(`${origin}/api/v1/orgs/organizations?page=1&limit=50`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  expect(orgsRes.ok()).toBeTruthy();
  const orgsBody = (await orgsRes.json()) as { data?: Array<{ id: string; name: string; type?: string }>; organizations?: Array<{ id: string; name: string; type?: string }> };
  const org = (orgsBody.data ?? orgsBody.organizations ?? [])
    .find((o) => !o.type || !['unassigned_pool', 'quick_support'].includes(o.type));
  expect(org, 'a customer organization in the stack').toBeTruthy();

  const templateName = `E2E BAA ${Date.now()}`;
  const template = await api<{ id: string }>(page, base, 'POST', '/contracts/contract-templates', { name: templateName, ownerScope: 'partner' });
  const version = await api<{ id: string }>(page, base, 'POST', `/contracts/contract-templates/${template.id}/versions`, {
    bodyHtml: '<p>This Business Associate Agreement is between the Provider and <strong>{{client.name}}</strong>.</p>',
  });
  await api(page, base, 'POST', `/contracts/contract-templates/${template.id}/versions/${version.id}/publish`);

  const contract = await api<{ id: string }>(page, base, 'POST', '/contracts', {
    orgId: org!.id,
    name: `E2E Managed Services ${Date.now()}`,
    // Annual in arrears: never the same schedule as the monthly contracts other
    // specs create for this org, so their activation sees no overlap prompt.
    billingTiming: 'arrears',
    intervalMonths: 12,
    startDate: new Date().toISOString().slice(0, 10),
  });
  await api(page, base, 'POST', `/contracts/${contract.id}/lines`, { lineType: 'flat', description: 'Managed services', unitPrice: '100.00', taxable: false });
  await api(page, base, 'POST', `/contracts/${contract.id}/activate`);

  setup = { origin, bearer, orgId: org!.id, orgName: org!.name, templateId: template.id, templateName, contractId: contract.id };
  return setup;
}

function tokenFromLink(link: string): string {
  return decodeURIComponent(link.split('/').filter(Boolean).pop() ?? '');
}

test.describe('standalone agreement signing', () => {
  test('send from the contract workspace → sign on the public link → filed on the contract, certified download', async ({ authedPage: page, browser }) => {
    test.setTimeout(240_000);
    const s = await ensureSetup(page);

    // ── Send from the contract workspace header (spec §3.1 entry point) ──
    await page.goto(`/contracts/${s.contractId}`);
    await page.getByTestId('contract-workspace').waitFor({ timeout: 20_000 });
    await waitForHydration(page, 'contract-workspace');
    await page.getByTestId('contract-send-agreement-open').click();
    await page.getByTestId('agreements-send-dialog').waitFor();

    const templateSelect = page.getByTestId('agreements-send-template');
    await templateSelect.locator(`option[value="${s.templateId}"]`).waitFor({ state: 'attached', timeout: 20_000 });
    await templateSelect.selectOption(s.templateId);
    await page.getByTestId('agreements-send-recipients').fill('e2e-signer@example.com');
    await page.getByTestId('agreements-send-cover').fill('Please review and accept the attached BAA.');
    await page.getByTestId('agreements-send-create').click();

    // Live preview: the client name is substituted, no price anywhere.
    const preview = page.getByTestId('agreements-send-preview');
    await expect(preview.locator('strong')).toHaveText(s.orgName, { timeout: 20_000 });

    const [sendResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/contracts\/agreement-requests\/[^/]+\/send$/.test(new URL(r.url()).pathname),
        { timeout: 30_000 },
      ),
      page.getByTestId('agreements-send-submit').click(),
    ]);
    expect(sendResponse.ok()).toBeTruthy();
    const sent = (await sendResponse.json()) as { data: { link: string; request: { id: string; status: string } } };
    expect(sent.data.request.status).toBe('sent');
    const token = tokenFromLink(sent.data.link);
    expect(token.length).toBeGreaterThan(10);

    // ── Public signing page: agreement expanded, typed name + email + consent ──
    const publicContext = await browser.newContext();
    try {
      const publicPage = await publicContext.newPage();
      await publicPage.goto(`${s.origin}/portal/agreement/${token}`);
      await publicPage.getByTestId('public-agreement-sign').waitFor({ timeout: 30_000 });
      await waitForHydration(publicPage, 'public-agreement-sign');
      await expect(publicPage.getByTestId('public-agreement-cover-message')).toContainText('Please review and accept');
      await publicPage.getByTestId('public-agreement-signer').fill('Jordan Rivers');
      await publicPage.getByTestId('public-agreement-signer-email').fill('jordan.rivers@example.com');
      await publicPage.getByTestId('public-agreement-agree').check();
      await publicPage.getByTestId('public-agreement-accept').click();
      await expect(publicPage.getByTestId('public-agreement-signed')).toBeVisible({ timeout: 30_000 });
    } finally {
      await publicContext.close();
    }

    // ── The signed agreement is on the contract immediately ──
    await page.goto(`/contracts/${s.contractId}`);
    await page.getByTestId('contract-detail').waitFor({ timeout: 20_000 });
    await waitForHydration(page, 'contract-detail');
    const row = page.getByTestId('contract-document-row').filter({ hasText: s.templateName });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await expect(row.getByTestId('signed-agreement-signer')).toHaveText('Jordan Rivers');

    // Default download = the certified copy (agreement + signature certificate).
    const certifiedBtn = row.locator(
      '[data-testid^="contract-document-download-"]:not([data-testid^="contract-document-download-original-"])',
    );
    const [certified] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'GET' && /\/contracts\/contract-documents\/[^/]+\/pdf$/.test(new URL(r.url()).pathname)),
      certifiedBtn.click(),
    ]);
    expect(certified.status()).toBe(200);
    expect(certified.headers()['content-type']).toContain('application/pdf');
    expect(certified.headers()['x-agreement-copy']).toBe('certified');

    const [original] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'GET' && /\/contracts\/contract-documents\/[^/]+\/pdf$/.test(new URL(r.url()).pathname)),
      row.locator('[data-testid^="contract-document-download-original-"]').click(),
    ]);
    expect(original.status()).toBe(200);
    expect(original.headers()['x-agreement-copy']).toBe('original');
  });

  test('record a signed agreement with an uploaded scan → its certified copy is a PDF', async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const s = await ensureSetup(page);

    await page.goto('/agreements/signed');
    await page.getByTestId('signed-agreements-tab').waitFor({ timeout: 20_000 });
    await waitForHydration(page, 'signed-agreements-tab');
    await page.getByTestId('agreements-record-open').click();
    await page.getByTestId('agreements-record-dialog').waitFor();

    const orgSelect = page.getByTestId('agreements-record-org');
    await orgSelect.locator(`option[value="${s.orgId}"]`).waitFor({ state: 'attached', timeout: 20_000 });
    await orgSelect.selectOption(s.orgId);
    const templateSelect = page.getByTestId('agreements-record-template');
    await templateSelect.locator(`option[value="${s.templateId}"]`).waitFor({ state: 'attached', timeout: 20_000 });
    await templateSelect.selectOption(s.templateId);
    await page.getByTestId('agreements-record-method').selectOption('signed_document');
    await page.getByTestId('agreements-record-reference').fill('Wet-ink copy in the client folder');
    await page.getByTestId('agreements-record-signer-name').fill('Casey Morgan');
    await page.getByTestId('agreements-record-file').setInputFiles({ name: 'signed-baa.png', mimeType: 'image/png', buffer: PNG_SCAN });

    const [recorded] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/contracts\/agreement-requests\/record-signed$/.test(new URL(r.url()).pathname),
        { timeout: 30_000 },
      ),
      page.getByTestId('agreements-record-submit').click(),
    ]);
    expect(recorded.status()).toBe(201);
    const { data } = (await recorded.json()) as { data: { signedAgreementId: string } };

    const certifiedBtn = page.getByTestId(`contract-document-download-${data.signedAgreementId}`);
    await certifiedBtn.waitFor({ timeout: 20_000 });
    const [certified] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(`/contract-documents/${data.signedAgreementId}/pdf`)),
      certifiedBtn.click(),
    ]);
    expect(certified.status()).toBe(200);
    // A PNG scan's certified copy is a PDF (image page + certificate page)…
    expect(certified.headers()['content-type']).toContain('application/pdf');
    const [original] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(`/contract-documents/${data.signedAgreementId}/pdf`)),
      page.getByTestId(`contract-document-download-original-${data.signedAgreementId}`).click(),
    ]);
    // …while the original is the stored image, byte for byte.
    expect(original.headers()['content-type']).toContain('image/png');
    expect(original.headers()['content-length']).toBe(String(PNG_SCAN.length));
    // The app consumes that response as a blob, so Playwright keeps no body for
    // it; fetch the same URL directly to compare the bytes.
    const direct = await page.request.fetch(original.url(), { headers: { Authorization: `Bearer ${s.bearer}` } });
    expect(direct.ok()).toBeTruthy();
    expect(Buffer.from(await direct.body()).equals(PNG_SCAN)).toBe(true);
  });

  test('voiding a sent request kills its link', async ({ authedPage: page, browser }) => {
    test.setTimeout(180_000);
    const s = await ensureSetup(page);

    const draft = await api<{ id: string }>(page, s, 'POST', '/contracts/agreement-requests', {
      orgId: s.orgId,
      templateId: s.templateId,
      recipients: ['void-check@example.com'],
    });
    const sent = await api<{ link: string }>(page, s, 'POST', `/contracts/agreement-requests/${draft.id}/send`);
    const token = tokenFromLink(sent.link);

    await page.goto('/agreements/signed#status=pending');
    await page.getByTestId('signed-agreements-tab').waitFor({ timeout: 20_000 });
    await waitForHydration(page, 'signed-agreements-tab');
    await expect(page.getByTestId('agreements-status-pending')).toHaveAttribute('aria-pressed', 'true');
    const voidBtn = page.getByTestId(`agreement-request-void-${draft.id}`);
    await voidBtn.waitFor({ timeout: 20_000 });
    // Remind ships in W3b — nothing is rendered for it.
    await expect(page.locator('[data-testid^="agreement-request-remind-"]')).toHaveCount(0);
    await voidBtn.click();
    await page.getByTestId('agreement-request-void-dialog').waitFor();
    await page.getByTestId('agreement-request-void-reason').fill('Sent to the wrong contact');
    const [voided] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/agreement-requests/${draft.id}/void`)),
      page.getByTestId('agreement-request-void-confirm').click(),
    ]);
    expect(voided.ok()).toBeTruthy();

    const publicContext = await browser.newContext();
    try {
      const publicPage = await publicContext.newPage();
      await publicPage.goto(`${s.origin}/portal/agreement/${token}`);
      // The resolver checks the post-commit Redis jti revoke first (the same
      // generic 401 page as any dead link, spec §8 "401 page"); without the
      // marker the DB kill answers 410 "withdrawn". Either way: no sign panel.
      await expect(
        publicPage.getByTestId('public-agreement-error').or(publicPage.getByTestId('public-agreement-unavailable')),
      ).toBeVisible({ timeout: 30_000 });
      await expect(publicPage.getByTestId('public-agreement-sign')).toHaveCount(0);
      // And the link cannot be used to sign by calling the API directly.
      const accept = await publicPage.request.post(`${s.origin}/api/v1/agreements/public/${encodeURIComponent(token)}/accept`, {
        data: { signerName: 'Late Signer', signerEmail: 'late.signer@example.com' },
      });
      expect([401, 410]).toContain(accept.status());
    } finally {
      await publicContext.close();
    }
  });
});
