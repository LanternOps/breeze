import type { Locator, Page } from '@playwright/test';

/**
 * `/devices/network/:id` — the network device detail page (#W05).
 *
 * Every locator is a data-testid, per e2e-tests/README.md. The status badge
 * keeps the id it had before the page-truth wave (`network-device-status`);
 * only its TEXT changed, from a bare "Online" to "<state> · <source> <age>".
 */
export class NetworkDevicePage {
  constructor(private page: Page) {}

  goto = (assetId: string, hash = '') => this.page.goto(`/devices/network/${assetId}${hash}`);

  // Shell
  root = () => this.page.getByTestId('network-device-detail');
  loading = () => this.page.getByTestId('network-device-detail-loading');
  name = () => this.page.getByTestId('network-device-name');
  statusBadge = () => this.page.getByTestId('network-device-status');
  approvalBadge = () => this.page.getByTestId('network-detail-approval-badge');
  approvalBanner = () => this.page.getByTestId('network-detail-approval-banner');
  approveButton = () => this.page.getByTestId('network-detail-approve');
  dismissButton = () => this.page.getByTestId('network-detail-dismiss');
  settingsButton = () => this.page.getByTestId('network-detail-settings');

  // Stat strip
  statReachability = () => this.page.getByTestId('network-detail-stat-reachability');
  statLastPoll = () => this.page.getByTestId('network-detail-stat-last-poll');
  statType = () => this.page.getByTestId('network-detail-stat-type');
  statPorts = () => this.page.getByTestId('network-detail-stat-ports');
  checkNow = () => this.page.getByTestId('network-detail-check-now');
  probeStatus = () => this.page.getByTestId('network-detail-probe-status');
  probeError = () => this.page.getByTestId('network-detail-probe-error');

  // Overview
  reachabilityCard = () => this.page.getByTestId('network-detail-reachability-card');
  collectionSummary = () => this.page.getByTestId('network-detail-collection-summary');
  health = () => this.page.getByTestId('network-detail-health');
  healthEmpty = () => this.page.getByTestId('network-detail-health-empty');
  healthUnavailable = () => this.page.getByTestId('network-detail-health-unavailable');
  setUpMonitoring = () => this.page.getByTestId('network-detail-setup-monitoring');
  supplyMeters = (): Locator => this.page.getByTestId(/^network-detail-supply-/);
  pageCount = () => this.page.getByTestId('network-detail-page-count');
  identity = () => this.page.getByTestId('network-detail-identity');
  copyIp = () => this.page.getByTestId('network-detail-copy-ip');
  scanDetails = () => this.page.getByTestId('network-detail-scan-details');
  scanDetailsToggle = () => this.page.getByTestId('network-detail-scan-details-toggle');
  ports = () => this.page.getByTestId('network-detail-ports');

  // Tabs
  tabOverview = () => this.page.getByTestId('network-detail-tab-overview');
  tabMonitoring = () => this.page.getByTestId('network-detail-tab-monitoring');
  monitoringPanel = () => this.page.getByTestId('network-detail-monitoring');

  // Monitoring tab
  pollConfig = () => this.page.getByTestId('network-detail-poll-config');
  editPollConfig = () => this.page.getByTestId('network-detail-edit-poll-config');
  oidTable = () => this.page.getByTestId('network-detail-oid-table');
  oidNoTemplate = () => this.page.getByTestId('network-detail-oid-no-template');
  oidNotConfigured = () => this.page.getByTestId('network-detail-oid-not-configured');
  chartRange = (range: '24h' | '7d' | '30d') => this.page.getByTestId(`network-detail-chart-range-${range}`);
  chartsEmpty = () => this.page.getByTestId('network-detail-charts-empty');
  checks = () => this.page.getByTestId('network-detail-checks');
  thresholds = () => this.page.getByTestId('network-detail-thresholds');

  // W04's settings modal, reached from this page
  settingsModal = () => this.page.getByTestId('network-asset-settings-modal');

  /**
   * The Monitoring tab can be a visible tab or live inside the "More" overflow
   * depending on viewport width, and `OverflowTabs` renders the same testid in
   * both places — so clicking the testid works either way, as long as the
   * dropdown is open first when it is hidden.
   */
  async openMonitoringTab() {
    const tab = this.tabMonitoring();
    if (!(await tab.isVisible())) {
      await this.page.getByTestId('network-detail-tab-more').click();
    }
    await tab.click();
    await this.monitoringPanel().waitFor();
  }
}
