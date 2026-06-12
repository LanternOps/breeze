import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'id', agentId: 'agent_id', orgId: 'org_id', hostname: 'hostname' },
  deviceSessions: {
    id: 'id',
    orgId: 'org_id',
    deviceId: 'device_id',
    username: 'username',
    sessionType: 'session_type',
    osSessionId: 'os_session_id',
    loginAt: 'login_at',
    logoutAt: 'logout_at',
    durationSeconds: 'duration_seconds',
    idleMinutes: 'idle_minutes',
    activityState: 'activity_state',
    loginPerformanceSeconds: 'login_performance_seconds',
    isActive: 'is_active',
    lastActivityAt: 'last_activity_at',
    updatedAt: 'updated_at',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/requireAgentRole', () => ({
  requireAgentRole: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('./helpers', () => ({
  sanitizeTimestamp: vi.fn((value: string | undefined) => (value ? new Date(value) : null)),
}));

import { db } from '../../db';
import { sessionsRoutes } from './sessions';

function mockDeviceLookup() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: 'org-1', hostname: 'host-1' }]),
      }),
    }),
  } as any);
}

describe('PUT /agents/:id/sessions', () => {
  let app: Hono;
  let insertedValues: any[];
  let updatedValues: any[];

  function mockTransaction(existingActive: any[] = []) {
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(existingActive),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((vals: any) => {
            insertedValues.push(vals);
            return Promise.resolve(undefined);
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((vals: any) => {
            updatedValues.push(vals);
            return { where: vi.fn().mockResolvedValue(undefined) };
          }),
        }),
      };
      return fn(tx);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues = [];
    updatedValues = [];
    app = new Hono();
    app.route('/agents', sessionsRoutes);
    mockTransaction();
  });

  it('stores null idleMinutes when the agent omits it (unknown ≠ 0)', async () => {
    mockDeviceLookup();

    const res = await app.request(`/agents/${AGENT_ID}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: [{ username: 'alice', sessionType: 'console', isActive: true }],
        events: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].idleMinutes).toBeNull();
  });

  it('stores explicit idleMinutes 0 as 0 (measured active)', async () => {
    mockDeviceLookup();

    const res = await app.request(`/agents/${AGENT_ID}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: [{ username: 'alice', sessionType: 'console', isActive: true, idleMinutes: 0 }],
        events: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].idleMinutes).toBe(0);
  });

  it('stores measured idleMinutes as provided', async () => {
    mockDeviceLookup();

    const res = await app.request(`/agents/${AGENT_ID}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: [{ username: 'alice', sessionType: 'console', isActive: true, idleMinutes: 23 }],
        events: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues[0].idleMinutes).toBe(23);
  });

  it('stores null idleMinutes on the update path too (existing session, agent omits it)', async () => {
    mockDeviceLookup();
    mockTransaction([
      {
        id: 'sess-1',
        username: 'alice',
        sessionType: 'console',
        osSessionId: null,
        loginAt: new Date('2026-06-11T08:00:00Z'),
      },
    ]);

    const res = await app.request(`/agents/${AGENT_ID}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: [{ username: 'alice', sessionType: 'console', isActive: true }],
        events: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(0);
    const sessionUpdate = updatedValues.find((v) => 'idleMinutes' in v);
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate.idleMinutes).toBeNull();
  });
});
