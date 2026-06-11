import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { slaRoutes } from './sla';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_DEVICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

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
let permissionsState: any;

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  or: (...conditions: unknown[]) => ({ op: 'or', conditions }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
  lte: (column: unknown, value: unknown) => ({ op: 'lte', column, value }),
  isNull: (column: unknown) => ({ op: 'isNull', column }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  desc: (value: unknown) => ({ op: 'desc', value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
}));

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
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
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
    if (permissionsState) {
      c.set('permissions', permissionsState);
    }
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

describe('sla routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    insertMock.mockReset();
    insertMock.mockImplementation(() => chainMock([]));
    updateMock.mockReset();
    updateMock.mockImplementation(() => chainMock([]));
    deleteMock.mockReset();
    deleteMock.mockImplementation(() => chainMock([]));
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    permissionsState = undefined;
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      if (permissionsState) {
        c.set('permissions', permissionsState);
      }
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

  it('denies an explicit out-of-scope SLA event device filter for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([
      { id: DEVICE_ID, siteId: SITE_A },
    ]));

    const res = await app.request(`/backup/sla/events?deviceId=${OTHER_DEVICE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('narrows SLA event lists to allowed device sites while retaining unattributed events', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    const eventsChain = chainMock([
      makeSlaEvent({ deviceId: DEVICE_ID }),
      makeSlaEvent({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deviceId: null }),
    ]);
    selectMock
      .mockReturnValueOnce(chainMock([
        { id: DEVICE_ID, siteId: SITE_A },
        { id: OTHER_DEVICE_ID, siteId: SITE_B },
      ]))
      .mockReturnValueOnce(eventsChain);

    const res = await app.request('/backup/sla/events', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
    expect(eventsChain.where).toHaveBeenCalledWith(expect.objectContaining({
      conditions: expect.arrayContaining([
        expect.objectContaining({
          op: 'or',
          conditions: expect.arrayContaining([
            expect.objectContaining({ op: 'isNull', column: 'backup_sla_events.device_id' }),
            expect.objectContaining({ op: 'inArray', column: 'backup_sla_events.device_id', values: [DEVICE_ID] }),
          ]),
        }),
      ]),
    }));
  });

  it('keeps unrestricted SLA event list behavior unchanged', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSlaEvent({ deviceId: DEVICE_ID }),
      makeSlaEvent({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deviceId: OTHER_DEVICE_ID }),
    ]));

    const res = await app.request('/backup/sla/events', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
    expect(selectMock).toHaveBeenCalledTimes(1);
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

function makeSlaEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    orgId: ORG_ID,
    slaConfigId: CONFIG_ID,
    deviceId: DEVICE_ID,
    eventType: 'rpo_breach',
    details: {},
    detectedAt: new Date('2026-03-29T00:00:00.000Z'),
    resolvedAt: null,
    ...overrides,
  };
}
