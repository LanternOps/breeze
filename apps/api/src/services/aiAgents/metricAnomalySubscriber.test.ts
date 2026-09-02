/**
 * metricAnomalySubscriber (#3828 wave-6-4 task 3).
 *
 * Mocked-DB unit tests for the durable `ai-agent-anomaly` event subscriber.
 * `createAndEnqueueAgentRun` (runService.ts) is mocked — its own admission
 * behaviour (dedupe, forced shadow, kill switch, circuit breaker, trigger-
 * filter matching) is covered in runService.test.ts; these tests pin only
 * what THIS module is responsible for: extracting the trigger from the
 * event, loading the incident + device context, the cross-dedupe lookup
 * against the alert path, calling admission with the right shape, and the
 * best-effort agent_run_id stamp.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

vi.mock('../../db/schema/devices', () => ({
  devices: { id: 'id', orgId: 'org_id', siteId: 'site_id', tags: 'tags' },
}));

vi.mock('../../db/schema/analytics', () => ({
  metricAnomalies: {
    orgId: 'org_id',
    deviceId: 'device_id',
    anomalyType: 'anomaly_type',
    bucketSeconds: 'bucket_seconds',
    windowStart: 'window_start',
    linkedAlertId: 'linked_alert_id',
  },
}));

vi.mock('../../db/schema/metricAnomalyIncidents', () => ({
  metricAnomalyIncidents: {
    id: 'id',
    orgId: 'org_id',
    deviceId: 'device_id',
    anomalyType: 'anomaly_type',
    bucketSeconds: 'bucket_seconds',
    windowStart: 'window_start',
    peakScore: 'peak_score',
    metricNames: 'metric_names',
    agentRunId: 'agent_run_id',
  },
}));

const createAndEnqueueAgentRun = vi.hoisted(() => vi.fn());
vi.mock('./runService', () => ({ createAndEnqueueAgentRun }));

import { db, withSystemDbAccessContext } from '../../db';
import type { BreezeEvent } from '../eventBus';
import { handleAnomalyIncidentOpenedEvent } from './metricAnomalySubscriber';

const ORG_ID = '00000000-0000-4000-8000-0000000000d1';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000d2';
const INCIDENT_ID = '00000000-0000-4000-8000-0000000000d3';

const BASE_INCIDENT = {
  id: INCIDENT_ID,
  orgId: ORG_ID,
  deviceId: DEVICE_ID,
  anomalyType: 'cpu_spike',
  bucketSeconds: 300,
  windowStart: new Date('2026-08-28T00:00:00.000Z'),
  peakScore: '4.5',
  metricNames: ['cpu_percent'],
};

function anomalyIncidentOpenedEvent(over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-1',
    type: 'anomaly.incident_opened',
    orgId: ORG_ID,
    source: 'metric-anomaly-incident-publisher',
    priority: 'normal',
    payload: { incidentId: INCIDENT_ID, deviceId: DEVICE_ID },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

// Captures the most recent `.where()` mock for each of the three reads
// (incident lookup, device-context lookup, cross-dedupe sibling lookup) so a
// test can compile the predicate to real SQL — asserting on the shape that
// DEFINES the scope, not just on which rows the mock resolves to.
let lastIncidentWhereMock: ReturnType<typeof vi.fn> | undefined;
let lastDeviceWhereMock: ReturnType<typeof vi.fn> | undefined;
let lastSiblingWhereMock: ReturnType<typeof vi.fn> | undefined;

/** db.select().from().where().limit() -> rows. Must be queued in call order:
 *  incident, device, sibling (cross-dedupe). */
function queueSelect(rows: unknown[], capture?: (whereMock: ReturnType<typeof vi.fn>) => void) {
  const whereMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
  });
  capture?.(whereMock);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: whereMock,
    }),
  } as never);
}

function queueIncident(rows: unknown[]) {
  queueSelect(rows, (w) => { lastIncidentWhereMock = w; });
}

function queueDevice(rows: unknown[]) {
  queueSelect(rows, (w) => { lastDeviceWhereMock = w; });
}

function queueSiblingLinkedAlert(rows: unknown[]) {
  queueSelect(rows, (w) => { lastSiblingWhereMock = w; });
}

/** The common "admission proceeds" setup: incident found, device found,
 *  no sibling with a linked_alert_id. */
