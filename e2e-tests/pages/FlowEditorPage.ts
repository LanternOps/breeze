import type { Locator, Page } from '@playwright/test';
import { BasePage } from './BasePage';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Page object for the Flows editor (`/flows/new`, `/flows/:id/edit`) and the
 * small slice of the flows list / detail pages the editor spec drives.
 * testid-only — see e2e-tests/README.md.
 */
export class FlowEditorPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── navigation ────────────────────────────────────────────────────────────
  async gotoList() {
    await this.page.goto('/flows');
  }

  async gotoNew() {
    await this.page.goto('/flows/new');
    await this.root().waitFor();
  }

  async gotoEdit(id: string) {
    await this.page.goto(`/flows/${id}/edit`);
    await this.root().waitFor();
  }

  /** The flow id in `/flows/<id>/edit` or `/flows/<id>`; null when the URL carries none. */
  currentFlowIdFromUrl(): string | null {
    const m = new RegExp(`/flows/(${UUID})(?:/|$|\\?|#)`, 'i').exec(this.page.url());
    return m ? m[1] : null;
  }

  // ── list + tab strip ──────────────────────────────────────────────────────
  newButton() { return this.page.getByTestId('flows-new'); }
  previewTag() { return this.page.getByTestId('flows-preview-tag'); }
  flowRow(id: string) { return this.page.getByTestId(`flow-row-${id}`); }
  tabFlows() { return this.page.getByTestId('automations-tab-flows'); }
  tabJobs() { return this.page.getByTestId('automations-tab-jobs'); }
  tabPreview() { return this.page.getByTestId('automations-tab-preview'); }

  // ── editor shell ──────────────────────────────────────────────────────────
  root() { return this.page.getByTestId('flow-editor'); }
  tab(which: 'form' | 'document') { return this.page.getByTestId(`flow-editor-tab-${which}`); }
  saveButton() { return this.page.getByTestId('flow-editor-save'); }
  saveEnableButton() { return this.page.getByTestId('flow-editor-save-enable'); }
  savedNotice() { return this.page.getByTestId('flow-editor-saved'); }
  notFormShaped() { return this.page.getByTestId('flow-editor-not-form-shaped'); }
  enabledReadonly() { return this.page.getByTestId('flow-editor-enabled-readonly'); }
  conflict() { return this.page.getByTestId('flow-editor-conflict'); }
  reloadButton() { return this.page.getByTestId('flow-editor-reload'); }
  owner() { return this.page.getByTestId('flow-editor-owner'); }
  limits() { return this.page.getByTestId('flow-editor-limits'); }
  documentPanel() { return this.page.getByTestId('flow-editor-document'); }
  parseError() { return this.page.getByTestId('flow-editor-parse-error'); }
  issues() { return this.page.getByTestId('flow-issues'); }

  async openTab(which: 'form' | 'document') {
    await this.tab(which).click();
  }

  // ── form fields ───────────────────────────────────────────────────────────
  name() { return this.page.getByTestId('flow-form-name'); }
  description() { return this.page.getByTestId('flow-form-description'); }
  trigger(type: 'schedule' | 'event' | 'webhook' | 'manual') {
    return this.page.getByTestId(`flow-form-trigger-${type}`);
  }
  cron() { return this.page.getByTestId('flow-form-cron'); }
  timezone() { return this.page.getByTestId('flow-form-timezone'); }
  target() { return this.page.getByTestId('flow-form-target'); }
  addAction(type: 'run_script' | 'notify' | 'create_alert') {
    return this.page.getByTestId(`flow-form-add-${type}`);
  }
  actionField(i: number, field: string): Locator {
    return this.page.getByTestId(`flow-form-action-${i}-${field}`);
  }
  onFailure(which: 'stop' | 'continue' | 'notify') {
    return this.page.getByTestId(`flow-form-onfailure-${which}`);
  }

  async fillName(value: string) {
    await this.name().fill(value);
  }

  /** Select the schedule trigger and set its cron expression. */
  async setCron(cron: string) {
    await this.trigger('schedule').click();
    await this.cron().fill(cron);
  }

  /**
   * Pick the first real (non-placeholder) script in action `i`'s script select.
   * The placeholder option has an empty value. Returns the chosen script id.
   */
  async pickFirstScript(i = 0): Promise<string> {
    const select = this.actionField(i, 'script');
    await select.waitFor();
    const values = await select.locator('option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ''),
    );
    if (values.length === 0) throw new Error('no script options available in the flow action script select');
    await select.selectOption(values[0]);
    return values[0];
  }

  // ── save / enable ─────────────────────────────────────────────────────────
  async save() {
    await this.saveButton().click();
  }

  async saveAndEnable() {
    await this.saveEnableButton().click();
  }

  // ── enable dialog ─────────────────────────────────────────────────────────
  enableDialog() { return this.page.getByTestId('flow-enable-dialog'); }
  enableStep(stepId: string) { return this.page.getByTestId(`flow-enable-step-${stepId}`); }
  preApprove(stepId: string) { return this.page.getByTestId(`flow-enable-preapprove-${stepId}`); }
  maxTargets(stepId: string) { return this.page.getByTestId(`flow-enable-maxtargets-${stepId}`); }
  enableConfirm() { return this.page.getByTestId('flow-enable-confirm'); }

  // ── flow detail ───────────────────────────────────────────────────────────
  detail() { return this.page.getByTestId('flow-detail'); }
  status() { return this.page.getByTestId('flow-status'); }
  editLink() { return this.page.getByTestId('flow-edit'); }
  deleteButton() { return this.page.getByTestId('flow-delete'); }
}
