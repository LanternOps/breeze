import { expect, test } from '../fixtures';
import { PortalVisibilityPage } from '../pages/PortalVisibilityPage';

const email = process.env.E2E_PORTAL_EMAIL ?? 'portal@breeze.local';
const password = process.env.E2E_PORTAL_PASSWORD ?? 'PortalTest123!';

test.describe.serial('portal visibility', () => {
  // Seeded with enable_dashboard = true. The tiles render for every status —
  // a source with no rows shows honest "not available" copy rather than a
  // fabricated zero — so this assertion does not depend on seeded telemetry.
  test('shows the dashboard tiles once the flag is on', async ({
    cleanPage,
  }) => {
    const portal = new PortalVisibilityPage(cleanPage);
    await portal.login(email, password);

    await expect(portal.dashboardNav()).toBeVisible();
    await portal.dashboardNav().click();
    await cleanPage.waitForURL('**/dashboard');

    await expect(portal.dashboardSecurity()).toBeVisible();
    expect(await portal.dashboardTiles().count()).toBeGreaterThan(0);
  });

  test('generates and downloads a posture PDF', async ({
    cleanPage,
  }) => {
    const portal = new PortalVisibilityPage(cleanPage);
    await portal.login(email, password);

    await expect(portal.reportsNav()).toBeVisible();
    await portal.reportsNav().click();
    await portal.generatePosture().click();

    const row = portal.reportRows().first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    const downloadPromise = cleanPage.waitForEvent('download');
    await row
      .getByTestId(/^portal-report-run-pdf-/)
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('hides Devices when self-service is disabled', async ({
    cleanPage,
  }) => {
    const portal = new PortalVisibilityPage(cleanPage);
    await portal.login(email, password);
    await expect(portal.devicesNav()).toHaveCount(0);
  });
});
