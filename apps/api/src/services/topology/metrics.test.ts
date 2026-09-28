import { beforeEach, describe, expect, it } from 'vitest';

import { metricsRegistry } from '../metricsRegistry';
import {
  TOPOLOGY_METRIC_NAMES,
  recordTopologyAssessment,
  recordTopologyDiagnosticDispatch,
  recordTopologyDiagnosticResult,
  recordTopologyDiagnosticSweep,
  recordTopologyHistoryRead,
  recordTopologySchedulerOccurrences,
  recordTopologyTelemetryBatch,
  recordTopologyTelemetrySourceSwitch,
} from './metrics';

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

const scrape = () => metricsRegistry.metrics();

describe('topology operational metrics (M3 Task 11)', () => {
  it('registers every series on the shared registry under a topology_ prefix', async () => {
    const text = await scrape();
    for (const name of Object.values(TOPOLOGY_METRIC_NAMES)) {
      expect(name.startsWith('topology_')).toBe(true);
      expect(text).toContain(`# HELP ${name} `);
    }
  });

  it('counts telemetry batches and samples by bounded status, and histograms batch bytes and lag', async () => {
    recordTopologyTelemetryBatch({ status: 'accepted', inserted: 5, duplicates: 2, historicalOnly: 1, bytes: 2048, lagSeconds: 12 });
    recordTopologyTelemetryBatch({ status: 'telemetry_quota_exceeded', inserted: 0, duplicates: 0, historicalOnly: 0 });
    const text = await scrape();
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.telemetryBatches}{status="accepted"} 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.telemetryBatches}{status="telemetry_quota_exceeded"} 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.telemetrySamples}{status="inserted"} 4`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.telemetrySamples}{status="duplicate"} 2`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.telemetrySamples}{status="historical_only"} 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.telemetryBatchBytes}_count 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.telemetryLag}_sum 12`);
  });

  it('counts source switches', async () => {
    recordTopologyTelemetrySourceSwitch();
    recordTopologyTelemetrySourceSwitch();
    expect(await scrape()).toContain(`${TOPOLOGY_METRIC_NAMES.telemetrySourceSwitches} 2`);
  });

  it('records dispatch duration and result outcomes by recipe and status', async () => {
    recordTopologyDiagnosticDispatch('trace_route', 'queued', 0.25);
    recordTopologyDiagnosticResult('trace_route', 'late');
    recordTopologyDiagnosticResult('target_connectivity', 'accepted');
    const text = await scrape();
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.dispatchDuration}_count{recipe="trace_route",status="queued"} 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.diagnosticResults}{recipe="trace_route",status="late"} 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.diagnosticResults}{recipe="target_connectivity",status="accepted"} 1`);
  });

  it('adds sweeper expiries, scheduler occurrences and assessments, ignoring zero, negative and non-finite counts', async () => {
    recordTopologyDiagnosticSweep(3);
    recordTopologyDiagnosticSweep(0);
    recordTopologySchedulerOccurrences('dispatched', 4);
    recordTopologySchedulerOccurrences('quota_gap', 1);
    recordTopologySchedulerOccurrences('dispatched', Number.NaN);
    recordTopologyAssessment('alert_opened', 2);
    recordTopologyAssessment('applied', -1);
    const text = await scrape();
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.diagnosticRunsExpired} 3`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.schedulerOccurrences}{status="dispatched"} 4`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.schedulerOccurrences}{status="quota_gap"} 1`);
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.assessments}{status="alert_opened"} 2`);
    expect(text).not.toContain('status="applied"');
    expect(text).not.toContain('NaN');
  });

  it('histograms history buckets by resolution', async () => {
    recordTopologyHistoryRead('5m', 288);
    expect(await scrape()).toContain(`${TOPOLOGY_METRIC_NAMES.historyBuckets}_count{resolution="5m"} 1`);
  });

  it('never lets a free-form value become a label (no ids, names or addresses)', async () => {
    const siteId = '0b0d6a52-7a51-4c55-8f0b-3d7c8b9f1e22';
    recordTopologyDiagnosticResult(siteId as never, '10.0.0.1' as never);
    recordTopologyAssessment('Core Switch — Floor 2' as never, 1);
    recordTopologyHistoryRead(siteId as never, 1);
    const text = await scrape();
    expect(text).not.toContain(siteId);
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('Core Switch');
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.diagnosticResults}{recipe="other",status="other"} 1`);
  });

  it('only ever declares the allowed low-cardinality label names', async () => {
    const metrics = await metricsRegistry.getMetricsAsJSON();
    const allowed = new Set(['recipe', 'status', 'platform', 'resolution', 'le']);
    for (const metric of metrics.filter(entry => entry.name.startsWith('topology_'))) {
      for (const value of metric.values as Array<{ labels: Record<string, unknown> }>) {
        for (const label of Object.keys(value.labels)) expect(allowed.has(label)).toBe(true);
      }
    }
  });
});
