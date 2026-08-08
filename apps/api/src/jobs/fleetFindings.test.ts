import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  addBulkMock,
  closeMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  attachWorkerObservabilityMock,
  selectMock,
  fromMock,
  whereMock,
  groupByMock,
  limitMock,
  workerProcessorMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  produceMetricAnomalyPatternsMock,
  produceLogCorrelationFindingsMock,
  produceReliabilityOffendersMock,
  reconcileOrgFindingsMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  groupByMock: vi.fn(),
  limitMock: vi.fn(),
  workerProcessorMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(<T>(fn: () => T) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  produceMetricAnomalyPatternsMock: vi.fn(),
  produceLogCorrelationFindingsMock: vi.fn(),
  produceReliabilityOffendersMock: vi.fn(),
  reconcileOrgFindingsMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    addBulk = addBulkMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
    close = closeMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => unknown) {
      workerProcessorMock.mockImplementation(processor);
    }

    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../db/schema', () => ({
  devices: { orgId: 'devices.orgId', status: 'devices.status', isEphemeral: 'devices.isEphemeral' },
  organizations: { id: 'organizations.id', settings: 'organizations.settings' },
}));

vi.mock('../services/fleetFindings/producers', () => ({
  produceMetricAnomalyPatterns: produceMetricAnomalyPatternsMock,
  produceLogCorrelationFindings: produceLogCorrelationFindingsMock,
  produceReliabilityOffenders: produceReliabilityOffendersMock,
}));

