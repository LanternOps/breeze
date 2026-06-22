import type { Page } from '@playwright/test';

export class TicketsPage {
  url = '/tickets';

  constructor(private page: Page) {}

  heading = () => this.page.getByTestId('tickets-heading');
  queue = () => this.page.getByTestId('tickets-queue');
  empty = () => this.page.getByTestId('tickets-empty');
  createButton = () => this.page.getByTestId('tickets-create-button');
  tab = (id: string) => this.page.getByTestId(`tickets-tab-${id}`);
  row = (id: string) => this.page.getByTestId(`ticket-row-${id}`);
  workbench = () => this.page.getByTestId('ticket-workbench');
  workbenchNumber = () => this.page.getByTestId('ticket-workbench-number');
  statusSelect = () => this.page.getByTestId('ticket-workbench-status');
  resolveNote = () => this.page.getByTestId('ticket-workbench-resolve-note');
  resolveSubmit = () => this.page.getByTestId('ticket-workbench-resolve-submit');
  composerInput = () => this.page.getByTestId('ticket-composer-input');
  composerInternalTab = () => this.page.getByTestId('ticket-composer-tab-internal');
  composerInternalBanner = () => this.page.getByTestId('ticket-composer-internal-banner');
  composerSend = () => this.page.getByTestId('ticket-composer-send');
  subjectEdit = () => this.page.getByTestId('ticket-workbench-subject-edit');

  // Create form
  formOrg = () => this.page.getByTestId('create-ticket-org-input');
  formSubject = () => this.page.getByTestId('create-ticket-subject-input');
  formSubmit = () => this.page.getByTestId('create-ticket-submit');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  /**
   * Edit the first comment in the feed using the inline textarea editor.
   * Clicks the edit button to open the editor, fills in the new text, then
   * clicks Save to submit.
   */
  async editFirstComment(text: string): Promise<void> {
    // Find the first edit button by matching the testid prefix.
    const editBtn = this.page.locator('[data-testid^="ticket-comment-edit-"]').first();
    await editBtn.waitFor();
    const testId = await editBtn.getAttribute('data-testid');
    const commentId = testId?.replace('ticket-comment-edit-', '') ?? '';

    await editBtn.click();

    // The inline textarea should now be visible; fill it with the new text.
    const textarea = this.page.getByTestId(`ticket-comment-edit-textarea-${commentId}`);
    await textarea.waitFor();
    await textarea.fill(text);

    // Click the Save button.
    await this.page.getByTestId(`ticket-comment-edit-save-${commentId}`).click();
  }

  /**
   * Delete the first comment in the feed using the ConfirmDialog.
   * Clicks the delete button, then clicks the confirm button in the dialog.
   */
  async deleteFirstComment(): Promise<void> {
    // Find the first delete button by matching the testid prefix.
    const deleteBtn = this.page.locator('[data-testid^="ticket-comment-delete-"]').first();
    await deleteBtn.waitFor();

    await deleteBtn.click();

    // The ConfirmDialog should appear; click the confirm button.
    const confirmBtn = this.page.getByTestId('ticket-comment-delete-confirm');
    await confirmBtn.waitFor();
    await confirmBtn.click();
  }

  /**
   * Edit the ticket subject using the inline input (ticket-workbench-subject-edit).
   * Clears the current value, fills with the new text, and presses Enter to save.
   */
  async editSubject(text: string): Promise<void> {
    const input = this.subjectEdit();
    await input.waitFor();
    await input.click({ clickCount: 3 }); // select all existing text
    await input.fill(text);
    await input.press('Enter');
  }
}
