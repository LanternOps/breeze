import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/** The Suggested fixes panel on an alert page (AI Suggested Fixes W2). testid-only. */
export class SuggestedFixesPanel extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async gotoAlert(alertId: string) {
    await this.page.addInitScript(() => {
      try { localStorage.setItem('breeze-onboarding-complete', 'true'); } catch { /* private mode */ }
    });
    await this.page.goto(`/alerts/${alertId}`);
    await waitForAppReady(this.page, 'suggestions-generate');
  }

  group(id: 'proven' | 'ai' | 'similar') { return this.page.getByTestId(`suggestions-group-${id}`); }
  aiWrittenLabel(id: string) { return this.page.getByTestId(`suggestion-ai-written-${id}`); }
  anyResearchState() { return this.page.locator('[data-testid^="research-state-"]').first(); }
  /** The state a model-less stack deterministically produces: the request is denied (observed 4/4 runs, stable after 8s). */
  noModelResearchState() {
    return this.page.getByTestId('research-state-denied');
  }
  async researchDeeper() { await this.page.getByTestId('research-deeper').click(); }
  async draftScript(id: string) { await this.page.getByTestId(`suggestion-draft-${id}`).click(); }

  async saveAsReviewed(id: string, title: string) {
    await this.page.getByTestId(`suggestion-save-reviewed-${id}`).click();
    await this.page.getByTestId(`suggestion-reviewed-title-${id}`).fill(title);
    await this.page.getByTestId(`suggestion-reviewed-save-${id}`).click();
    // The inline form closes on a successful save (`suggestion-done-reviewed-*` is the
    // always-present picker <select>, not a completion marker).
    await this.page.getByTestId(`suggestion-reviewed-save-${id}`).waitFor({ state: 'hidden' });
  }
}
