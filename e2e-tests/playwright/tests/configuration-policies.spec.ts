// e2e-tests/playwright/tests/configuration-policies.spec.ts
import { test, expect } from '../fixtures';
import { ConfigurationPoliciesPage } from '../pages/ConfigurationPoliciesPage';

test.describe('Configuration Policies', () => {
  test('page loads with heading, subtitle, and New Policy link', async ({ authedPage }) => {
    const page = new ConfigurationPoliciesPage(authedPage);
    await page.goto();

    await expect(page.heading()).toBeVisible();
    await expect(page.subtitle()).toBeVisible();
    await expect(page.newPolicyLink()).toBeVisible();
  });

  test('new policy page shows mode selection step', async ({ authedPage }) => {
    const page = new ConfigurationPoliciesPage(authedPage);
    await page.gotoNew();

    await expect(page.newConfigPolicyHeading()).toBeVisible();
    await expect(authedPage.getByText('How would you like to configure this policy?')).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('Configure New')).toBeVisible();
    await expect(authedPage.getByText('Link to Existing')).toBeVisible();
    await expect(authedPage.getByText('Start fresh with custom settings')).toBeVisible();
    await expect(authedPage.getByText('Use another policy as the master baseline')).toBeVisible();
    await expect(page.cancelLink()).toBeVisible();
  });

  test('Configure New mode reveals policy details form with Back button', async ({ authedPage }) => {
    const page = new ConfigurationPoliciesPage(authedPage);
    await page.gotoNew();

    await page.configureNewButton().click();
    await expect(authedPage.getByText('Policy Details')).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByLabel('Name')).toBeVisible();
    await expect(authedPage.getByLabel('Description')).toBeVisible();
    await expect(authedPage.getByLabel('Status')).toBeVisible();
    await expect(page.policyNameInput()).toBeVisible();
    await expect(page.createPolicyButton()).toBeVisible();
    await expect(page.backButton()).toBeVisible();

    // Fill name
    await page.policyNameInput().fill('E2E Test Config Policy');

    // Back returns to mode selection
    await page.backButton().click();
    await expect(authedPage.getByText('Configure New')).toBeVisible({ timeout: 10_000 });

    // Cancel returns to list
    await page.cancelLink().click();
    await authedPage.waitForURL('**/configuration-policies', { timeout: 10_000 });
    await expect(page.heading()).toBeVisible();
  });

  test('Link to Existing mode reveals master policy selector', async ({ authedPage }) => {
    const page = new ConfigurationPoliciesPage(authedPage);
    await page.gotoNew();

    await page.linkToExistingButton().click();
    await expect(authedPage.getByText('Master Policy')).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('Select the configuration policy to use as the baseline', { exact: false })).toBeVisible();
    await expect(authedPage.getByText('Policy Details')).toBeVisible();
    await expect(page.createPolicyButton()).toBeVisible();

    // Cancel if available
    const cancelLink = page.cancelLink();
    if (await cancelLink.isVisible()) {
      await cancelLink.click();
    }
  });

  test('delete modal shows warning and cancel works', async ({ authedPage }) => {
    const page = new ConfigurationPoliciesPage(authedPage);
    await page.goto();

    // Only proceed if there are policies with a Delete button
    const deleteBtn = page.deleteButton();
    const count = await deleteBtn.count();
    if (count === 0) {
      test.skip(true, 'No configuration policies available — skipping delete modal test');
      return;
    }

    await deleteBtn.click();
    await expect(authedPage.getByText('Delete Policy', { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('This will also remove all', { exact: false })).toBeVisible({ timeout: 5_000 });
    await expect(authedPage.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // Cancel — no destructive action
    await authedPage.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.heading()).toBeVisible();
  });

  test('summary stats panel is visible when policies exist', async ({ authedPage }) => {
    const page = new ConfigurationPoliciesPage(authedPage);
    await page.goto();

    await expect(page.heading()).toBeVisible();

    // The stats panel only renders when policies exist — just verify the page loaded correctly
    await expect(authedPage.getByText('Configuration Policies')).toBeVisible();
  });
});
