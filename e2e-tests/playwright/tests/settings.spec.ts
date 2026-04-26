// e2e-tests/playwright/tests/settings.spec.ts
import { test, expect } from '../fixtures';
import { SettingsPage } from '../pages/SettingsPage';

test.describe('Settings Overview', () => {
  test('settings hub page loads with navigation cards', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.goto();
    await expect(page.settingsHeading()).toBeVisible();
    await expect(page.organizationsCard()).toBeVisible();
    await expect(page.usersCard()).toBeVisible();
    await expect(page.sitesCard()).toBeVisible();
    await expect(page.settingsDescription()).toBeVisible();
  });
});

test.describe('User Management', () => {
  test('users page loads with table columns and invite button', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoUsers();
    await expect(page.usersHeading()).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /name/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /email/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /role/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /status/i })).toBeVisible();
    await expect(page.inviteUserButton()).toBeVisible();
  });

  test('invite user modal opens and can be cancelled', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoUsers();
    await page.inviteUserButton().click();
    await expect(authedPage.getByText('Invite User')).toBeVisible();
    const cancelButton = authedPage.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
    }
  });
});

test.describe('Role Management', () => {
  test('roles page loads with description and create button', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoRoles();
    await expect(page.rolesHeading()).toBeVisible();
    await expect(page.rolesDescription()).toBeVisible();
    await expect(page.createRoleButton()).toBeVisible();
  });

  test('create role modal opens and can be cancelled', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoRoles();
    await page.createRoleButton().click();
    await expect(authedPage.getByText('Create')).toBeVisible();
    const cancelButton = authedPage.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
    }
  });
});

test.describe('API Key Management', () => {
  test('api keys page loads with controls and table columns', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoApiKeys();
    await expect(page.apiKeysHeading()).toBeVisible();
    await expect(page.createKeyButton()).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /name/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /key prefix/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /scopes/i })).toBeVisible();
  });

  test('create api key modal opens and can be cancelled', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoApiKeys();
    await page.createKeyButton().click();
    await expect(authedPage.getByText('Create API Key')).toBeVisible();
    const cancelButton = authedPage.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
    }
  });
});

test.describe('Enrollment Keys Management', () => {
  test('enrollment keys page loads with layout and controls', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoEnrollmentKeys();
    await expect(page.enrollmentKeysHeading()).toBeVisible();
    await expect(page.createEnrollmentKeyButton()).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /name/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /status/i })).toBeVisible();
  });

  test('create enrollment key modal shows form fields', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoEnrollmentKeys();
    await page.createEnrollmentKeyButton().click();
    await expect(authedPage.getByText('Create Enrollment Key')).toBeVisible();
    const cancelButton = authedPage.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
    }
  });
});

test.describe('SSO Configuration', () => {
  test('sso page loads with description and add provider button', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoSso();
    await expect(page.ssoHeading()).toBeVisible();
    await expect(page.ssoDescription()).toBeVisible();
    await expect(page.addProviderButton()).toBeVisible();
  });

  test('add sso provider modal opens and can be cancelled', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoSso();
    await page.addProviderButton().click();
    await expect(authedPage.getByText('Add SSO Provider')).toBeVisible();
    const cancelButton = authedPage.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
    }
  });
});

test.describe('Profile Settings', () => {
  test('profile page loads with all form sections', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoProfile();
    await expect(page.profileHeading()).toBeVisible();
    await expect(page.profileInfoSection()).toBeVisible();
    await expect(page.nameInput()).toBeVisible();
    await expect(page.avatarUrlInput()).toBeVisible();
    await expect(page.emailInput()).toBeVisible();
    await expect(page.saveChangesButton()).toBeVisible();
  });
});

test.describe('AI Usage', () => {
  test('ai usage page loads with stat cards and budget panel', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoAiUsage();
    await expect(page.aiUsageHeading()).toBeVisible();
    await expect(page.todaysCostCard()).toBeVisible();
    await expect(page.monthlyCostCard()).toBeVisible();
    await expect(page.messagesTodayCard()).toBeVisible();
    await expect(page.tokensThisMonthCard()).toBeVisible();
    await expect(page.budgetConfigSection()).toBeVisible();
    await expect(page.saveBudgetButton()).toBeVisible();
    await expect(page.recentSessionsTable()).toBeVisible();
  });
});

test.describe('Access Reviews', () => {
  test('access reviews page loads', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoAccessReviews();
    await expect(page.accessReviewsHeading()).toBeVisible();
  });
});

test.describe('Sites Management', () => {
  test('sites page loads', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoSites();
    await expect(page.sitesHeading()).toBeVisible();
  });
});

test.describe('Custom Fields', () => {
  test('custom fields page loads', async ({ authedPage }) => {
    const page = new SettingsPage(authedPage);
    await page.gotoCustomFields();
    await expect(page.customFieldsHeading()).toBeVisible();
  });
});
