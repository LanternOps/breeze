// e2e-tests/playwright/tests/automations.spec.ts
import { test, expect } from '../fixtures';
import { AutomationsPage } from '../pages/AutomationsPage';

test.describe('Automations', () => {
  test('page loads with heading, subtitle, and New Automation link', async ({ authedPage }) => {
    const page = new AutomationsPage(authedPage);
    await page.goto();

    await expect(page.heading()).toBeVisible();
    await expect(page.subtitle()).toBeVisible();
    await expect(page.newAutomationLink()).toBeVisible();
  });

  test('automations table has expected column headers', async ({ authedPage }) => {
    const page = new AutomationsPage(authedPage);
    await page.goto();

    for (const col of ['Name', 'Trigger', 'Last Run', 'Status', 'Enabled', 'Actions']) {
      await expect(page.tableColumnHeader(col)).toBeVisible();
    }
  });

  test('filter controls are present', async ({ authedPage }) => {
    const page = new AutomationsPage(authedPage);
    await page.goto();

    await expect(page.searchInput()).toBeVisible();
  });

  test('create automation page renders with form fields', async ({ authedPage }) => {
    const page = new AutomationsPage(authedPage);
    await page.gotoNew();

    await expect(page.createAutomationHeading()).toBeVisible();
    await expect(authedPage.getByText('Build an automated workflow with triggers, conditions, and actions.')).toBeVisible();
    await expect(authedPage.getByRole('link', { name: /automations/i })).toBeVisible();
    await expect(page.automationNameInput()).toBeVisible();
    await expect(page.automationDescriptionInput()).toBeVisible();
    await expect(page.createAutomationButton()).toBeVisible();
  });

  test('create manual automation, verify in list, edit description, delete', async ({ authedPage }) => {
    const page = new AutomationsPage(authedPage);
    const automationName = `E2E Manual Automation ${Date.now()}`;

    // Create
    await page.gotoNew();
    await page.automationNameInput().fill(automationName);
    await page.automationDescriptionInput().fill('Manually triggered automation created by E2E test');

    // Select Manual trigger card
    await authedPage.getByRole('button', { name: /Manual/i }).filter({ hasText: /Run manually only/i }).click();
    await expect(authedPage.getByText('This automation will only run when triggered manually', { exact: false })).toBeVisible({ timeout: 5_000 });

    await page.createAutomationButton().click();
    await authedPage.waitForURL('**/automations', { timeout: 20_000 });

    // Verify in list
    await expect(authedPage.getByRole('cell', { name: automationName })).toBeVisible({ timeout: 10_000 });
    // Trigger badge
    await expect(page.automationRow(automationName).getByText('Manual')).toBeVisible();

    // Edit
    await page.editButton(automationName).click();
    await expect(page.editAutomationHeading()).toBeVisible({ timeout: 15_000 });
    await page.automationDescriptionInput().fill('Updated description via E2E edit test');
    await page.saveChangesButton().click();
    await authedPage.waitForURL('**/automations', { timeout: 20_000 });
    await expect(authedPage.getByRole('cell', { name: automationName })).toBeVisible({ timeout: 10_000 });

    // Delete via more-menu pattern
    // Find the more-menu trigger button in the row (MoreHorizontal icon)
    const row = page.automationRow(automationName);
    // The more-menu button is the last button in the actions cell
    await row.getByRole('button').last().click();
    await authedPage.getByRole('button', { name: 'Delete' }).first().click();
    await expect(page.deleteAutomationHeading()).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('Are you sure you want to delete')).toBeVisible();
    await page.deleteConfirmButton().click();
    await expect(authedPage.getByRole('cell', { name: automationName })).not.toBeVisible({ timeout: 10_000 });
  });

  test('create scheduled automation with cron expression, verify schedule badge', async ({ authedPage }) => {
    const page = new AutomationsPage(authedPage);
    const automationName = `E2E Scheduled Automation ${Date.now()}`;

    await page.gotoNew();
    await page.automationNameInput().fill(automationName);
    await page.automationDescriptionInput().fill('Runs on cron schedule - E2E test');

    // Select Schedule trigger card
    await authedPage.getByRole('button', { name: /Schedule/i }).filter({ hasText: /Run on a cron schedule/i }).click();
    await expect(authedPage.getByLabel('Cron Expression')).toBeVisible({ timeout: 5_000 });

    // Set cron
    await page.cronExpressionInput().fill('0 9 * * *');
    await expect(authedPage.getByText('Every day at 9:00 AM')).toBeVisible({ timeout: 5_000 });

    // Preset button
    await authedPage.getByRole('button', { name: 'Weekdays 9 AM' }).click();
    await expect(authedPage.getByText('Weekdays at 9:00 AM')).toBeVisible({ timeout: 5_000 });
    await expect(page.cronExpressionInput()).toHaveValue('0 9 * * 1-5');

    await page.createAutomationButton().click();
    await authedPage.waitForURL('**/automations', { timeout: 20_000 });

    await expect(authedPage.getByRole('cell', { name: automationName })).toBeVisible({ timeout: 10_000 });
    await expect(page.automationRow(automationName).getByText('Schedule')).toBeVisible();

    // Cleanup
    const row = page.automationRow(automationName);
    await row.getByRole('button').last().click();
    await authedPage.getByRole('button', { name: 'Delete' }).first().click();
    await expect(page.deleteAutomationHeading()).toBeVisible({ timeout: 10_000 });
    await page.deleteConfirmButton().click();
    await expect(authedPage.getByRole('cell', { name: automationName })).not.toBeVisible({ timeout: 10_000 });
  });

  test('toggle automation enabled/disabled', async ({ authedPage }) => {
    const page = new AutomationsPage(authedPage);
    const automationName = `E2E Toggle Automation ${Date.now()}`;

    // Create automation first
    await page.gotoNew();
    await page.automationNameInput().fill(automationName);
    await page.automationDescriptionInput().fill('Toggle test automation');
    await authedPage.getByRole('button', { name: /Manual/i }).filter({ hasText: /Run manually only/i }).click();
    await page.createAutomationButton().click();
    await authedPage.waitForURL('**/automations', { timeout: 20_000 });
    await expect(authedPage.getByRole('cell', { name: automationName })).toBeVisible({ timeout: 10_000 });

    // Toggle the checkbox for this automation
    const checkbox = page.toggleCheckbox(automationName);
    const initialChecked = await checkbox.isChecked();
    await checkbox.click();
    // After toggle, the checked state should differ
    await expect(checkbox).not.toHaveJSProperty('checked', initialChecked, { timeout: 5_000 });

    // Cleanup
    const row = page.automationRow(automationName);
    await row.getByRole('button').last().click();
    await authedPage.getByRole('button', { name: 'Delete' }).first().click();
    await expect(page.deleteAutomationHeading()).toBeVisible({ timeout: 10_000 });
    await page.deleteConfirmButton().click();
    await expect(authedPage.getByRole('cell', { name: automationName })).not.toBeVisible({ timeout: 10_000 });
  });
});
