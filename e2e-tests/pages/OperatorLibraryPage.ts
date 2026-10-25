import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForHydration } from './hydration';

/**
 * Page Objects for the Operator Recipe Library (W06 R1b, #6171): the /operator
 * workspace's Library tab, the "Offboard a person" start form (from a contact
 * on the org record page), and the task page panels. `data-testid` only.
 */
export class OperatorLibraryPage extends BasePage {
  libraryTab = () => this.page.getByTestId('operator-tab-library');
  card = (recipeKey: string) => this.page.getByTestId(`recipe-card-${recipeKey}`);
  readiness = (recipeKey: string) => this.page.getByTestId(`recipe-readiness-${recipeKey}`);
  start = (recipeKey: string) => this.page.getByTestId(`recipe-start-${recipeKey}`);

  /** Pins the org switcher to `orgId` before the app boots (same key TopologyPage uses). */
  async pinOrg(orgId: string) {
    await this.page.addInitScript((id: string) => {
      let stored: { state?: Record<string, unknown>; version?: number } = {};
      try { stored = JSON.parse(localStorage.getItem('breeze-org') ?? '{}'); } catch { /* fresh */ }
      localStorage.setItem('breeze-org', JSON.stringify({
        state: { ...stored.state, currentOrgId: id, lastOrgId: id, allOrgs: false },
        version: stored.version ?? 0,
      }));
    }, orgId);
  }

  async gotoLibrary() {
    await this.page.goto('/operator#tab=library');
    await this.libraryTab().waitFor({ timeout: 30_000 });
    await waitForHydration(this.page, 'operator-tab-library');
  }
}

export class StartRecipeFormPage extends BasePage {
  form = () => this.page.getByTestId('start-recipe-form');
  person = () => this.page.getByTestId('start-recipe-person');
  inheritorMode = (mode: 'none' | 'contact' | 'address') => this.page.getByTestId(`start-recipe-inheritor-mode-${mode}`);
  inheritorAddress = () => this.page.getByTestId('start-recipe-inheritor-address');
  cutoffHelp = () => this.page.getByTestId('start-recipe-cutoff-help');
  keepMailbox = () => this.page.getByTestId('start-recipe-keep-mailbox');
  effect = (toggle: string) => this.page.getByTestId(`start-recipe-effect-${toggle}`);
  previewButton = () => this.page.getByTestId('start-recipe-preview-button');
  preview = () => this.page.getByTestId('start-recipe-preview');
  previewProvider = (provider: string) => this.page.getByTestId(`start-recipe-preview-provider-${provider}`);
  submit = () => this.page.getByTestId('start-recipe-submit');
  error = () => this.page.getByTestId('start-recipe-error');

  /** Opens the org record's contacts tab and the launcher on one contact row. */
  async openFromContact(page: Page, orgId: string, contactId: string) {
    await page.goto(`/organizations/${orgId}#contacts`);
    const launcher = page.getByTestId(`offboard-launcher-contact-${contactId}`);
    await launcher.waitFor({ timeout: 30_000 });
    await waitForHydration(page, `offboard-launcher-contact-${contactId}`);
    await launcher.click();
    await this.form().waitFor();
  }
}

export class OperatorTaskPanelsPage extends BasePage {
  steps = () => this.page.getByTestId('task-steps');
  step = (stepKey: string) => this.page.getByTestId(`task-step-${stepKey}`);
  tab = (panel: 'steps' | 'plan' | 'events') => this.page.getByTestId(`task-panel-tab-${panel}`);
  plan = () => this.page.getByTestId('task-plan');
  planRevision = (n: number) => this.page.getByTestId(`task-plan-revision-${n}`);
  planProvider = (provider: string) => this.page.getByTestId(`task-plan-provider-${provider}`);
  planEffect = (ordinal: number) => this.page.getByTestId(`task-plan-effect-${ordinal}`);
  events = () => this.page.getByTestId('task-events');

  async goto(taskId: string, hash = '') {
    await this.page.goto(`/operator/tasks/${taskId}${hash}`);
    await this.tab('steps').waitFor({ timeout: 30_000 });
    await waitForHydration(this.page, 'task-panel-tab-steps');
  }
}
