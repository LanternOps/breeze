import type { APIRequestContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { OrganizationsBoardPage } from '../pages/OrganizationsBoardPage';

/**
 * Organizations account board (W02). One serial test sharing one login and
 * one org created up front — the same reasoning as organization-record.spec.ts:
 * separate tests would each replay the storageState and trip the API's
 * refresh-reuse detection. The org is created inline against the real API;
 * no seeded org fixture exists.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

/** Recover the access token the app itself is using (minting one here would rotate the refresh cookie and revoke the page's session). */
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
    await expect.poll(() => token, { message: 'an authenticated /api/v1 request from the app', timeout: 30_000 }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

async function apiJson<T>(request: APIRequestContext, token: string, method: 'get' | 'post', path: string, data?: unknown): Promise<T> {
  const res = await request[method](path, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

test.describe('organizations board', () => {
  test('lists a new org with its setup chips, filters and lenses it, and opens the record from the row menu', async ({ authedPage: page }, testInfo) => {
    test.setTimeout(120_000);
    const board = new OrganizationsBoardPage(page);
    const token = await readAccessToken(page);
    const stamp = `${Date.now()}-${testInfo.retry}`;
    const org = await apiJson<{ id: string; name: string }>(page.request, token, 'post', '/api/v1/orgs/organizations', {
      name: `E2E Board ${stamp}`,
      slug: `e2e-board-${stamp}`,
    });

    await test.step('1. the board lists the org with a "No devices enrolled" repair chip', async () => {
      await board.goto();
      await expect(board.heading()).toBeVisible();
      await board.search().fill(org.name);
      await expect(board.row(org.id)).toBeVisible();
      const chip = board.chip(org.id, 'noDevices');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', `/organizations/${org.id}#devices`);
    });

    await test.step('2. the band cell and the filter chip agree, and the Setup incomplete filter keeps the row', async () => {
      await board.search().fill('');
      await expect.poll(async () => (await board.bandCount('setupIncomplete').textContent())?.trim(), { timeout: 30_000 }).not.toBe('—');
      await board.band('setupIncomplete').click();
      await expect(board.band('setupIncomplete')).toHaveAttribute('aria-pressed', 'true');
      await expect(board.filter('setupIncomplete')).toHaveAttribute('aria-pressed', 'true');
      await board.search().fill(org.name);
      await expect(board.row(org.id)).toBeVisible();
      await expect(page).toHaveURL(/#lens=both&filter=setupIncomplete$/);
    });

    await test.step('3. the Account lens hides the Setup chips; a Setup filter forces the lens back to Both', async () => {
      await board.lens('account').click();
      await expect(board.lens('account')).toHaveAttribute('aria-pressed', 'true');
      await expect(board.chip(org.id, 'noDevices')).toHaveCount(0);
      await board.filter('setupIncomplete').click();
      await expect(board.lens('both')).toHaveAttribute('aria-pressed', 'true');
      await expect(board.chip(org.id, 'noDevices')).toBeVisible();
    });

    await test.step('4. the row menu opens the record', async () => {
      await board.more(org.id).click();
      await board.menuOpenRecord().click();
      await page.waitForURL(`**/organizations/${org.id}`);
    });

    await test.step('5. the old settings path redirects to the board', async () => {
      await page.goto('/settings/organizations');
      await page.waitForURL((url) => url.pathname === '/organizations');
      await expect(board.root()).toBeVisible();
    });

    // --- W03: Integrations column. A DNS filter integration is the one mapping that can be
    // created through the API without an external system (POST /dns-security/integrations
    // inserts the row directly), so it is the seed for a visible badge. This spec creates
    // only one org (`org`) up front, so a second org is created here for the "Nothing
    // linked" case (mirroring the orgA/orgB pattern organization-record.spec.ts uses).
    await test.step('Integrations column shows a never-synced DNS badge and Nothing linked; the Unlinked filter is reachable', async () => {
      const orgB = await apiJson<{ id: string; name: string }>(page.request, token, 'post', '/api/v1/orgs/organizations', {
        name: `E2E Board B ${stamp}`,
        slug: `e2e-board-b-${stamp}`,
      });
      await apiJson(page.request, token, 'post', '/api/v1/dns-security/integrations', {
        orgId: org.id,
        provider: 'pihole',
        name: 'E2E Pi-hole',
        apiKey: 'e2e-not-a-real-key',
        // apiEndpoint is required by the route's createIntegrationSchema for provider 'pihole';
        // 'on-prem-http' SSRF mode allows plain http:// on-prem hostnames.
        config: { apiEndpoint: 'http://pihole.e2e.local/api' },
      });
      await board.goto();
      await expect(board.columnIntegrations()).toBeVisible();
      const dns = board.badge(org.id, 'dns_filter');
      await expect(dns).toBeVisible();
      await expect(dns).toHaveAttribute('title', 'Never synced');
      await expect(board.nothingLinked(orgB.id)).toBeVisible();

      // No partner connector is configured in the E2E stack, so no org can be "not linked":
      // the Unlinked cell and filter exist (the caller has connected_apps:read) and count 0.
      await expect(board.bandUnlinkedCount()).toHaveText('0');
      await board.filterUnlinked().click();
      await expect(board.bandUnlinked()).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/filter=unlinked/);
      await expect(board.row(org.id)).toHaveCount(0);
      await expect(board.row(orgB.id)).toHaveCount(0);
    });
  });
});
