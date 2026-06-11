import type { Page } from '@playwright/test';

export class LoginPage {
  url = '/login';

  constructor(private page: Page) {}

  page_ = () => this.page.getByTestId('login-page');
  heading = () => this.page.getByTestId('login-heading');
  emailInput = () => this.page.getByTestId('login-email-input');
  passwordInput = () => this.page.getByTestId('login-password-input');
  submitButton = () => this.page.getByTestId('login-submit');
  errorBanner = () => this.page.getByTestId('login-error');
  emailError = () => this.page.getByTestId('login-email-error');
  passwordError = () => this.page.getByTestId('login-password-error');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async login(email: string, password: string) {
    await this.emailInput().fill(email);
    await this.passwordInput().fill(password);
    await this.submitButton().click();
    await this.page.waitForURL('/', { timeout: 30_000 });
  }
}
