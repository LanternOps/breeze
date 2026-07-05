import { test, expect } from '../fixtures';
import { VulnerabilitiesPage } from '../pages/VulnerabilitiesPage';

// Fixed Windows device id from seed-fixtures.sql (carries the seeded open CVE).
const WINDOWS_DEVICE_ID = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';
const SEEDED_CVE = 'CVE-2025-E2E-0001';

const rowSelector = '[data-testid^="vulnerability-row-"]';

test.describe('Vulnerabilities', () => {
  test('fleet dashboard lists CVE rows', async ({ authedPage }) => {
    await authedPage.goto('/vulnerabilities#cves');
    await expect(authedPage.locator(rowSelector).first()).toBeVisible({ timeout: 15_000 });
    // ResponsiveTable renders both the desktop row and the mobile card for the
    // same CVE (CSS-toggled, not conditionally rendered), so this now needs
    // .first() to avoid a strict-mode violation once it targets the #cves tab.
    await expect(authedPage.getByText(SEEDED_CVE).first()).toBeVisible();
  });

  test('per-device tab accept-risk drops a finding out of the open list', async ({ authedPage }) => {
    await authedPage.goto(`/devices/${WINDOWS_DEVICE_ID}#vulnerabilities`);

    const rows = authedPage.locator(rowSelector);
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);

    // Open the accept-risk modal on the first finding and submit it.
    await authedPage.locator('[data-testid^="accept-"]').first().click();
    await expect(authedPage.getByTestId('vuln-action-modal')).toBeVisible();
    await authedPage.getByTestId('vuln-action-text').fill('Compensating control in place (e2e)');
    await authedPage.getByTestId('vuln-action-until').fill('2030-01-01');
    await authedPage.getByTestId('vuln-action-submit').click();

    // The tab re-fetches status=open findings, so the accepted one disappears.
    await expect(authedPage.locator(rowSelector)).toHaveCount(before - 1, { timeout: 15_000 });
  });

  test('fleet triage: accept risk from software drawer, reopen from CVE drawer', async ({ authedPage }) => {
    const vulnPage = new VulnerabilitiesPage(authedPage);
    await vulnPage.goto();

    // Stat cards render.
    await expect(vulnPage.statCritical()).toBeVisible({ timeout: 15_000 });

    // Software work queue is the default tab; open the first group's drawer.
    await expect(vulnPage.groupRows().first()).toBeVisible({ timeout: 15_000 });
    const groupsBefore = await vulnPage.groupRows().count();
    await vulnPage.groupRows().first().click();
    await expect(vulnPage.softwareDrawer()).toBeVisible();

    // Accept risk for the pre-selected open findings.
    await vulnPage.actionAccept().click();
    await expect(vulnPage.bulkModal()).toBeVisible();
    await vulnPage.bulkText().fill('Compensating control in place (fleet e2e)');
    await vulnPage.bulkUntil().fill('2030-01-01');
    await vulnPage.bulkSubmit().click();

    // Drawer reloads; close it. The open queue shrinks (group had only open findings).
    await expect(vulnPage.bulkModal()).toBeHidden({ timeout: 15_000 });
    await vulnPage.drawerClose('vuln-software-drawer').click();
    await expect(vulnPage.groupRows()).toHaveCount(groupsBefore - 1, { timeout: 15_000 });

    // Restore: find the accepted finding on the CVE tab and reopen it.
    await vulnPage.tabCves().click();
    await vulnPage.filterStatus().selectOption('accepted');
    await expect(vulnPage.cveRows().first()).toBeVisible({ timeout: 15_000 });
    await vulnPage.cveRows().first().click();
    await expect(vulnPage.cveDrawer()).toBeVisible();
    // The drawer container renders before its findings fetch resolves, so wait
    // for a reopen button rather than counting immediately (avoids a 0-count race).
    await expect(vulnPage.reopenButtons().first()).toBeVisible({ timeout: 15_000 });
    const reopenCount = await vulnPage.reopenButtons().count();
    expect(reopenCount).toBeGreaterThan(0);
    // Reopen every accepted finding this e2e created.
    for (let i = 0; i < reopenCount; i += 1) {
      await vulnPage.reopenButtons().first().click();
      await expect(vulnPage.reopenButtons()).toHaveCount(reopenCount - i - 1, { timeout: 15_000 });
    }
  });
});
