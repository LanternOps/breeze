import type { Page } from '@playwright/test';
import { waitForAppReady } from './hydration';

/** Settings → AI → Script authoring (W04, #5612). data-testid only. */
export class ScriptAuthoringPage {
  constructor(private readonly page: Page) {}

  async goto() {
    await this.page.goto('/settings/ai-script-authoring');
    // Astro islands hydrate AFTER navigation resolves; interacting before
    // that silently drops the input. Wait on the island's own root.
    await waitForAppReady(this.page, 'script-authoring-org-card');
  }

  get partnerCard() { return this.page.getByTestId('script-authoring-partner-card'); }
  get orgCard() { return this.page.getByTestId('script-authoring-org-card'); }
  classCheckbox(cls: string) { return this.page.getByTestId(`script-class-${cls}`); }
  classReason(cls: string) { return this.page.getByTestId(`script-class-${cls}-reason`); }
  get enableToggle() { return this.page.getByTestId('script-unattended-enabled'); }
  get save() { return this.page.getByTestId('script-authoring-save'); }
  get error() { return this.page.getByTestId('script-authoring-error'); }
  get laneBanner() { return this.page.getByTestId('script-lane-banner'); }
  get laneReset() { return this.page.getByTestId('script-lane-reset'); }
}
