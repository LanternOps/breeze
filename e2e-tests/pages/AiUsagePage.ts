import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * `/settings/ai-usage` — org AI usage + budget configuration.
 *
 * #4388 W03: budget alert thresholds round-trip through
 * `AiBudgetThresholdsInput` (`ai-budget-thresholds-input`) and the save
 * button (`ai-budget-save`), and any already-fired rungs for the current
 * period render in `ai-budget-fired-rungs` (only present when
 * `usage.alerts.fired` is non-empty — see `AiUsagePage.tsx`).
 */
export class AiUsagePage extends BasePage {
  url = '/settings/ai-usage';

  thresholdsInput = () => this.page.getByTestId('ai-budget-thresholds-input');
  saveButton = () => this.page.getByTestId('ai-budget-save');
  firedRungs = () => this.page.getByTestId('ai-budget-fired-rungs');

  async goto() {
    await this.page.goto(this.url);
    await this.waitUntilReady();
  }

  /**
   * Wait for the island to hydrate after any navigation this Page Object did
   * not perform itself (a `page.reload()`, say). A bare `waitFor()` on the
   * input passes on the SSR'd markup, before React has attached its handlers.
   */
  async waitUntilReady() {
    await waitForAppReady(this.page, 'ai-budget-thresholds-input');
  }
}
