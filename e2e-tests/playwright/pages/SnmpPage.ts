// e2e-tests/playwright/pages/SnmpPage.ts
// Note: /snmp redirects to /monitoring. SNMP Templates live at /monitoring?tab=templates.
// This POM also covers Partner Portal (/partner) and Admin Quarantined (/admin/quarantined).
import { BasePage } from './BasePage';

export class SnmpPage extends BasePage {
  // Monitoring page (/monitoring)
  monitoringHeading = () => this.page.getByRole('heading', { name: 'Monitoring' });
  assetsTab = () => this.page.getByRole('button', { name: 'Assets' });
  networkChecksTab = () => this.page.getByRole('button', { name: 'Network Checks' });
  snmpTemplatesTab = () => this.page.getByRole('button', { name: 'SNMP Templates' });
  snmpTemplatesHeading = () => this.page.getByRole('heading', { name: 'SNMP Templates' });
  addTemplateButton = () => this.page.getByRole('button', { name: 'Add template' });

  async gotoMonitoring() {
    await this.page.goto('/monitoring');
    await this.monitoringHeading().waitFor();
  }

  async gotoSnmpTemplates() {
    await this.gotoMonitoring();
    await this.snmpTemplatesTab().click();
    await this.snmpTemplatesHeading().waitFor();
  }

  // Partner Portal (/partner)
  partnerPortalHeading = () => this.page.getByRole('heading', { name: 'Partner Portal' });
  partnerPortalDescription = () => this.page.getByText('Monitor customer health, device coverage, and billing');
  addCustomerLink = () => this.page.getByRole('link', { name: 'Add customer' });
  viewAllAlertsLink = () => this.page.getByRole('link', { name: 'View all alerts' });
  runReportLink = () => this.page.getByRole('link', { name: 'Run report' });
  customerHealthSection = () => this.page.getByRole('heading', { name: 'Customer health' });
  customerSearchInput = () => this.page.getByRole('textbox', { name: /search customers/i });
  billingSummarySection = () => this.page.getByRole('heading', { name: 'Billing summary' });
  portfolioSnapshotSection = () => this.page.getByRole('heading', { name: 'Portfolio snapshot' });
  devicesAcrossCustomersSection = () => this.page.getByRole('heading', { name: 'Devices across customers' });

  async gotoPartner() {
    await this.page.goto('/partner');
    await this.partnerPortalHeading().waitFor();
  }

  // Admin Quarantined (/admin/quarantined)
  quarantinedHeading = () => this.page.getByRole('heading', { name: 'Quarantined Devices' });
  quarantinedDescription = () => this.page.getByText('expired or invalid mTLS certificates');
  refreshButton = () => this.page.getByRole('button', { name: 'Refresh' });

  async gotoQuarantined() {
    await this.page.goto('/admin/quarantined');
    await this.quarantinedHeading().waitFor();
  }
}
