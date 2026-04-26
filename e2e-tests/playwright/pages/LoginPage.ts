// e2e-tests/playwright/pages/LoginPage.ts
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
  readonly url = '/login';

  // Form fields — use getByLabel for inputs that have associated <label> elements.
  // The login form renders `<label htmlFor="email">Email</label>` and
  // `<label htmlFor="password">Password</label>` so getByLabel is the right hook.
  emailInput = () => this.page.getByLabel('Email');
  passwordInput = () => this.page.getByLabel('Password');
  submitButton = () => this.page.getByRole('button', { name: /^Sign in/ });

  // Sign-in heading — the login page renders "Sign in to Breeze" as h1
  heading = () => this.page.getByRole('heading', { name: /sign in to breeze/i });

  // Error text rendered by LoginForm (API error) or LoginForm validation
  errorMessage = () => this.page.getByText(/invalid/i);

  // "Forgot password?" link inside the password label row
  forgotPasswordLink = () => this.page.getByRole('link', { name: /forgot password/i });

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async login(email: string, password: string) {
    await this.emailInput().fill(email);
    await this.passwordInput().fill(password);
    await this.submitButton().click();
  }
}
