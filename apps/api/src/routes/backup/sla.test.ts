import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { slaRoutes } from './sla';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

vi.mock('../../services', () => ({}));

const writeRouteAuditMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupSlaConfigs: {
    id: 'backup_sla_configs.id',
    orgId: 'backup_sla_configs.org_id',
    name: 'backup_sla_configs.name',
    createdAt: 'backup_sla_configs.created_at',
    isActive: 'backup_sla_configs.is_active',
  },
  backupSlaEvents: {
    orgId: 'backup_sla_events.org_id',
    slaConfigId: 'backup_sla_events.sla_config_id',
    deviceId: 'backup_sla_events.device_id',
    detectedAt: 'backup_sla_events.detected_at',
    resolvedAt: 'backup_sla_events.resolved_at',
    eventType: 'backup_sla_events.event_type',
  },
  backupJobs: {
    id: 'backup_jobs.id',
  },
  recoveryReadiness: {
    orgId: 'recovery_readiness.org_id',
    estimatedRpoMinutes: 'recovery_readiness.estimated_rpo_minutes',
    estimatedRtoMinutes: 'recovery_readiness.estimated_rto_minutes',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

describe('sla routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup/sla', slaRoutes);
  });

  it('returns an empty SLA config list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/sla/configs', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('creates an SLA config', async () => {
    insertMock.mockReturnValueOnce(chainMock([{
      id: CONFIG_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Servers',
      rpoTargetMinutes: 15,
      rtoTargetMinutes: 60,
      targetDevices: [DEVICE_ID],
      targetGroups: [],
      alertOnBreach: true,
      isActive: true,
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      updatedAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));

    const res = await app.request('/backup/sla/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Tier 1 Servers',
        rpoTargetMinutes: 15,
        rtoTargetMinutes: 60,
        targetDevices: [DEVICE_ID],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(CONFIG_ID);
  });

  it('returns an empty SLA event list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/sla/events', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('returns an SLA dashboard summary', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 3 }]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ count: 4 }]))
      .mockReturnValueOnce(chainMock([{ avgRpo: 15, avgRto: 45 }]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]));

    const res = await app.request('/backup/sla/dashboard', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.activeConfigs).toBe(3);
    expect(body.data.compliantConfigs).toBe(2);
    expect(body.data.compliancePercent).toBe(67);
    expect(body.data.avgRpoMinutes).toBe(15);
    expect(body.data.avgRtoMinutes).toBe(45);
  });
});
