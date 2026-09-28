import type { Page } from '@playwright/test';
import { TopologyPage } from './TopologyPage';

/** M3 operational inspector (link health, port history, monitoring, port measurement, impact, changes). data-testid only. */
export class TopologyOperationsPage extends TopologyPage {
  constructor(page: Page) { super(page); }
  linkHealth = () => this.page.getByTestId('topology-link-health');
  linkStatus = () => this.page.getByTestId('topology-link-status');
  freshness = () => this.page.getByTestId('topology-health-freshness');
  endpoint = (side: 'source' | 'target') => this.page.getByTestId(`topology-link-endpoint-${side}`);
  openHistory = (side: 'source' | 'target') => this.page.getByTestId(`topology-history-open-${side}`);
  history = () => this.page.getByTestId('topology-history');
  historySeries = () => this.page.getByTestId('topology-history-series');
  historyGenerationBreak = () => this.page.getByTestId('topology-history-generation-break');
  historyGaps = () => this.page.getByTestId('topology-history-gaps');
  historyTableToggle = () => this.page.getByTestId('topology-history-table-toggle');
  historyValues = () => this.page.getByTestId('topology-history-value');
  historyMetric = () => this.page.getByTestId('topology-history-metric');
  historyClose = () => this.page.getByTestId('topology-history-close');
  impact = () => this.page.getByTestId('topology-impact');
  impactLoad = () => this.page.getByTestId('topology-impact-load');
  impactMeasured = () => this.page.getByTestId('topology-impact-measured');
  impactPotential = () => this.page.getByTestId('topology-impact-potential');
  impactHypothetical = () => this.page.getByTestId('topology-impact-hypothetical');
  impactNoAlerts = () => this.page.getByTestId('topology-impact-no-alerts');
  impactCause = () => this.page.getByTestId('topology-impact-cause');
  operationsToggle = () => this.page.getByTestId('topology-operations-toggle');
  operations = () => this.page.getByTestId('topology-operations');
  policies = () => this.page.getByTestId('topology-policies');
  policy = (key: string) => this.page.getByTestId(`topology-policy-${key}`);
  monitorStatus = () => this.page.getByTestId('topology-monitor-status');
  monitorPreview = () => this.page.getByTestId('topology-monitor-preview');
  monitorVolume = () => this.page.getByTestId('topology-monitor-volume');
  monitorEnable = () => this.page.getByTestId('topology-monitor-enable');
  monitorDisable = () => this.page.getByTestId('topology-monitor-disable');
  changes = () => this.page.getByTestId('topology-changes');
  changesLoad = () => this.page.getByTestId('topology-changes-load');
  changeRows = () => this.page.getByTestId('topology-change');
  telemetry = () => this.page.getByTestId('topology-telemetry');
  telemetryPort = (id: string) => this.page.getByTestId(`topology-telemetry-port-${id}`);
  telemetryCollector = () => this.page.getByTestId('topology-telemetry-collector');
  telemetryCredential = () => this.page.getByTestId('topology-telemetry-credential');
  telemetryPreview = () => this.page.getByTestId('topology-telemetry-preview');
  telemetryVolume = () => this.page.getByTestId('topology-telemetry-volume');
  telemetryEnable = () => this.page.getByTestId('topology-telemetry-enable');
  telemetryArm = (id: string) => this.page.getByTestId(`topology-telemetry-arm-${id}`);
  telemetryArms = () => this.page.locator('[data-testid^="topology-telemetry-arm-"]');
  telemetryRevoke = () => this.page.getByTestId('topology-telemetry-revoke');
  traceMaxHops = () => this.page.getByTestId('topology-trace-max-hops');
  traceProbes = () => this.page.getByTestId('topology-trace-probes');
  traceStart = () => this.page.getByTestId('topology-trace-start');
}
