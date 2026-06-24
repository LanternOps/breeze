import { test, expect } from '../fixtures';

// Fixed Windows device id from seed-fixtures.sql (carries the seeded open CVE).
const WINDOWS_DEVICE_ID = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';
const SEEDED_CVE = 'CVE-2025-E2E-0001';

const rowSelector = '[data-testid^="vulnerability-row-"]';

test.describe('Vulnerabilities', () => {
  test('fleet dashboard lists CVE rows', async ({ authedPage }) => {
    await authedPage.goto('/vulnerabilities');
    await expect(authedPage.locator(rowSelector).first()).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText(SEEDED_CVE)).toBeVisible();
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
});
