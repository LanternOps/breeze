import type { Page } from '@playwright/test';
import { waitForAppReady } from './hydration';

/**
 * Organization → Billing settings (`/settings/organizations/:id/billing`).
 *
 * Multi-currency wave 6 (#3778): selecting a different code NEVER mutates — it
 * opens an advisory pre-flight panel (per-stamped-currency counts, the
 * configuration warnings, the spec §7 recovery line, the retention copy) and
 * only the explicit confirmation sends the currency-only PATCH.
 */
export class OrgBillingSettingsPage {
  constructor(private page: Page) {}

  url = (orgId: string) => `/settings/organizations/${orgId}/billing`;

  root = () => this.page.getByTestId('org-billing-settings');
  currencySelect = () => this.page.getByTestId('org-billing-currency');
  panel = () => this.page.getByTestId('org-billing-currency-panel');
  group = (code: string) => this.page.getByTestId(`org-billing-currency-group-${code}`);
  impactCount = (code: string, key: string) => this.page.getByTestId(`org-billing-impact-${code}-${key}`);
  recovery = (code: string) => this.page.getByTestId(`org-billing-currency-recovery-${code}`);
  warningRate = () => this.page.getByTestId('org-billing-currency-warning-rate');
  retention = () => this.page.getByTestId('org-billing-currency-retention');
  advisory = () => this.page.getByTestId('org-billing-currency-advisory');
  loading = () => this.page.getByTestId('org-billing-currency-loading');
  confirm = () => this.page.getByTestId('org-billing-currency-confirm');
  cancel = () => this.page.getByTestId('org-billing-currency-cancel');

  async goto(orgId: string) {
    await this.page.goto(this.url(orgId));
    await waitForAppReady(this.page, 'org-billing-settings');
  }

  /** Pick a code and wait for the advisory impact GET to land. Never mutates. */
  async selectCurrency(code: string) {
    const [impactResponse] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'GET' && /\/billing-settings\/currency-impact/.test(r.url()),
      ),
      this.currencySelect().selectOption(code),
    ]);
    await this.panel().waitFor();
    return impactResponse;
  }

  /** Confirm the change and return the PATCH response. */
  async confirmChange() {
    const [patchResponse] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && /\/billing-settings$/.test(new URL(r.url()).pathname),
      ),
      this.confirm().click(),
    ]);
    return patchResponse;
  }
}
