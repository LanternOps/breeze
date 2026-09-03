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
  reportsNav = () => this.page.getByTestId('portal-nav-reports');
  devicesNav = () => this.page.getByTestId('portal-nav-devices');

  async login(email: string, password: string): Promise<void> {
    await this.page.goto('/portal/login');
    await this.email().fill(email);
    await this.password().fill(password);
    await this.submit().click();
    await this.page.waitForURL('**/quotes');
  }
}
