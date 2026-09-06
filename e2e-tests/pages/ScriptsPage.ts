import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Page object for a single script's execution history
 * (`/scripts/:id/executions`, `apps/web/src/pages/scripts/[id]/executions.astro`
 * → `ScriptExecutionsPage.tsx`). testid-only — see e2e-tests/README.md.
 *
 * NOT `/scripts/:id` — that route (`apps/web/src/pages/scripts/[id].astro`)
 * renders `ScriptEditPage`, a different component with none of the
 * execution-row testids this page object reads.
 *
 * There is no page object for the Script Library / creation flow yet:
 * `ScriptList.tsx` has zero `data-testid` coverage and `ScriptForm.tsx` has
 * none on its create/submit fields (only on unrelated warning banners), so
 * #4767's spec creates and executes its fixture script directly against the
 * API (see script-cancel.spec.ts) and only drives the UI for the Stop
 * interaction this wave actually owns.
 */
export class ScriptsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async gotoScript(scriptId: string) {
    await this.page.goto(`/scripts/${scriptId}/executions`);
  }

  /** The status badge for one execution row, indexed by execution id. */
  executionStatus(executionId: string) {
    return this.page.getByTestId(`execution-status-${executionId}`);
  }

  cancelExecutionButton(executionId: string) {
    return this.page.getByTestId(`cancel-execution-${executionId}`);
  }

  confirmStopButton() {
    return this.page.getByTestId('confirm-stop');
  }

  confirmForceStopButton() {
    return this.page.getByTestId('confirm-force-stop');
  }

  async cancelExecution(executionId: string) {
    await this.cancelExecutionButton(executionId).click();
    await this.confirmStopButton().click();
  }

  async forceStopExecution(executionId: string) {
    await this.cancelExecutionButton(executionId).click();
    await this.confirmForceStopButton().click();
  }
}
