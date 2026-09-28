import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/topology/monitoringAlerts', () => ({ drainTopologyAlertTransitions: vi.fn(async () => undefined) }));
vi.mock('../services/topology/monitoringAssessment', () => ({
  drainTopologyMonitoringAssessments: vi.fn(async () => ({ applied: 7, opened: 2, recovered: 1 })),
}));
vi.mock('../services/topology/monitoringScheduler', () => ({
  dispatchDueTopologyPolicies: vi.fn(async () => ({ scheduled: 3, gaps: 1, skipped: 0, disarmed: 1 })),
}));
vi.mock('../services/topology/telemetryArmFence', () => ({ ensureTopologyTelemetryArmAuthority: vi.fn() }));
vi.mock('../services/topology/telemetryArms', () => ({ dispatchDueTopologyTelemetryArms: vi.fn(async () => undefined) }));
vi.mock('../services/topology/diagnosticSweeper', () => ({ sweepTopologyDiagnosticRuns: vi.fn(async () => 4) }));

import { metricsRegistry } from '../services/metricsRegistry';
import { TOPOLOGY_METRIC_NAMES } from '../services/topology/metrics';
import { runTopologyDiagnosticSweep } from './topologyDiagnosticSweeper';
import { runTopologyMonitoringTick } from './topologyMonitoringWorker';

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

describe('topology worker metrics', () => {
  it('publishes scheduler occurrences and assessment outcomes from one monitoring tick', async () => {
    await runTopologyMonitoringTick();
    const text = await metricsRegistry.metrics();
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.schedulerOccurrences}{status="dispatched"} 3`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.schedulerOccurrences}{status="quota_gap"} 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.schedulerOccurrences}{status="disarmed"} 1`);
    expect(text).not.toContain(`${TOPOLOGY_METRIC_NAMES.schedulerOccurrences}{status="skipped"}`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.assessments}{status="applied"} 7`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.assessments}{status="alert_opened"} 2`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.assessments}{status="alert_recovered"} 1`);
  });

  it('publishes the orphan sweeper expiry count', async () => {
    await expect(runTopologyDiagnosticSweep()).resolves.toBe(4);
    expect(await metricsRegistry.metrics()).toContain(`${TOPOLOGY_METRIC_NAMES.diagnosticRunsExpired} 4`);
  });
});
