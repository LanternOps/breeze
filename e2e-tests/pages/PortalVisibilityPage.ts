import type { Page } from '@playwright/test';
import { waitForHydration } from './hydration';

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
   * The post-login landing is decided by the portal middleware
   * (`authenticatedLanding` → `lib/landing.ts`): '/dashboard' when the org's
   * `enable_dashboard` flag is on, '/quotes' otherwise. The seeded org enables
   * the dashboard, but accept either so the page object does not encode the
   * seed. Dev-mode Astro compiles the landing page on first hit, hence the
   * generous timeout.
   */
  async login(email: string, password: string): Promise<void> {
    await this.page.goto('/portal/login');
    // The login form is a `client:load` island: a fill that lands before React
    // attaches is discarded by hydration and the submit never posts (seen as
    // an empty form still on /login after the full navigation timeout).
    await waitForHydration(this.page, 'portal-login-submit');
    await this.email().fill(email);
    await this.password().fill(password);
    await this.submit().click();
    await this.page.waitForURL(/\/portal\/(dashboard|quotes)(?:[?#]|$)/, {
      timeout: 60_000,
    });
  }
}
