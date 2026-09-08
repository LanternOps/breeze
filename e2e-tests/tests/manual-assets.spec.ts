import { test, expect } from '../fixtures';
import { DevicesPage } from '../pages/DevicesPage';

// Manual asset entry (#4622 W04): a hand-entered, non-networked inventory row
// (spare laptop, desk phone, non-networked printer) — the third class of the
// unified Devices list alongside agent devices and discovered network assets.
// data-testid selectors only, per e2e-tests/README.md.
test.describe('Manual assets', () => {
  test('add a manual asset, see it under the Manual segment, edit it, delete it', async ({ authedPage }) => {
    const devices = new DevicesPage(authedPage);
    const name = `E2E Manual Asset ${Date.now()}`;
    const updatedName = `${name} (edited)`;

    await devices.goto();

    await devices.openAddManualAssetModal();
    await devices.fillOrgAndSiteIfNeeded();
    await devices.nameInput().fill(name);
    const id = await devices.submitCreate();
    await devices.manualAssetModal().waitFor({ state: 'hidden' });

    // Manual segment now shows the new row.
    await devices.manualSegment().click();
    await expect(devices.editButton(id)).toBeVisible();

    // Edit: change the name, save, confirm the PATCH round-trips.
    await devices.editButton(id).click();
    await devices.manualAssetModal().waitFor();
    await devices.nameInput().fill(updatedName);
    await devices.submitUpdate(id);
    await devices.manualAssetModal().waitFor({ state: 'hidden' });

    // Delete: confirm-gated, then the row is gone.
    await devices.deleteAsset(id);
    await expect(devices.editButton(id)).not.toBeVisible();
  });
});
