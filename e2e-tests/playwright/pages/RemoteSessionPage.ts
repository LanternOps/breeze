// e2e-tests/playwright/pages/RemoteSessionPage.ts
// Note: The remote_session.yaml tests are heavily `remote` action (live agent)
// and `data-testid` based. This POM captures the UI-accessible parts only.
// Tests that require a live agent connection are marked as `.skip` in the spec.
import { BasePage } from './BasePage';

export class RemoteSessionPage extends BasePage {
  // Devices list
  devicesHeading = () => this.page.getByRole('heading', { name: 'Devices' });

  async gotoDevices() {
    await this.page.goto('/devices');
    await this.devicesHeading().waitFor();
  }

  // Terminal container (requires live agent — used only when agent is available)
  terminalContainer = () => this.page.locator('[data-testid="terminal-container"]');
  terminalConnected = () => this.page.locator('[data-testid="terminal-connected"]');

  // Remote desktop container (requires live agent)
  remoteDesktopContainer = () => this.page.locator('[data-testid="remote-desktop-container"]');
  sessionConnected = () => this.page.locator('[data-testid="session-connected"]');
}
