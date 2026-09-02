import { expect, type Page } from '@playwright/test';
import { waitForAppReady, waitForAuthOverlayClear, waitForHydration } from './hydration';

/**
 * Quotes list (`/billing/quotes`) plus the quote workspace/editor
 * (`/billing/quotes/:id`).
 *
 * Only the pieces the multi-currency browser slice needs: create a quote for an
 * org, put one manual pricing line on it, send it, and recover the public
 * acceptance token from the send response (the admin UI never surfaces the
 * link). The richer template/contract-block flow lives in
 * `tests/quote-contract-proposal.spec.ts`.
 */
export class QuotesPage {
  url = '/billing/quotes';

  constructor(private page: Page) {}

  root = () => this.page.getByTestId('quotes-page');
  createOpen = () => this.page.getByTestId('quotes-create-open');
  createDialog = () => this.page.getByTestId('quotes-create-dialog');
  createOrg = () => this.page.getByTestId('quotes-create-org');
  createTitle = () => this.page.getByTestId('quotes-create-title');
  createSubmit = () => this.page.getByTestId('quotes-create-submit');

  editor = () => this.page.getByTestId('quote-editor');
  addBlockLineItems = () => this.page.getByTestId('quote-add-block-type-line_items');
  addBlockSubmit = () => this.page.getByTestId('quote-add-block-submit');
  totalGrand = () => this.page.getByTestId('quote-total-grand');
  totalOneTime = () => this.page.getByTestId('quote-total-onetime');

  sendButton = () => this.page.getByTestId('quote-send');
  sendConfirm = () => this.page.getByTestId('quote-send-confirm');
  sendNow = () => this.page.getByTestId('quote-send-now');

  detail = () => this.page.getByTestId('quote-detail');
  detailStatus = () => this.page.getByTestId('quote-detail-status');
  detailTotals = () => this.page.getByTestId('quote-detail-totals');

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'quotes-page');
  }

  /** Create a quote for `orgId` and land in its editor; returns the quote id. */
  async create(orgId: string, title: string): Promise<string> {
    await this.createOpen().click();
    await this.createDialog().waitFor();
    await this.createOrg().selectOption(orgId);
    await this.createTitle().fill(title);
    await this.createSubmit().click();
    await this.page.waitForURL(/\/billing\/quotes\/[^/#]+$/, { timeout: 20_000 });
    await this.editor().waitFor({ timeout: 20_000 });
    await waitForHydration(this.page, 'quote-editor');
    return new URL(this.page.url()).pathname.split('/').filter(Boolean).pop()!;
  }

  /**
   * Add a pricing-table block and one one-time manual line to it. Returns the
   * block id (the add-line form's testid suffix).
   */
  async addManualPricingLine(name: string, unitPrice: string): Promise<string> {
    await this.addBlockLineItems().click();
    await this.addBlockSubmit().click();
    // The pricing block renders an inline quick-add row; the full add-line form
    // (catalog / manual / distributor modes) is behind its "More details"
    // toggle, so open that first and take the block id off the toggle itself.
    const toggle = this.page.locator('[data-testid^="quote-block-add-line-toggle-"]');
    await toggle.waitFor({ timeout: 20_000 });
    const blockId = (await toggle.getAttribute('data-testid'))!.replace('quote-block-add-line-toggle-', '');
    await toggle.click();
    await this.page.getByTestId(`quote-block-add-line-${blockId}`).waitFor({ timeout: 15_000 });

    await this.page.getByTestId(`quote-line-mode-${blockId}-manual`).click();
    const nameInput = this.page.getByTestId(`quote-manual-name-${blockId}`);
    await nameInput.fill(name);
    await this.page.getByTestId(`quote-manual-price-${blockId}`).fill(unitPrice);
    await this.page.getByTestId(`quote-manual-add-${blockId}`).click();
    // The manual-line form resets its name field only after a successful add —
    // an emptied input is the completion signal, not mere presence.
    await expect(nameInput).toHaveValue('', { timeout: 15_000 });
    return blockId;
  }

  /**
   * Send the quote and return the real send response.
   *
   * The composer's confirm button does NOT email — it SCHEDULES the dispatch
   * ~30s out (the undo-send window) and the quote stays a draft. Rather than
   * sit out the window, use the composer session's own "Send now" control,
   * which cancels the scheduled job and dispatches immediately; that request is
   * the POST /quotes/:id/send carrying `acceptUrl`.
   */
  async send(): Promise<{ quoteNumber: string | null; acceptUrl: string }> {
    await this.sendButton().click();
    await this.sendConfirm().waitFor();
    const [scheduleResponse] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/quotes\/[^/]+\/schedule-send$/.test(new URL(r.url()).pathname),
      ),
      this.sendConfirm().click(),
    ]);
    expect(scheduleResponse.ok(), 'schedule-send').toBeTruthy();

    await this.sendNow().waitFor({ timeout: 20_000 });
    const [sendResponse] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/quotes\/[^/]+\/send$/.test(new URL(r.url()).pathname),
        { timeout: 30_000 },
      ),
      this.sendNow().click(),
    ]);
    expect(sendResponse.ok(), 'send').toBeTruthy();
    const body = (await sendResponse.json()) as {
      data: { quote: { quoteNumber: string | null }; acceptUrl: string };
    };
    return { quoteNumber: body.data.quote.quoteNumber, acceptUrl: body.data.acceptUrl };
  }

  /**
   * Open an existing quote. QuoteWorkspace renders the EDITOR for a draft and
   * the read-only DETAIL view once the quote leaves draft, and it has no shared
   * root testid — wait for whichever of the two this quote's status produces.
   */
  async open(quoteId: string) {
    await this.page.goto(`/billing/quotes/${quoteId}`);
    await this.page.locator('[data-testid="quote-detail"], [data-testid="quote-editor"]').first()
      .waitFor({ timeout: 30_000 });
    await waitForAuthOverlayClear(this.page);
  }
}
