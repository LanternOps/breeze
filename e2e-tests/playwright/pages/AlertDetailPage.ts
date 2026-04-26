// e2e-tests/playwright/pages/AlertDetailPage.ts
// Covers the AlertDetails modal/panel rendered by AlertsPage
import { BasePage } from './BasePage';

export class AlertDetailPage extends BasePage {
  // AlertDetails.tsx: the slide-in panel with h2 for alert title
  panel() {
    return this.page.locator('div.fixed').filter({ has: this.page.locator('h2') });
  }

  // AlertDetails.tsx: <h3>Device Information</h3>
  deviceInfoHeading() {
    return this.page.getByRole('heading', { level: 3, name: 'Device Information' });
  }

  // AlertDetails.tsx: Triggered label
  triggeredLabel() {
    return this.page.getByText('Triggered', { exact: true });
  }

  closeButton() {
    return this.page.getByRole('button', { name: 'Close' });
  }

  acknowledgeButton() {
    return this.page.getByRole('button', { name: 'Acknowledge' });
  }

  resolveButton() {
    return this.page.getByRole('button', { name: 'Resolve' });
  }

  // After clicking Resolve, a resolution form appears
  resolutionNoteHeading() {
    return this.page.getByRole('heading', { level: 3, name: 'Resolution Note' });
  }

  resolutionNoteTextarea() {
    return this.page.getByPlaceholder('Describe how the issue was resolved...');
  }

  resolveAlertButton() {
    return this.page.getByRole('button', { name: 'Resolve Alert' });
  }

  async waitForPanel() {
    await this.panel().waitFor({ timeout: 10000 });
  }

  async close() {
    await this.closeButton().click();
  }

  async acknowledge() {
    await this.acknowledgeButton().click();
    await this.page.getByText('Acknowledged').waitFor({ timeout: 10000 });
  }

  async resolveWithNote(note: string) {
    await this.resolveButton().click();
    await this.resolutionNoteHeading().waitFor({ timeout: 10000 });
    await this.resolutionNoteTextarea().fill(note);
    await this.resolveAlertButton().click();
  }
}
