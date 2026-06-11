import type { Page } from '@playwright/test';

export class AuthPage {
  url = '/auth';

  constructor(private page: Page) {}

  page_ = () => this.page.getByTestId('auth-page');
  tabSignin = () => this.page.getByTestId('tab-signin');
  tabSignup = () => this.page.getByTestId('tab-signup');

  // Sign-in tab embeds LoginPage, which uses the existing login-* testids.
  emailInput = () => this.page.getByTestId('login-email-input');
  passwordInput = () => this.page.getByTestId('login-password-input');
  submitButton = () => this.page.getByTestId('login-submit');

  async goto(next?: string) {
    const target = next ? `${this.url}?next=${encodeURIComponent(next)}` : this.url;
    await this.page.goto(target);
    await this.page_().waitFor();
    await this.page.locator('form[data-hydrated="true"]').waitFor({ timeout: 30_000 });
  }

  async clickSignupTab() {
    await this.tabSignup().click();
  }

  async clickSigninTab() {
    await this.tabSignin().click();
  }

  async signIn(email: string, password: string, expectedUrl: string | RegExp) {
    await this.emailInput().fill(email);
    await this.passwordInput().fill(password);
    await this.submitButton().click();
    await this.page.waitForURL(expectedUrl, { timeout: 30_000 });
  }
}
