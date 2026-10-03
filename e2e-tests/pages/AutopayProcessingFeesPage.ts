import { BasePage } from './BasePage';

export class AutopayProcessingFeesPage extends BasePage {
  readonly cardFee = this.page.getByTestId('autopay-card-fee-bps');
  readonly achFee = this.page.getByTestId('autopay-ach-fee');
  readonly notified = this.page.getByTestId('autopay-attest-notified');
  readonly cost = this.page.getByTestId('autopay-attest-cost');
  readonly save = this.page.getByTestId('autopay-settings-save');

  async goto() {
    await this.page.goto('/settings/billing#payments');
  }
}
