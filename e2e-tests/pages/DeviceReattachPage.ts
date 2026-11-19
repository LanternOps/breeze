import type { Page } from '@playwright/test';

/** The reattach surfaces on the device page (#8318): the banner action, the dialog and the badge. */
export class DeviceReattachPage {
  constructor(private page: Page) {}
  goto = (deviceId: string) => this.page.goto(`/devices/${deviceId}`);
  banner = () => this.page.getByTestId('possible-replacement-banner');
  reattachButton = () => this.page.getByTestId('possible-replacement-reattach');
  bannerPending = () => this.page.getByTestId('possible-replacement-reattach-pending');
  dialog = () => this.page.getByTestId('reattach-dialog');
  comparison = () => this.page.getByTestId('reattach-comparison');
  compareTarget = (field: string) => this.page.getByTestId(`reattach-compare-${field}-target`);
  evidenceNotice = () => this.page.getByTestId('reattach-evidence-notice');
  consequences = () => this.page.getByTestId('reattach-consequences');
  possession = () => this.page.getByTestId('reattach-possession');
  confirmName = () => this.page.getByTestId('reattach-confirm-name');
  submit = () => this.page.getByTestId('reattach-submit');
  pending = () => this.page.getByTestId('reattach-pending');
  done = () => this.page.getByTestId('reattach-done');
  reinstalledBadge = () => this.page.getByTestId('device-reinstalled-badge');
}
