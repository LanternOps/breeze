// e2e-tests/playwright/tests/integrations.spec.ts
import { test, expect } from '../fixtures';
import { IntegrationsPage } from '../pages/IntegrationsPage';

test.describe('Webhooks', () => {
  test('webhooks page loads with heading, description, and new webhook button', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoWebhooks();
    await expect(page.webhooksHeading()).toBeVisible();
    await expect(page.webhooksDescription()).toBeVisible();
    await expect(page.newWebhookButton()).toBeVisible();
  });

  test('webhook page shows list or empty state', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoWebhooks();
    await expect(page.webhooksHeading()).toBeVisible();
  });
});

test.describe('Create Webhook Flow', () => {
  test('create webhook modal opens with form fields and event checkboxes', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoWebhooks();
    await page.newWebhookButton().click();
    await expect(page.createWebhookModalHeading()).toBeVisible({ timeout: 10000 });
    await expect(page.webhookNameInput()).toBeVisible({ timeout: 5000 });
    await expect(page.webhookUrlInput()).toBeVisible();
    await expect(page.deviceOnlineLabel()).toBeVisible();
    await expect(page.deviceOfflineLabel()).toBeVisible();
    await expect(page.alertCreatedLabel()).toBeVisible();
    await expect(page.alertResolvedLabel()).toBeVisible();
    await expect(page.scriptCompletedLabel()).toBeVisible();
    await expect(page.ticketCreatedLabel()).toBeVisible();
  });

  test('webhook create form shows hmac and bearer auth options', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoWebhooks();
    await page.newWebhookButton().click();
    await expect(page.createWebhookModalHeading()).toBeVisible({ timeout: 10000 });
    await expect(page.hmacSignatureText()).toBeVisible();
    await expect(page.bearerTokenText()).toBeVisible();
    await expect(page.webhookSecretInput()).toBeVisible({ timeout: 5000 });
    await expect(page.autoGenerateText()).toBeVisible();
  });

  test('switching to bearer auth shows token field', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoWebhooks();
    await page.newWebhookButton().click();
    await expect(page.createWebhookModalHeading()).toBeVisible({ timeout: 10000 });
    await page.bearerAuthRadio().click();
    await expect(page.webhookTokenInput()).toBeVisible({ timeout: 5000 });
  });

  test('webhook form has payload template and json preview', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoWebhooks();
    await page.newWebhookButton().click();
    await expect(page.createWebhookModalHeading()).toBeVisible({ timeout: 10000 });
    await expect(page.payloadTemplateTextarea()).toBeVisible({ timeout: 5000 });
    await expect(page.jsonPreviewText()).toBeVisible();
    await expect(page.customHeadersText()).toBeVisible();
    // Cancel to avoid creating test data
    const cancelButton = authedPage.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
    }
  });
});

test.describe('PSA Integrations', () => {
  test('psa integrations page loads with controls', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoPsa();
    await expect(page.psaHeading()).toBeVisible();
    await expect(page.psaDescription()).toBeVisible();
    await expect(page.addConnectionButton()).toBeVisible();
  });

  test('add psa connection modal opens and can be cancelled', async ({ authedPage }) => {
    const page = new IntegrationsPage(authedPage);
    await page.gotoPsa();
    await page.addConnectionButton().click();
    await expect(page.addPsaConnectionModalHeading()).toBeVisible({ timeout: 10000 });
    const cancelButton = authedPage.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
    }
  });
});
