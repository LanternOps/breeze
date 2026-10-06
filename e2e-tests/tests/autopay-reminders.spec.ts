import { test, expect } from '../fixtures';

test('reminder settings save and reload on the Payments tab', async ({ authedPage: page }) => {
  await page.goto('/settings/billing#payments');
  const before = page.getByTestId('autopay-reminders-before');
  const enabled = page.getByTestId('autopay-reminders-enabled');
  await expect(page.getByTestId('autopay-reminders-section')).toBeVisible();
  const originalBefore = await before.inputValue();
  const originalEnabled = await enabled.inputValue();
  try {
    await enabled.selectOption('false');
    await before.fill('5');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/partner/billing/payment-settings')
      && response.request().method() === 'PUT');
    await page.getByTestId('autopay-settings-save').click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(before).toHaveValue('5');
    await expect(enabled).toHaveValue('false');
  } finally {
    await before.fill(originalBefore);
    await enabled.selectOption(originalEnabled);
    const restored = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/partner/billing/payment-settings')
      && response.request().method() === 'PUT');
    await page.getByTestId('autopay-settings-save').click();
    expect((await restored).ok()).toBe(true);
  }
});
