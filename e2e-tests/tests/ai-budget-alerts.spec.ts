import { test, expect } from '../fixtures';
import { AiUsagePage } from '../pages/AiUsagePage';

/**
 * #4388 W03 — org AI budget threshold alerts, browser slice.
 *
 * Two things a browser can prove that the API/integration suites (Wave 2)
 * cannot:
 *   1. the alert-threshold input on `/settings/ai-usage` actually round-trips
 *      through the real save button and a page reload (not just the PUT
 *      /ai/budget contract);
 *   2. a fired rung for the org's current monthly period renders in
 *      `ai-budget-fired-rungs` — seeded via `e2e-tests/seed-fixtures.sql` /
 *      `apps/api/src/db/seedE2eFixtures.ts` (one 80% monthly
 *      `ai_budget_alert_events` row for the seeded org, current UTC
 *      `YYYY-MM` period key).
 *
 * Restoring the thresholds afterwards is not required — this is the only
 * spec that touches this org's `ai_budgets.alert_threshold_pcts`.
 */
test.describe('AI budget alert thresholds', () => {
  test('thresholds input round-trips and a fired rung renders', async ({ authedPage }) => {
    const aiUsage = new AiUsagePage(authedPage);
    await aiUsage.goto();

    await expect(aiUsage.firedRungs()).toBeVisible();
    await expect(aiUsage.firedRungs()).toContainText('80%');

    await aiUsage.thresholdsInput().fill('60, 90');
    await aiUsage.thresholdsInput().blur();

    const [putResponse] = await Promise.all([
      authedPage.waitForResponse(
        (r) => r.request().method() === 'PUT' && /\/ai\/budget$/.test(new URL(r.url()).pathname),
      ),
      aiUsage.saveButton().click(),
    ]);
    expect(putResponse.ok()).toBe(true);

    await authedPage.reload();
    await aiUsage.waitUntilReady();
    await expect(aiUsage.thresholdsInput()).toHaveValue('60, 90');
  });
});
