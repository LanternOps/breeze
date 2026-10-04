import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';

/** AI agents > Fix memory (Proven fixes + Reviewed steps tabs). testid-only. */
export class FixMemoryPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  private async open(hash: 'fixes' | 'steps') {
    await this.page.addInitScript(() => {
      try { localStorage.setItem('breeze-onboarding-complete', 'true'); } catch { /* private mode */ }
    });
    await this.page.goto(`/ai-agents/fix-memory#${hash}`);
  }

  async gotoFixes() {
    await this.open('fixes');
    await this.page.locator('[data-testid="fix-memory-table"], [data-testid="fix-memory-empty"]').first().waitFor();
  }

  async gotoSteps() {
    await this.open('steps');
    await this.page.locator('[data-testid^="fix-steps-row-"], [data-testid="fix-steps-empty"]').first().waitFor();
  }

  row(id: string) { return this.page.getByTestId(`fix-memory-row-${id}`); }
  statusBadge(id: string) { return this.page.getByTestId(`fix-memory-status-${id}`); }
  stepsRowByTitle(title: string) { return this.page.locator('[data-testid^="fix-steps-row-"]').filter({ hasText: title }); }

  async retire(id: string) {
    await this.page.getByTestId(`fix-memory-retire-${id}`).click();
    await this.page.getByTestId('fix-memory-retire-confirm').click();
  }
}
