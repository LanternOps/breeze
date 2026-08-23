import type { Page } from '@playwright/test';
import { waitForAppReady, waitForAuthOverlayClear, waitForHydration } from './hydration';

/**
 * Invoices list (`/billing/invoices`) plus the editor/detail surfaces a draft
 * passes through (`/billing/invoices/:id`).
 *
 * The list's "New invoice" dialog has two modes: `assemble` (from unbilled
 * work) and `blank` (an empty draft for an org). The multi-currency browser
 * slices use `blank` — an org-stamped draft with a hand-entered line is the
 * shortest real path from "org has a currency" to "a rendered money string".
 */
export class InvoicesPage {
  url = '/billing/invoices';

  constructor(private page: Page) {}

  root = () => this.page.getByTestId('invoices-page');
  newInvoiceButton = () => this.page.getByTestId('invoices-assemble-open');
  dialog = () => this.page.getByTestId('invoices-assemble-dialog');
  modeBlank = () => this.page.getByTestId('invoices-mode-blank');
  dialogOrg = () => this.page.getByTestId('invoices-assemble-org');
  dialogSubmit = () => this.page.getByTestId('invoices-assemble-submit');

  editor = () => this.page.getByTestId('invoice-editor');
  addModeManual = () => this.page.getByTestId('invoice-add-mode-manual');
  manualName = () => this.page.getByTestId('invoice-manual-name');
  manualQty = () => this.page.getByTestId('invoice-manual-qty');
  manualPrice = () => this.page.getByTestId('invoice-manual-price');
  addLineSubmit = () => this.page.getByTestId('invoice-add-line-submit');
  editorTotal = () => this.page.getByTestId('invoice-total');
  issueButton = () => this.page.getByTestId('invoice-issue');

  detail = () => this.page.getByTestId('invoice-detail');
  detailSummary = () => this.page.getByTestId('invoice-detail-summary');
  detailBalance = () => this.page.getByTestId('invoice-detail-balance');
  detailLines = () => this.page.getByTestId('invoice-detail-lines');

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'invoices-page');
  }

  /** Open an existing invoice by id and wait for whichever view it renders. */
  async open(invoiceId: string) {
    await this.page.goto(`/billing/invoices/${invoiceId}`);
    await this.page.locator('[data-testid="invoice-detail"], [data-testid="invoice-editor"]').first()
      .waitFor({ timeout: 30_000 });
    await waitForAuthOverlayClear(this.page);
  }

  /** Blank-draft flow: returns the new invoice's id (read off the URL). */
  async createBlankDraft(orgId: string): Promise<string> {
    await this.newInvoiceButton().click();
    await this.dialog().waitFor();
    await this.modeBlank().click();
    await this.dialogOrg().selectOption(orgId);
    await this.dialogSubmit().click();
    await this.page.waitForURL(/\/billing\/invoices\/[^/#]+$/, { timeout: 20_000 });
    await this.editor().waitFor({ timeout: 20_000 });
    await waitForHydration(this.page, 'invoice-editor');
    return new URL(this.page.url()).pathname.split('/').filter(Boolean).pop()!;
  }

  /** Add a manual line and wait for the POST /lines round trip to land. */
  async addManualLine(name: string, qty: string, unitPrice: string) {
    await this.addModeManual().click();
    await this.manualName().fill(name);
    await this.manualQty().fill(qty);
    await this.manualPrice().fill(unitPrice);
    const [lineResponse] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/invoices\/[^/]+\/lines$/.test(new URL(r.url()).pathname),
      ),
      this.addLineSubmit().click(),
    ]);
    return lineResponse;
  }

  /** Issue the draft and wait for the read-only detail view to take over. */
  async issue() {
    const [issueResponse] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/invoices\/[^/]+\/issue$/.test(new URL(r.url()).pathname),
      ),
      this.issueButton().click(),
    ]);
    await this.detail().waitFor({ timeout: 20_000 });
    return issueResponse;
  }
}
