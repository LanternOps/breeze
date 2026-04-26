// e2e-tests/playwright/pages/IntegrationsPage.ts
import { BasePage } from './BasePage';

export class IntegrationsPage extends BasePage {
  // Webhooks (/integrations/webhooks)
  webhooksHeading = () => this.page.getByRole('heading', { name: 'Webhooks' });
  webhooksDescription = () => this.page.getByText('Deliver events to external systems');
  newWebhookButton = () => this.page.getByRole('button', { name: 'New Webhook' });

  async gotoWebhooks() {
    await this.page.goto('/integrations/webhooks');
    await this.webhooksHeading().waitFor();
  }

  // Webhook create form
  createWebhookModalHeading = () => this.page.getByText('Create Webhook');
  webhookNameInput = () => this.page.locator('#webhook-name');
  webhookUrlInput = () => this.page.locator('#webhook-url');
  webhookSecretInput = () => this.page.locator('#webhook-secret');
  webhookTokenInput = () => this.page.locator('#webhook-token');
  bearerAuthRadio = () => this.page.locator('input[value="bearer"]');
  payloadTemplateTextarea = () => this.page.locator('#payload-template');

  // Event checkboxes text labels
  deviceOnlineLabel = () => this.page.getByText('Device Online');
  deviceOfflineLabel = () => this.page.getByText('Device Offline');
  alertCreatedLabel = () => this.page.getByText('Alert Created');
  alertResolvedLabel = () => this.page.getByText('Alert Resolved');
  scriptCompletedLabel = () => this.page.getByText('Script Completed');
  ticketCreatedLabel = () => this.page.getByText('Ticket Created');
  hmacSignatureText = () => this.page.getByText('HMAC signature');
  bearerTokenText = () => this.page.getByText('Bearer token');
  jsonPreviewText = () => this.page.getByText('JSON preview');
  customHeadersText = () => this.page.getByText('Custom Headers');
  autoGenerateText = () => this.page.getByText('Auto-generate');

  // PSA Integrations (/integrations/psa)
  psaHeading = () => this.page.getByRole('heading', { name: 'PSA Integrations' });
  psaDescription = () => this.page.getByText('Connect your PSA to sync tickets');
  addConnectionButton = () => this.page.getByRole('button', { name: 'Add connection' });
  addPsaConnectionModalHeading = () => this.page.getByText('Add PSA Connection');

  async gotoPsa() {
    await this.page.goto('/integrations/psa');
    await this.psaHeading().waitFor();
  }
}
