import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';

/**
 * Manual network asset — website/URL targets (#5213 W03).
 *
 * Covers the one thing unit tests cannot: opening the real Devices page,
 * driving the real "Add network asset" split menu and form against the real
 * API, and seeing the created row land in the Network segment of the unified
 * list with its Manual source badge.
 *
 * Status has no `data-testid` on the DeviceList status badge (owned by the
 * parallel #4622 wave, out of this wave's file-ownership scope — see the PR
 * body) — that half of the "status Unknown" acceptance criterion is
 * asserted from the create response instead, which is a network assertion,
 * not a DOM selector, so it stays inside the data-testid-only rule for
 * anything this spec actually *locates* on the page.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('manual network asset — website target', () => {
  test('create a website asset from the Devices page and see it in the Network segment', async ({ authedPage }) => {
    const label = `E2E Shop ${Date.now()}`;
    const url = `https://shop-${Date.now()}.example`;

    await authedPage.goto('/devices');
    await authedPage.getByTestId('devices-page-add-menu-trigger').waitFor();
    await authedPage.getByTestId('devices-page-add-menu-trigger').click();
    await authedPage.getByTestId('devices-page-add-menu-network-asset').click();

    await authedPage.getByTestId('asset-label').waitFor();
    await authedPage.getByTestId('asset-label').fill(label);
    await authedPage.getByTestId('asset-type').selectOption('website');

    // website/service hides MAC — the field must not exist at all, not just
    // be empty, or a stale value from a prior asset type would silently post.
    await expect(authedPage.getByTestId('asset-mac')).toHaveCount(0);

    const siteSelect = authedPage.getByTestId('asset-site');
    if (!(await siteSelect.inputValue())) {
      await siteSelect.selectOption({ index: 1 });
    }

    await authedPage.getByTestId('asset-url').fill(url);
    await expect(authedPage.getByTestId('asset-submit')).toBeEnabled();

    const [response] = await Promise.all([
      authedPage.waitForResponse((res) => res.url().includes('/devices/network') && res.request().method() === 'POST'),
      authedPage.getByTestId('asset-submit').click(),
    ]);
    expect(response.status()).toBe(201);
    const created = await response.json();
    // Never scanned yet: born with no liveness data, not a reachability claim.
    expect(created.status).toBe('unknown');

    // Website/service offers the HTTP-check hand-off instead of closing —
    // decline it, this spec only covers asset creation and list placement.
    await authedPage.getByTestId('asset-post-create').waitFor();
    await authedPage.getByTestId('asset-post-create-done').click();

    await authedPage.getByTestId('device-class-segment-network').click();
    await expect(authedPage.getByTestId(`device-${created.id}-source`)).toHaveText(/manual/i, { timeout: 15_000 });
  });
});
