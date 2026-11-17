import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { WAKE_AGENT_READINESS_STATES } from '@breeze/shared';

const m = vi.hoisted(() => ({
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
}));
vi.mock('../db', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        m.values(v);
        return { onConflictDoUpdate: async (a: unknown) => { m.onConflictDoUpdate(a); } };
      },
    }),
  },
}));

import { ingestWakeStatusSnapshot } from './wakeStatusIngest';
import { WAKE_READINESS_STATES } from '../db/schema/deviceWake';

const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  readinessState: 'unproven' as const,
  reasonCodes: ['firmware_adapter_unavailable'],
  vendor: 'dell',
  fingerprint: 'f'.repeat(64),
  collectedAt: '2099-01-01T00:00:00Z',
  lastApplyAt: null,
  lastApplyResult: null,
  lastWiredAdapterSeenAt: '2026-11-01T00:00:00Z',
  details: { os: 'windows', adapters: [] },
};

beforeEach(() => { m.values.mockReset(); m.onConflictDoUpdate.mockReset(); });

it('keeps the agent-reportable states identical to the schema enum', () => {
  expect([...WAKE_AGENT_READINESS_STATES]).toEqual([...WAKE_READINESS_STATES]);
});

describe('ingestWakeStatusSnapshot', () => {
  const receivedAt = new Date('2026-11-15T12:00:00Z');
  const run = () => ingestWakeStatusSnapshot({ deviceId, orgId, agentVersion: '0.130.0', snapshot, receivedAt });

  it('upserts one row keyed by device with server received_at, stored collected_at, and no proof columns', async () => {
    expect(await run()).toEqual({ accepted: true });
    expect(m.values).toHaveBeenCalledTimes(1);
    expect(m.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    const row = m.values.mock.calls[0]![0];
    expect(row).toMatchObject({
      deviceId, orgId, readinessState: 'unproven', reasonCodes: ['firmware_adapter_unavailable'],
      vendor: 'dell', fingerprint: snapshot.fingerprint, agentVersion: '0.130.0',
      lastApplyAt: null, lastApplyResult: null, details: snapshot.details,
    });
    expect(row.receivedAt).toBe(receivedAt);
    expect(row.collectedAt).toEqual(new Date('2099-01-01T00:00:00Z'));
    expect(row.lastWiredAdapterSeenAt).toEqual(new Date('2026-11-01T00:00:00Z'));
    expect(row).not.toHaveProperty('proofFingerprint');
    expect(row).not.toHaveProperty('lastCameOnlineAt');
    const { target, set } = m.onConflictDoUpdate.mock.calls[0]![0];
    expect(target.name).toBe('device_id');
    expect(set.receivedAt).toBe(receivedAt);
    expect(set).not.toHaveProperty('proofFingerprint');
    expect(set).not.toHaveProperty('lastCameOnlineAt');
    expect(set).not.toHaveProperty('deviceId');
    expect(set).not.toHaveProperty('orgId');
  });

  it('resets consecutive_timeouts only when the fingerprint changes', async () => {
    await run();
    const { set } = m.onConflictDoUpdate.mock.calls[0]![0];
    const q = new PgDialect().sqlToQuery(set.consecutiveTimeouts);
    expect(q.sql.replace(/\s+/g, ' ')).toMatch(
      /case when "device_wake_status"\."fingerprint" is distinct from excluded\.fingerprint then 0 else "device_wake_status"\."consecutive_timeouts" end/i,
    );
  });
});
