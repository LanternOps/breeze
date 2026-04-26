// e2e-tests/playwright/pages/AgentInstallPage.ts
// The agent_install.yaml tests are primarily `remote` action (live agent required).
// This POM covers the UI parts: navigating to devices, opening the enrollment modal.
import { BasePage } from './BasePage';

export class AgentInstallPage extends BasePage {
  // Devices page
  devicesHeading = () => this.page.getByRole('heading', { name: 'Devices' });

  async gotoDevices() {
    await this.page.goto('/devices');
    await this.devicesHeading().waitFor();
  }

  // Enrollment modal (opened via Add Device button)
  addDeviceButton = () => this.page.getByRole('button', { name: 'Add Device' });
  enrollmentModalHeading = () => this.page.getByRole('heading', { name: 'Add New Device' });

  async openEnrollmentModal() {
    await this.addDeviceButton().click();
    await this.enrollmentModalHeading().waitFor();
  }
}
