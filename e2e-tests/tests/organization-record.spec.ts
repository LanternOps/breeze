import type { APIRequestContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { waitForAppReady } from '../pages/hydration';
import { OrganizationRecordPage } from '../pages/OrganizationRecordPage';

/**
 * Organization record page (#5075) — the four browser-reachable scenarios
 * from the W03 plan's Task 3.5.
 *
 * Fixtures are created inline against the real API (the same approach
 * `multi-currency.spec.ts` takes — no seeded org fixtures exist for this), so
 * the spec doesn't depend on environment-specific seed data. All four
 * scenarios run inside one serial test sharing one login and the two orgs
 * created up front, mirroring `multi-currency.spec.ts`'s reasoning: splitting
 * them into separate tests hands each a fresh context replaying the same
 * storageState, and the API's refresh-reuse detection revokes the whole
 * family on the second `/auth/refresh`.
 *
 * Scenario 3 substitutes the Tickets tab for the plan's Devices tab: Devices
 * belongs to the parallel W02 wave and its testids don't exist in this branch
 * yet. The guarantee under test — a record page pinned to ITS org on the wire
 * while the switcher points elsewhere — is identical on either tab; Tickets
 * is the one this PR actually ships, proven directly against the outgoing
 * request's `orgId` query param rather than just what renders.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

const stamp = Date.now();

/** Recover the access token the app itself is using (see multi-currency.spec.ts
 *  for why: the durable credential is an httpOnly refresh cookie, and minting a
 *  fresh token here would rotate it and revoke the page's own session mid-test). */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    if (token) return;
    const header = req.headers()['authorization'];
    if (header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
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

test.describe('organization record', () => {
  test('open from the list, deep-link a tab, stay org-pinned under a mismatched switcher, and Work in this org', async ({ authedPage: page }) => {
    test.setTimeout(120_000);
    const record = new OrganizationRecordPage(page);
    const token = await readAccessToken(page);

    // Two orgs: A is the record under test, B is what the switcher points at
    // during scenario 3 — the mismatch the record must survive.
    const orgA = await apiJson<{ id: string; name: string }>(
      page.request, token, 'post', '/api/v1/orgs/organizations',
      { name: `E2E Record A ${stamp}`, slug: `e2e-record-a-${stamp}` },
    );
    const orgB = await apiJson<{ id: string; name: string }>(
      page.request, token, 'post', '/api/v1/orgs/organizations',
      { name: `E2E Record B ${stamp}`, slug: `e2e-record-b-${stamp}` },
    );

    await test.step('1. opens from the settings list at /organizations/:id', async () => {
      await page.goto('/settings/organizations');
      await page.getByTestId(`org-open-record-${orgA.id}`).click();
      await page.waitForURL(`**/organizations/${orgA.id}`);
      await waitForAppReady(page, 'org-record-header');
      await expect(record.header()).toContainText(orgA.name);
    });

    await test.step('2. a #tickets deep link opens the Tickets tab', async () => {
      await record.goto(orgA.id, '#tickets');
      await expect(record.ticketsTab()).toBeVisible();
      await expect(record.overviewTab()).toHaveCount(0);
    });

    await test.step('3. a mismatched switcher does not leak into the record', async () => {
      // Point the switcher at org B.
      await page.goto('/');
      await page.getByTestId('org-switcher-trigger').click();
      const search = page.getByTestId('org-switcher-search');
      if (await search.isVisible().catch(() => false)) await search.fill(orgB.name);
      await page.getByTestId(`org-option-${orgB.id}`).click();
      await expect(page.getByTestId('org-switcher-label')).toHaveText(orgB.name);

      // Open org A's record — the scope chip names the mismatch (org B), and
      // the record's own header stays org A's.
      await record.goto(orgA.id, '#tickets');
      await expect(record.header()).toContainText(orgA.name);
      await expect(record.scopeChip()).toContainText(orgB.name);

      // The Tickets tab's OWN request must carry org A on the wire, never
      // org B — proven directly against the request, not just the render.
      const ticketsRequest = page.waitForRequest((req) => /\/tickets\?/.test(req.url()));
      await record.ticketsStatusTab('all').click();
      const req = await ticketsRequest;
      expect(req.url()).toContain(`orgId=${orgA.id}`);
      expect(req.url()).not.toContain(orgB.id);
    });

    await test.step('4. Work in this org switches the workspace to the record org', async () => {
      await record.goto(orgA.id);
      await record.workHereButton().click();
      await page.waitForURL((url) => url.pathname === '/');
      await expect(page.getByTestId('org-switcher-label')).toHaveText(orgA.name);
    });
  });
});
