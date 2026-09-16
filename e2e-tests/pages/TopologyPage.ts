import type { Page } from '@playwright/test';
/** DOM access is exclusively through the repository's data-testid contract. */
export class TopologyPage {
  constructor(readonly page: Page) {}
  explorer = () => this.page.getByTestId('topology-explorer');
  canvas = () => this.page.getByTestId('topology-canvas');
  internetHealth = () => this.page.getByTestId('topology-health-internet');
  listToggle = () => this.page.getByTestId('topology-list-toggle');
  node = (id: string) => this.page.getByTestId(`topology-node-${id}`);
  inspector = () => this.page.getByTestId('topology-inspector');
  arrange = () => this.page.getByTestId('topology-arrange');
  saveLayout = () => this.page.getByTestId('topology-layout-save');
  async openNetworkDevice(assetId: string) { await this.page.goto(`/devices/network/${assetId}#topology`); await this.explorer().waitFor(); }
}
