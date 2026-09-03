import type { Page } from '@playwright/test';

export class PortalVisibilityPage {
  constructor(private page: Page) {}

  email = () => this.page.getByTestId('portal-login-email');
  password = () => this.page.getByTestId('portal-login-password');
  submit = () => this.page.getByTestId('portal-login-submit');
  generatePosture = () =>
    this.page.getByTestId('portal-reports-generate-posture');
  reportRows = () =>
    this.page.getByTestId(/^portal-report-run-row-/);
  dashboardNav = () => this.page.getByTestId('portal-nav-dashboard');
  reportsNav = () => this.page.getByTestId('portal-nav-reports');
  devicesNav = () => this.page.getByTestId('portal-nav-devices');
  dashboardTiles = () =>
    this.page.getByTestId(/^portal-dashboard-tile-/);
  dashboardSecurity = () =>
    this.page.getByTestId('portal-dashboard-tile-security');

  /**
   * Lands on /quotes, not /dashboard: pages/index.astro redirects an
   * authenticated customer to '/quotes' unconditionally, and enabling the
   * dashboard adds a nav entry without changing that landing. Asserting
   * '**\/dashboard' here would fail against the shipped app.
   */
  async login(email: string, password: string): Promise<void> {
    await this.page.goto('/portal/login');
    await this.email().fill(email);
    await this.password().fill(password);
    await this.submit().click();
    await this.page.waitForURL('**/quotes');
  }
}
