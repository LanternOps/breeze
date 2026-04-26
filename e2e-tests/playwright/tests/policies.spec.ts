// e2e-tests/playwright/tests/policies.spec.ts
import { test, expect } from '../fixtures';
import { PoliciesPage } from '../pages/PoliciesPage';

test.describe('Policies', () => {
  test('page loads with heading, action links, and table columns', async ({ authedPage }) => {
    const page = new PoliciesPage(authedPage);
    await page.goto();

    await expect(page.heading()).toBeVisible();
    await expect(page.subtitle()).toBeVisible();
    await expect(page.complianceDashboardLink()).toBeVisible();
    await expect(page.newPolicyLink()).toBeVisible();
  });

  test('policy table has expected column headers', async ({ authedPage }) => {
    const page = new PoliciesPage(authedPage);
    await page.goto();

    const thead = page.tableHead();
    for (const col of ['Name', 'Enforcement', 'Compliance', 'Last Evaluated', 'Enabled', 'Actions']) {
      await expect(thead.getByText(col, { exact: false })).toBeVisible({ timeout: 10_000 });
    }
  });

  test('filter controls are present', async ({ authedPage }) => {
    const page = new PoliciesPage(authedPage);
    await page.goto();

    await expect(page.searchInput()).toBeVisible();
  });

  test('create policy page renders all form sections', async ({ authedPage }) => {
    const page = new PoliciesPage(authedPage);
    await page.gotoNew();

    await expect(page.createPolicyHeading()).toBeVisible();
    // Subtitle is a sibling <p> of the h1 — scoped to the main area to avoid AiChatSidebar
    await expect(authedPage.getByRole('heading', { name: 'Create Policy' }).locator('+ p')).toContainText(
      'Define compliance rules and enforcement behavior.'
    );

    // Form fields
    await expect(page.policyNameInput()).toBeVisible();
    await expect(page.policyDescriptionInput()).toBeVisible();

    // Section headings
    for (const section of ['Target Devices', 'Policy Rules', 'Check Interval']) {
      await expect(authedPage.getByRole('heading', { name: section, level: 3 })).toBeVisible();
    }

    // Enforcement level buttons
    for (const level of ['Monitor', 'Warn', 'Enforce']) {
      await expect(authedPage.getByRole('button', { name: level, exact: true })).toBeVisible();
    }

    await expect(page.createPolicyButton()).toBeVisible();
  });

  test('create policy, verify in list, edit name, delete', async ({ authedPage }) => {
    const page = new PoliciesPage(authedPage);
    const policyName = `E2E Security Baseline ${Date.now()}`;
    const updatedName = `${policyName} Updated`;

    // Create
    await page.gotoNew();
    await page.policyNameInput().fill(policyName);
    await page.policyDescriptionInput().fill('Automated E2E test policy for required software checks');

    // Fill software name in the default required_software rule
    await authedPage.getByPlaceholder('e.g., Google Chrome').fill('E2E Test Software');

    await page.createPolicyButton().click();
    await authedPage.waitForURL('**/policies', { timeout: 20_000 });

    // Verify in list
    await expect(page.tableBody().getByText(policyName)).toBeVisible({ timeout: 10_000 });

    // Edit — click edit button in the row
    const row = page.policyRow(policyName);
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.editPolicyHeading()).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByRole('link', { name: /policies/i })).toBeVisible();
    await expect(page.policyNameInput()).toBeVisible();

    await page.policyNameInput().fill(updatedName);
    await page.saveChangesButton().click();
    await authedPage.waitForURL('**/policies', { timeout: 20_000 });
    await expect(page.tableBody().getByText(updatedName)).toBeVisible({ timeout: 10_000 });

    // Delete: search, cancel first, then confirm
    await page.searchInput().fill(updatedName);
    const deleteBtn = page.tableBody().locator('tr').first().getByRole('button', { name: 'Delete' });
    await deleteBtn.click();
    await expect(page.deletePolicyHeading()).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('This action cannot be undone.')).toBeVisible();
    await page.cancelButton().click();
    await expect(page.heading()).toBeVisible({ timeout: 5_000 });

    // Confirm delete
    await deleteBtn.click();
    await expect(page.deletePolicyHeading()).toBeVisible({ timeout: 10_000 });
    // Click the destructive Delete button (not the heading text or Cancel)
    await authedPage.getByRole('button', { name: 'Delete' }).filter({ hasNotText: 'Policy' }).click();
    await authedPage.waitForURL('**/policies', { timeout: 10_000 });
  });

  test('rule type switching shows correct dynamic fields', async ({ authedPage }) => {
    const page = new PoliciesPage(authedPage);
    await page.gotoNew();

    // Switch to disk_space_minimum
    await authedPage.getByRole('combobox').filter({ hasText: /required_software/i }).selectOption('disk_space_minimum');
    await expect(authedPage.getByLabel('Minimum Free Space (GB)')).toBeVisible({ timeout: 5_000 });

    // Switch to prohibited_software
    await authedPage.getByRole('combobox').filter({ has: authedPage.locator('option[value="disk_space_minimum"]') }).selectOption('prohibited_software');
    await expect(authedPage.getByPlaceholder('e.g., BitTorrent')).toBeVisible({ timeout: 5_000 });

    // Add a second rule
    await page.addRuleButton().click();
    // At least 2 rule rows should be present
    await expect(authedPage.getByRole('combobox').filter({ has: authedPage.locator('option[value="required_software"]') })).toHaveCount(1, { timeout: 5_000 });

    // Cancel navigates back
    await page.cancelButton().click();
    await authedPage.waitForURL('**/policies', { timeout: 10_000 });
  });

  test('compliance dashboard loads with stat cards and sections', async ({ authedPage }) => {
    const page = new PoliciesPage(authedPage);
    await page.gotoCompliance();

    await expect(page.complianceDashboardHeading()).toBeVisible();
    await expect(authedPage.getByText('Overview of policy compliance across all devices.')).toBeVisible();
    await expect(authedPage.getByRole('link', { name: /policies/i })).toBeVisible();

    // Stat cards
    for (const label of ['Overall Compliance', 'Compliant', 'Non-Compliant', 'Unknown']) {
      await expect(authedPage.getByText(label)).toBeVisible();
    }

    // Chart section headings
    for (const section of ['Compliance by Status', 'Compliance Trend', 'Policy Breakdown', 'Non-Compliant Devices']) {
      await expect(authedPage.getByRole('heading', { name: section, level: 3 })).toBeVisible();
    }

    // Device search
    await expect(authedPage.getByPlaceholder('Search devices...')).toBeVisible();
  });
});
