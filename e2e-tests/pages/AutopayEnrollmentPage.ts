import { BasePage } from './BasePage';
export class AutopayEnrollmentPage extends BasePage {
  unasked = () => this.page.getByTestId('autopay-unasked');
  sendNow = () => this.page.getByTestId('autopay-send-now');
  bulkResult = () => this.page.getByTestId('autopay-bulk-result');
  bank = () => this.page.getByTestId('autopay-method-us_bank_account');
  card = () => this.page.getByTestId('autopay-method-card');
  bankFee = () => this.page.getByTestId('autopay-fee-us_bank_account');
  consent = () => this.page.getByTestId('autopay-consent');
  continueSetup = () => this.page.getByTestId('autopay-setup-submit');
  stopConfirm = () => this.page.getByTestId('autopay-stop-confirm');
  stop = () => this.page.getByTestId('autopay-stop-submit');
  feedback = () => this.page.getByTestId('autopay-feedback');
  settings = () => this.page.getByTestId('autopay-settings-section');
  offset = () => this.page.getByTestId('autopay-offset-days');
  async openList() { await this.page.goto('/billing/autopay'); await this.page.getByTestId('autopay-list').waitFor(); }
  async openSetup() { await this.page.goto('/portal/autopay/test-token'); await this.consent().waitFor(); }
  async openStop() { await this.page.goto('/portal/autopay/stop-token/stop'); await this.stopConfirm().waitFor(); }
  async openPayments() { await this.page.goto('/settings/billing#payments'); await this.settings().waitFor(); }
}
