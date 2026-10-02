import { test, expect } from '../fixtures';
import { AiUsagePage } from '../pages/AiUsagePage';

/**
 * W11 (#7609) — the Quality view of the AI usage card, browser slice: the
 * view switch and groupings round-trip through the URL hash and the island
 * renders the quality endpoint's answer (a table, or the empty state on a
 * stack with no ledger rows in range). Metric correctness is proven by
 * aiModelQuality.integration.test.ts; this proves the page wiring.
 */
test.describe('AI usage quality view', () => {
  test('switches views and groupings through the hash', async ({ authedPage }) => {
    const usage = new AiUsagePage(authedPage);
    await usage.gotoQuality('model');
    await expect(usage.qualityPanel()).toBeVisible();
    await expect(usage.qualityPanel().getByTestId(/ai-quality-(table|empty)/)).toBeVisible();

    await usage.qualityGroup('prompt_profile').click();
    await expect(authedPage).toHaveURL(/#quality-by-prompt_profile$/);
    await expect(usage.qualityPanel()).toBeVisible();

    await usage.viewSpend().click();
    await expect(authedPage).toHaveURL(/#usage-by-model$/);
    await expect(usage.qualityPanel()).toHaveCount(0);

    await usage.viewQuality().click();
    await expect(authedPage).toHaveURL(/#quality-by-model$/);
  });
});
