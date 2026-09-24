import type { Page } from '@playwright/test';
export class DeviceHardwarePage {
  constructor(private page: Page) {}
  goto = (deviceId: string) => this.page.goto(`/devices/${deviceId}#hardware`);
  section = () => this.page.getByTestId('hardware-storage-section');
  rollup = () => this.page.getByTestId('hardware-rollup-pill');
  controllers = () => this.page.getByTestId('hardware-controller-card');
  sources = () => this.page.getByTestId('hardware-sources-footer');
  events = () => this.page.getByTestId('hardware-events-list');
  eventsToggle = () => this.page.getByTestId('hardware-events-toggle');
  empty = () => this.page.getByTestId('hardware-empty-state');
  disk = (key: string) => this.page.getByTestId(`hardware-disk-${key}`);
  progress = (key: string) => this.page.getByTestId(`hardware-progress-${key}`);
}
