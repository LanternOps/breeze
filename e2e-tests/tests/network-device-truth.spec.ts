import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { NetworkDevicePage } from '../pages/NetworkDevicePage';

/**
 * Network device page truth (#W05, spec §11 + D9).
 *
 * Covers what unit tests cannot: the real page against the real API — that the
 * status badge is sourced rather than a bare "Online", that Check now produces
 * a visible RESULT LINE whichever way it goes (spec §14: never toast-only),
 * that Settings hands off to W04's modal through the hash, and that the
 * Monitoring tab renders collection state rather than "Enabled".
 *
 * Assets are created through the Devices page's own "Add network asset" flow
 * (the same one manual-network-asset.spec.ts drives) so the specs share no
 * fixture state. They run serially to limit load on the shared test environment.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

/** Creates a network asset via the real UI and returns its id. */
async function createAsset(
  authedPage: import('@playwright/test').Page,
  type: 'switch' | 'printer',
): Promise<{ id: string; label: string }> {
  const label = `E2E ${type} ${Date.now()}`;
  await authedPage.goto('/devices');
  await authedPage.getByTestId('devices-page-add-menu-trigger').waitFor();
  await authedPage.getByTestId('devices-page-add-menu-trigger').click();
  await authedPage.getByTestId('devices-page-add-menu-network-asset').click();

  await authedPage.getByTestId('asset-label').waitFor();
  await authedPage.getByTestId('asset-label').fill(label);
  await authedPage.getByTestId('asset-type').selectOption(type);
  await authedPage.getByTestId('asset-ip').fill(`10.77.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);

  const siteSelect = authedPage.getByTestId('asset-site');
  if (!(await siteSelect.inputValue())) {
    await siteSelect.selectOption({ index: 1 });
  }

  const [response] = await Promise.all([
    authedPage.waitForResponse((res) => res.url().includes('/devices/network') && res.request().method() === 'POST'),
    authedPage.getByTestId('asset-submit').click(),
  ]);
  expect(response.status()).toBe(201);
  const created = await response.json();

  // Some types offer a post-create hand-off; decline it when present.
  const postCreate = authedPage.getByTestId('asset-post-create-done');
  if (await postCreate.isVisible().catch(() => false)) {
    await postCreate.click();
  }

  return { id: created.id as string, label };
}

test.describe('network device page truth', () => {
  test('the status badge names its source and its age, never a bare Online', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.root().waitFor();

    const badge = page.statusBadge();
    await expect(badge).toBeVisible();
    // The copy rule: every status string is "<state> · <source> <relative>".
    await expect(badge).toContainText('·');
    // A never-scanned manual asset is Unverified, not Offline — an absent
    // verdict must never render as a negative one.
    await expect(badge).not.toHaveText('Online');
    await expect(badge).not.toHaveText('Offline');

    // The strip repeats the same sourced string, not a second phrasing.
    await expect(page.statReachability()).toContainText('·');
  });

  test('Check now produces an inline result line, never a toast alone', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.checkNow().waitFor();

    const [response] = await Promise.all([
      authedPage.waitForResponse((res) => res.url().includes(`/discovery/assets/${id}/probe`) && res.request().method() === 'POST'),
      page.checkNow().click(),
    ]);
    // 200 = answered, 202 = pending, 409 = no agent in this site / already
    // running. On a seeded stack with no agent at the site the honest outcome
    // is 409, and the acceptance criterion is that the page SAYS so inline.
    expect([200, 202, 409]).toContain(response.status());

    await expect(page.probeStatus().or(page.probeError())).toBeVisible({ timeout: 15_000 });
  });

  test('Settings opens W04’s modal and the hash addresses its sections', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);

    await page.settingsButton().click();
    await expect(page.settingsModal()).toBeVisible();
    await expect(authedPage).toHaveURL(/#overview\/settings\/identity$/);

    // Deep-linking straight to a section is how Discovery and /monitoring
    // hand off to this page.
    await page.goto(id, '#overview/settings/monitoring');
    await expect(page.settingsModal()).toBeVisible();
    await expect(authedPage).toHaveURL(/#overview\/settings\/monitoring$/);
  });

  test('the Monitoring tab shows collection state and a working range toggle', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.openMonitoringTab();

    await expect(page.pollConfig()).toBeVisible();
    // With no SNMP device yet, the honest state is "not configured" — not an
    // empty table that reads as "nothing to report".
    await expect(page.oidTable().or(page.oidNoTemplate()).or(page.oidNotConfigured())).toBeVisible();
    await expect(page.checks()).toBeVisible();
    await expect(page.thresholds()).toBeVisible();

    // Charts only fetch once something is collecting; otherwise they say so.
    if (await page.chartRange('7d').isVisible().catch(() => false)) {
      const [metricsResponse] = await Promise.all([
        authedPage.waitForResponse((res) => res.url().includes(`/monitoring/assets/${id}/metrics`)),
        page.chartRange('7d').click(),
      ]);
      expect(metricsResponse.url()).toContain('bucket=1h');
    } else {
      await expect(page.chartsEmpty()).toBeVisible();
    }
  });

  test('"All scan details" is closed by default and opens on demand', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.identity().waitFor();

    await expect(page.scanDetails()).not.toHaveAttribute('open', /.*/);
    await page.scanDetailsToggle().click();
    await expect(page.scanDetails()).toHaveAttribute('open', /.*/);
  });

  test('the printer Health card states what is not collected yet', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'printer');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.health().waitFor();

    // No SNMP device yet: the card IS the set-up affordance.
    await expect(page.healthEmpty().or(page.healthUnavailable())).toBeVisible();
    await expect(page.supplyMeters()).toHaveCount(0);
    await expect(page.setUpMonitoring()).toBeVisible();
  });

  test('a polled printer shows supply meters and a page count', async ({ authedPage }) => {
    test.skip(process.env.E2E_SNMP_FIXTURE !== '1', 'needs a seeded SNMP supply fixture');
    const assetId = process.env.E2E_SNMP_PRINTER_ASSET_ID!;
    const page = new NetworkDevicePage(authedPage);
    await page.goto(assetId);
    await page.health().waitFor();

    await expect(page.supplyMeters().first()).toBeVisible();
    await expect(page.pageCount()).toBeVisible();
  });
});
