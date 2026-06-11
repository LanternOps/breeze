import { test, expect } from '../fixtures';
import { LoginPage } from '../pages/LoginPage';

test.describe('Login', () => {
  test('login page renders with form fields', async ({ cleanPage }) => {
    const login = new LoginPage(cleanPage);
    await login.goto();
    await expect(login.page_()).toBeVisible();
    await expect(login.heading()).toBeVisible();
    await expect(login.emailInput()).toBeVisible();
    await expect(login.passwordInput()).toBeVisible();
    await expect(login.submitButton()).toBeVisible();
  });

  test('valid credentials redirect to dashboard', async ({ cleanPage }) => {
    const login = new LoginPage(cleanPage);
    await login.goto();
    await login.login(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
    expect(cleanPage.url()).toMatch(/\/$|\/setup/);
  });

  test('client-side validation rejects empty submit', async ({ cleanPage }) => {
    const login = new LoginPage(cleanPage);
    await login.goto();
    await login.submitButton().click();
    await expect(login.emailError()).toBeVisible();
    await expect(login.passwordError()).toBeVisible();
  });
});