function mockCleanIncident(overrides: Partial<typeof BASE_INCIDENT> = {}) {
  queueIncident([{ ...BASE_INCIDENT, ...overrides }]);
  queueDevice([{ siteId: 'site-1', tags: ['prod'] }]);
  queueSiblingLinkedAlert([]);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  } as never);
  createAndEnqueueAgentRun.mockReset().mockResolvedValue({
    created: true,
    run: { id: 'run-1' },
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('handleAnomalyIncidentOpenedEvent', () => {
  it('admits an anomaly-triggered run when the incident and device are found', async () => {
    mockCleanIncident();

    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        kind: 'triage',
        triggerKind: 'anomaly',
        deviceId: DEVICE_ID,
        anomalyIncidentId: INCIDENT_ID,
        anomalyContext: {
          anomalyType: 'cpu_spike',
          metricNames: ['cpu_percent'],
          peakScore: 4.5,
          siteId: 'site-1',
          deviceTags: ['prod'],
        },
        dedupeKey: `anomaly:${INCIDENT_ID}`,
      }),
    );
  });

  it('cross-dedupes onto alert:<linkedAlertId> when a sibling metric_anomalies row is already promoted', async () => {
    queueIncident([BASE_INCIDENT]);
    queueDevice([{ siteId: 'site-1', tags: [] }]);
    queueSiblingLinkedAlert([{ linkedAlertId: 'alert-xyz' }]);

    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'alert:alert-xyz' }),
    );
  });

  it('runs all three reads under a system DB context and admits with no system context active', async () => {
    mockCleanIncident();
    vi.mocked(withSystemDbAccessContext).mockClear();
    let systemContextDepth = 0;
    vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn: () => Promise<unknown>) => {
      systemContextDepth += 1;
      try {
        return await fn();
      } finally {
        systemContextDepth -= 1;
      }
    });
    let depthDuringAdmission: number | null = null;
    // Snapshotting call count here (rather than only at the end of the test,
    // after the handler has also run its post-admission stamp under a system
    // context) is what makes this discriminate: it pins that exactly the
    // three reads (loadIncident, loadDeviceFilterContext, findLinkedAlertId)
    // ran under a system context BEFORE admission was ever called. A
    // mutation that drops the system-context wrapping from those three reads
    // entirely (leaving admission's own depth-0 property vacuously true,
    // since an unwrapped call is trivially not nested) leaves this at 0,
    // failing the assertion below.
    let systemContextCallsBeforeAdmission = -1;
    createAndEnqueueAgentRun.mockImplementation(async () => {
      depthDuringAdmission = systemContextDepth;
      systemContextCallsBeforeAdmission = vi.mocked(withSystemDbAccessContext).mock.calls.length;
      return { created: true, run: { id: 'run-1' } };
    });

    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    expect(systemContextCallsBeforeAdmission).toBe(3);
    expect(depthDuringAdmission).toBe(0);
  });

  it('skips admission when the incident is not found (or not in org)', async () => {
    queueIncident([]);

    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('skips admission when the incident device is not found (or not in org)', async () => {
    queueIncident([BASE_INCIDENT]);
    queueDevice([]);

    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('incident lookup WHERE clause is org-pinned', async () => {
    mockCleanIncident();
    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    const whereArg = lastIncidentWhereMock!.mock.calls[0]?.[0];
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);
    expect(sqlText).toBe('($1 = $2 and $3 = $4)');
    expect(params).toEqual(['id', INCIDENT_ID, 'org_id', ORG_ID]);
  });

  it('device lookup WHERE clause is org-pinned', async () => {
    mockCleanIncident();
    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    const whereArg = lastDeviceWhereMock!.mock.calls[0]?.[0];
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);
    expect(sqlText).toBe('($1 = $2 and $3 = $4)');
    expect(params).toEqual(['id', DEVICE_ID, 'org_id', ORG_ID]);
  });

  it('sibling cross-dedupe lookup scopes to the exact collapsing key and requires a non-null linked_alert_id', async () => {
    mockCleanIncident();
    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    const whereArg = lastSiblingWhereMock!.mock.calls[0]?.[0];
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);
    expect(sqlText).toBe('($1 = $2 and $3 = $4 and $5 = $6 and $7 = $8 and $9 = $10 and $11 is not null)');
    expect(params).toEqual([
      'org_id', ORG_ID,
      'device_id', DEVICE_ID,
      'anomaly_type', 'cpu_spike',
      'bucket_seconds', 300,
      'window_start', BASE_INCIDENT.windowStart,
      'linked_alert_id',
    ]);
  });

  it('stamps the incident agent_run_id on successful admission', async () => {
    mockCleanIncident();
    createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'run-42' } });

    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    expect(db.update).toHaveBeenCalled();
    const setMock = vi.mocked(db.update).mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    expect(setMock).toHaveBeenCalledWith({ agentRunId: 'run-42' });
  });

  it('does not stamp agent_run_id when admission is skipped', async () => {
    mockCleanIncident();
    createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'trigger_filter_mismatch' });

    await handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent());

    expect(db.update).not.toHaveBeenCalled();
  });

  it('a failed best-effort agent_run_id stamp does not throw', async () => {
    mockCleanIncident();
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('stamp failed')),
      }),
    } as never);

    await expect(handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent())).resolves.toBeUndefined();
  });

  it('does not throw and does not admit when the event payload has no incidentId', async () => {
    await expect(
      handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent({ payload: {} })),
    ).resolves.toBeUndefined();
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('does not throw and does not admit when the event payload has no deviceId', async () => {
    await expect(
      handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent({ payload: { incidentId: INCIDENT_ID } })),
    ).resolves.toBeUndefined();
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('rethrows when the incident lookup itself fails (queue-mode retry contract)', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(handleAnomalyIncidentOpenedEvent(anomalyIncidentOpenedEvent())).rejects.toThrow('boom');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });
});
