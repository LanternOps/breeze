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
   * Edit the first comment in the feed. The web UI uses window.prompt() for
   * the edit dialog, so we register the dialog handler BEFORE clicking the
   * edit button. The handler is one-shot (once: true) and calls d.accept(text)
   * to confirm the prompt with the new content.
   */
  async editFirstComment(text: string): Promise<void> {
    // Find the first edit button by matching the testid prefix.
    const editBtn = this.page.locator('[data-testid^="ticket-comment-edit-"]').first();
    await editBtn.waitFor();

    // Register the prompt handler before clicking (native dialogs fire
    // synchronously in some browsers; registering first prevents a race).
    const dialogHandler = (dialog: import('@playwright/test').Dialog) => {
      void dialog.accept(text);
    };
    this.page.once('dialog', dialogHandler);

    await editBtn.click();
  }

  /**
   * Delete the first comment in the feed. The web UI uses window.confirm() for
   * the delete confirmation, so we register the dialog handler BEFORE clicking
   * the delete button. The handler calls d.accept() to confirm the deletion.
   */
  async deleteFirstComment(): Promise<void> {
    // Find the first delete button by matching the testid prefix.
    const deleteBtn = this.page.locator('[data-testid^="ticket-comment-delete-"]').first();
    await deleteBtn.waitFor();

    // Register the confirm handler before clicking.
    const dialogHandler = (dialog: import('@playwright/test').Dialog) => {
      void dialog.accept();
    };
    this.page.once('dialog', dialogHandler);

    await deleteBtn.click();
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
