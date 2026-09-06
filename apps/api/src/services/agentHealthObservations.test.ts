import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, runOutsideDbContextMock, withSystemDbAccessContextMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

import { recordAgentHealthObservation } from './agentHealthObservations';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OBSERVATION_ID = '33333333-3333-4333-8333-333333333333';
const observedAt = '2026-08-24T12:34:56.789Z';
const receivedAt = new Date('2026-08-24T12:35:00.000Z');
const observation = {
  schemaVersion: 1 as const,
  deviceId: DEVICE_ID,
  agentVersion: '0.99.0',
  overall: 'warning' as const,
  metricsAvailable: true,
  components: { metrics: { state: 'warning' as const, reason: 'late' } },
  observedAt,
};

function statement(query: unknown): string {
  return JSON.stringify(query);
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: OBSERVATION_ID,
    schema_version: 1,
    agent_version: '0.99.0',
    overall: 'warning',
    metrics_available: true,
    components: { metrics: { state: 'warning', reason: 'late' } },
    observed_at: new Date(observedAt),
    received_at: receivedAt,
    ...overrides,
  };
}

describe('recordAgentHealthObservation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses one fresh system transaction and locks the authenticated device before inserting evidence', async () => {
    const statements: string[] = [];
    executeMock.mockImplementation((query: unknown) => {
      const text = statement(query);
      statements.push(text);
      if (text.includes('FOR KEY SHARE')) return Promise.resolve([{ id: DEVICE_ID, org_id: ORG_ID }]);
      if (text.includes('INSERT INTO') && text.includes('agent_health_observations')) return Promise.resolve([{ id: OBSERVATION_ID }]);
      if (text.includes('FROM') && text.includes('agent_health_observations')) return Promise.resolve([stored()]);
      if (text.includes('device_agent_health_latest')) return Promise.resolve([{ observation_id: OBSERVATION_ID }]);
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(recordAgentHealthObservation({
      device: { id: DEVICE_ID, orgId: ORG_ID },
      observation,
      receivedAt,
    })).resolves.toEqual({ observationId: OBSERVATION_ID, becameLatest: true });

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(statements[0]).toContain('FOR KEY SHARE');
    expect(statements[0]).toContain('devices');
    expect(statements.findIndex((text) => text.includes('agent_health_observations'))).toBeGreaterThan(0);
    expect(statements.some((text) => /UPDATE[^]*devices/i.test(text))).toBe(false);
  });

  it('rejects a missing or foreign-org device before writing evidence', async () => {
    for (const lockedRows of [[], [{ id: DEVICE_ID, org_id: '99999999-9999-4999-8999-999999999999' }]]) {
      executeMock.mockReset();
      executeMock.mockResolvedValueOnce(lockedRows);

      await expect(recordAgentHealthObservation({
        device: { id: DEVICE_ID, orgId: ORG_ID },
        observation,
        receivedAt,
      })).rejects.toThrow(/device/i);
      expect(executeMock).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects an explicit wire device mismatch before entering a transaction', async () => {
    await expect(recordAgentHealthObservation({
      device: { id: DEVICE_ID, orgId: ORG_ID },
      observation: { ...observation, deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      receivedAt,
    })).rejects.toThrow(/device/i);
    expect(runOutsideDbContextMock).not.toHaveBeenCalled();
  });

  it('accepts an omitted wire device id and persists the authenticated device identity', async () => {
    executeMock
      .mockResolvedValueOnce([{ id: DEVICE_ID, org_id: ORG_ID }])
      .mockResolvedValueOnce([{ id: OBSERVATION_ID }])
      .mockResolvedValueOnce([stored()])
      .mockResolvedValueOnce([{ observation_id: OBSERVATION_ID }]);
    const { deviceId: _omitted, ...wireObservation } = observation;

    await expect(recordAgentHealthObservation({
      device: { id: DEVICE_ID, orgId: ORG_ID },
      observation: wireObservation,
      receivedAt,
    })).resolves.toEqual({ observationId: OBSERVATION_ID, becameLatest: true });

    expect(statement(executeMock.mock.calls[1]?.[0])).toContain(DEVICE_ID);
  });

  it('reuses an exact retry identity without inserting a second row or reclaiming latest by retry receipt time', async () => {
    executeMock
      .mockResolvedValueOnce([{ id: DEVICE_ID, org_id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stored()])
      .mockResolvedValueOnce([]);

    const result = await recordAgentHealthObservation({
      device: { id: DEVICE_ID, orgId: ORG_ID },
      observation,
      receivedAt: new Date('2026-08-24T13:00:00.000Z'),
    });

    expect(result).toEqual({ observationId: OBSERVATION_ID, becameLatest: false });
    const latestSql = statement(executeMock.mock.calls[3]?.[0]);
    expect(latestSql).toContain('received_at');
    expect(latestSql).toContain('observation_id');
    expect(latestSql).toContain('>');
  });

  it('rejects equivocation for the same device and observed timestamp', async () => {
    executeMock
      .mockResolvedValueOnce([{ id: DEVICE_ID, org_id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stored({ overall: 'healthy' })]);

    await expect(recordAgentHealthObservation({
      device: { id: DEVICE_ID, orgId: ORG_ID },
      observation,
      receivedAt,
    })).rejects.toThrow(/equivocation/i);
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it('reports an out-of-order receipt as not latest', async () => {
    executeMock
      .mockResolvedValueOnce([{ id: DEVICE_ID, org_id: ORG_ID }])
      .mockResolvedValueOnce([{ id: OBSERVATION_ID }])
      .mockResolvedValueOnce([stored()])
      .mockResolvedValueOnce([]);

    await expect(recordAgentHealthObservation({
      device: { id: DEVICE_ID, orgId: ORG_ID },
      observation,
      receivedAt,
    })).resolves.toEqual({ observationId: OBSERVATION_ID, becameLatest: false });
  });
});
