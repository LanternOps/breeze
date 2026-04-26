// e2e-tests/playwright/tests/user-profile.spec.ts
import { test, expect } from '../fixtures';
import { UserProfilePage } from '../pages/UserProfilePage';

test.describe('User Profile — Navigation', () => {
  test('/profile redirects to /settings/profile', async ({ authedPage }) => {
    await authedPage.goto('/profile');
    await authedPage.waitForURL('**/settings/profile**');
    expect(authedPage.url()).toContain('/settings/profile');
  });
});

test.describe('User Profile — Page Structure', () => {
  test('profile settings page loads with all sections', async ({ authedPage }) => {
    const page = new UserProfilePage(authedPage);
    await page.goto();
    await expect(page.heading()).toBeVisible();
    await expect(page.profileInfoSection()).toBeVisible();
    await expect(page.nameInput()).toBeVisible();
    await expect(page.avatarUrlLabel()).toBeVisible();
    await expect(page.emailLabel()).toBeVisible();
    await expect(page.saveChangesButton()).toBeVisible();
  });

  test('change password section is present with password fields', async ({ authedPage }) => {
    const page = new UserProfilePage(authedPage);
    await page.goto();
    await expect(page.changePasswordSection()).toBeVisible();
    await expect(page.currentPasswordInput()).toHaveAttribute('type', 'password');
    await expect(page.newPasswordInput()).toHaveAttribute('type', 'password');
    await expect(page.confirmPasswordInput()).toHaveAttribute('type', 'password');
  });
});

test.describe('User Profile — Validation', () => {
  test('email field is disabled and shows cannot-be-changed note', async ({ authedPage }) => {
    const page = new UserProfilePage(authedPage);
    await page.gotoProfile();
    await expect(page.emailInput()).toBeDisabled();
    await expect(page.emailCannotBeChangedNote()).toBeVisible();
  });

  test('name field validates minimum length', async ({ authedPage }) => {
    const page = new UserProfilePage(authedPage);
    await page.gotoProfile();
    await page.nameInput().fill('X');
    await page.saveChangesButton().click();
    await expect(authedPage.getByText('Name must be at least 2 characters')).toBeVisible();
  });

  test('avatar url validates http prefix', async ({ authedPage }) => {
    const page = new UserProfilePage(authedPage);
    // Wait for avatarUrl field specifically
    await authedPage.goto('/settings/profile');
    await page.avatarUrlInput().waitFor();
    await page.avatarUrlInput().fill('ftp://invalid-protocol.com/avatar.png');
    await page.saveChangesButton().click();
    await expect(authedPage.getByText('Avatar URL must start with http')).toBeVisible();
  });

  test('change password validates mismatched passwords', async ({ authedPage }) => {
    const page = new UserProfilePage(authedPage);
    await authedPage.goto('/settings/profile');
    await page.currentPasswordInput().waitFor();
    await page.currentPasswordInput().fill('OldPassword123!');
    await page.newPasswordInput().fill('NewPassword123!');
    await page.confirmPasswordInput().fill('TotallyDifferent456!');
    await page.changePasswordButton().click();
    await expect(authedPage.getByText('Passwords do not match')).toBeVisible();
  });
});

test.describe('Setup Wizard', () => {
  test('unauthenticated access to /setup redirects to login', async ({ cleanPage }) => {
    await cleanPage.goto('/setup');
    await cleanPage.waitForURL('**/login**');
    expect(cleanPage.url()).toContain('/login');
  });
});
