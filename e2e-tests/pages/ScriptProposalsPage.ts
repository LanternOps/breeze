import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * Page object for the AI script proposal surfaces (W03, #5612):
 *  - the approvals inbox rows (`/approvals`) with their "script review"
 *    disclosure, and the `#proposal-<id>` deep link that renders one proposal
 *    read-only;
 *  - the scripts library list (`/scripts`) with its Origin column;
 *  - a script's edit page (`/scripts/:id`) with the provenance panel.
 * testid-only — see e2e-tests/README.md.
 */
export class ScriptProposalsPage extends BasePage {
  private tourSuppressed = false;

  constructor(page: Page) {
    super(page);
  }

  /**
   * The onboarding tour (components/onboarding/OnboardingTour.tsx) starts 1.5 s
   * after every page load for a fresh browser context and its tooltip card
   * sits over the approvals list, intercepting the first click. It keys off one
   * localStorage flag, so set it before navigating rather than racing the card.
   */
  private async suppressTour() {
    if (this.tourSuppressed) return;
    this.tourSuppressed = true;
    await this.page.addInitScript(() => {
      try { localStorage.setItem('breeze-onboarding-complete', 'true'); } catch { /* private mode */ }
    });
  }

  async gotoApprovals() {
    await this.suppressTour();
    await this.page.goto('/approvals');
    await waitForAppReady(this.page, 'approvals-inbox');
  }

  async gotoProposal(id: string) {
    await this.suppressTour();
    await this.page.goto(`/approvals#proposal-${id}`);
    await waitForAppReady(this.page, 'approvals-inbox');
  }

  async gotoScripts() {
    await this.suppressTour();
    await this.page.goto('/scripts');
    await waitForAppReady(this.page, 'scripts-page');
  }

  async gotoScript(id: string) {
    await this.suppressTour();
    await this.page.goto(`/scripts/${id}`);
    await waitForAppReady(this.page, 'script-edit-page');
  }

  reviewToggle(approvalId: string) {
    return this.page.getByTestId(`approval-script-review-toggle-${approvalId}`);
  }

  async openScriptReview(approvalId: string) {
    await this.page.getByTestId(`approval-row-${approvalId}`).waitFor({ timeout: 30_000 });
    await this.reviewToggle(approvalId).click();
    await this.page.getByTestId('script-proposal-card').waitFor({ timeout: 30_000 });
  }

  card() {
    return this.page.getByTestId('script-proposal-card');
  }
}