vi.mock('../services/fleetFindings/reconcile', () => ({
  reconcileOrgFindings: reconcileOrgFindingsMock,
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

import {
  buildFleetFindingsOrgJobId,
  isFleetFindingsEnabled,
  scheduleFleetFindingsJobs,
  shutdownFleetFindingsJobs,
} from './fleetFindings';

describe('fleet findings queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
    addMock.mockReset();
    addBulkMock.mockReset();
    closeMock.mockReset();
    getRepeatableJobsMock.mockReset();
    removeRepeatableByKeyMock.mockReset();
    attachWorkerObservabilityMock.mockReset();
    selectMock.mockReset();
    fromMock.mockReset();
    whereMock.mockReset();
    groupByMock.mockReset();
    limitMock.mockReset();
    workerProcessorMock.mockReset();
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T) => fn());
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    produceMetricAnomalyPatternsMock.mockReset().mockResolvedValue([]);
    produceLogCorrelationFindingsMock.mockReset().mockResolvedValue([]);
    produceReliabilityOffendersMock.mockReset().mockResolvedValue([]);
    reconcileOrgFindingsMock.mockReset().mockResolvedValue({ opened: 0, updated: 0, resolved: 0 });
    addMock.mockResolvedValue({ id: 'queued-fleet-findings-job' });
    addBulkMock.mockResolvedValue([]);
    getRepeatableJobsMock.mockResolvedValue([]);
    // Default select chain: groupBy() path (scan-orgs org discovery).
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock, limit: limitMock });
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
    limitMock.mockResolvedValue([{ settings: {} }]);
    await shutdownFleetFindingsJobs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds per-org job ids with no colons', () => {
    expect(buildFleetFindingsOrgJobId('org-1')).toBe('fleet-findings-org-org-1');
    expect(buildFleetFindingsOrgJobId('org-1')).not.toContain(':');
  });

  describe('isFleetFindingsEnabled', () => {
    it('defaults to enabled when settings is absent', () => {
      expect(isFleetFindingsEnabled(null)).toBe(true);
      expect(isFleetFindingsEnabled(undefined)).toBe(true);
      expect(isFleetFindingsEnabled({})).toBe(true);
    });

    it('defaults to enabled when the fleet.findings.enabled path is absent', () => {
      expect(isFleetFindingsEnabled({ fleet: {} })).toBe(true);
      expect(isFleetFindingsEnabled({ fleet: { findings: {} } })).toBe(true);
    });

    it('is disabled only when explicitly false', () => {
      expect(isFleetFindingsEnabled({ fleet: { findings: { enabled: false } } })).toBe(false);
      expect(isFleetFindingsEnabled({ fleet: { findings: { enabled: true } } })).toBe(true);
    });
  });

  it('schedules a repeatable scan-orgs job with the fixed job id (no colons)', async () => {
    await scheduleFleetFindingsJobs();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'fleetFindingsWorker');
    expect(addMock).toHaveBeenCalledWith(
      'scan-orgs',
      expect.objectContaining({ type: 'scan-orgs' }),
      expect.objectContaining({
        jobId: 'fleet-findings-scan',
        repeat: { pattern: '*/10 * * * *' },
      }),
    );
    expect('fleet-findings-scan').not.toContain(':');
  });

  it('fans out the scan into per-org jobs with jobId fleet-findings-org-<orgId>', async () => {
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }, { orgId: 'org-2' }]);

    await scheduleFleetFindingsJobs();
    addBulkMock.mockClear();

    await workerProcessorMock({ data: { type: 'scan-orgs' } });

    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'process-org',
        data: expect.objectContaining({ type: 'process-org', orgId: 'org-1' }),
        opts: expect.objectContaining({ jobId: 'fleet-findings-org-org-1' }),
      }),
      expect.objectContaining({
        name: 'process-org',
        data: expect.objectContaining({ type: 'process-org', orgId: 'org-2' }),
        opts: expect.objectContaining({ jobId: 'fleet-findings-org-org-2' }),
      }),
    ]);
  });

  it('scans orgs and fans out inside a system DB context established outside the request context', async () => {
    await scheduleFleetFindingsJobs();
    addBulkMock.mockClear();

    await workerProcessorMock({ data: { type: 'scan-orgs' } });

    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).toHaveBeenCalled();
  });

  it('runs the three producers + reconcile inside a system DB context when the org flag is on (default)', async () => {
    limitMock.mockResolvedValue([{ settings: {} }]);
    produceMetricAnomalyPatternsMock.mockResolvedValue([{ kind: 'metric_anomaly_pattern' }]);
    produceLogCorrelationFindingsMock.mockResolvedValue([{ kind: 'log_correlation' }]);
    produceReliabilityOffendersMock.mockResolvedValue([{ kind: 'reliability_offenders' }]);
    reconcileOrgFindingsMock.mockResolvedValue({ opened: 1, updated: 2, resolved: 0 });

    await scheduleFleetFindingsJobs();

    const result = await workerProcessorMock({
      data: { type: 'process-org', orgId: 'org-1', queuedAt: '2026-08-07T12:00:00.000Z' },
    });

    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).toHaveBeenCalled();
    expect(produceMetricAnomalyPatternsMock).toHaveBeenCalledWith('org-1');
    expect(produceLogCorrelationFindingsMock).toHaveBeenCalledWith('org-1');
    expect(produceReliabilityOffendersMock).toHaveBeenCalledWith('org-1');
    expect(reconcileOrgFindingsMock).toHaveBeenCalledWith('org-1', [
      { kind: 'metric_anomaly_pattern' },
      { kind: 'log_correlation' },
      { kind: 'reliability_offenders' },
    ]);
    expect(result).toEqual({ skipped: false, opened: 1, updated: 2, resolved: 0 });
  });

  it('runs producers when the org settings flag is absent (default-on)', async () => {
    limitMock.mockResolvedValue([{ settings: {} }]);

    await scheduleFleetFindingsJobs();
    await workerProcessorMock({
      data: { type: 'process-org', orgId: 'org-1', queuedAt: '2026-08-07T12:00:00.000Z' },
    });

    expect(produceMetricAnomalyPatternsMock).toHaveBeenCalledWith('org-1');
    expect(reconcileOrgFindingsMock).toHaveBeenCalled();
  });

  it('skips producers and reconcile when the org has fleet.findings.enabled = false', async () => {
    limitMock.mockResolvedValue([{ settings: { fleet: { findings: { enabled: false } } } }]);

    await scheduleFleetFindingsJobs();

    const result = await workerProcessorMock({
      data: { type: 'process-org', orgId: 'org-1', queuedAt: '2026-08-07T12:00:00.000Z' },
    });

    expect(produceMetricAnomalyPatternsMock).not.toHaveBeenCalled();
    expect(produceLogCorrelationFindingsMock).not.toHaveBeenCalled();
    expect(produceReliabilityOffendersMock).not.toHaveBeenCalled();
    expect(reconcileOrgFindingsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
  });
});
