import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'a@b.c', name: 'A' },
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (orgId: string) => orgId === 'org-1',
      orgCondition: (column: any) => eq(column, '11111111-1111-4111-8111-111111111111'),
      token: { mfa: false },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));
vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));
vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));
vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

import { coreRoutes } from './core';
import { db } from '../../db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, type SQL } from 'drizzle-orm';

function rigDeviceListRows(
  rows: unknown[],
  // Rows the batched LAN-IP lateral returns (#2503). The handler issues two
  // db.execute calls per request in a fixed order — latest metrics first, then
  // the LAN-IP lookup — so the LAN rig has to be the SECOND queued result.
  lanIpRows: Array<{ device_id: string; ip_address: string }> = [],
) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  // Three base joins plus the opt-in deviceWarranty join (#9863).
  // Each leftJoin returns an object exposing
  // the next leftJoin and the terminal where().
  const chain: Record<string, unknown> = {};
  const leftJoin = vi.fn().mockReturnValue(chain);
  chain.leftJoin = leftJoin;
  chain.where = where;
  const from = vi.fn().mockReturnValue({ leftJoin });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  vi.mocked(db.execute)
    .mockResolvedValue([] as never)
    .mockResolvedValueOnce([] as never)      // latest-metrics lateral
    .mockResolvedValueOnce(lanIpRows as never); // LAN-IP lateral (#2503)
  return { where, leftJoin };
}


describe('GET /devices isolated filter', () => {
  beforeEach(() => vi.clearAllMocks());
  const request = (query: string) => new Hono().route('/devices', coreRoutes).request(`/devices${query}`);
  const render = (where: ReturnType<typeof vi.fn>) => new PgDialect().sqlToQuery(where.mock.calls[0]![0] as SQL);

  it.each(['true', 'false'])('filters isolated=%s without dropping tenant scope', async value => {
    const { where } = rigDeviceListRows([]);
    const response = await request(`?isolated=${value}`);
    expect(response.status).toBe(200);
    const query = render(where);
    expect(query.sql).toContain("EXISTS (SELECT 1 FROM device_network_isolations WHERE device_id = \"devices\".\"id\" AND state NOT IN ('released', 'expired', 'failed', 'uninstalled'))");
    expect(query.sql.includes('NOT (EXISTS')).toBe(value === 'false');
    expect(query.sql).toContain('"devices"."org_id" =');
    expect(query.params).toContain('11111111-1111-4111-8111-111111111111');
    expect(await response.json()).toMatchObject({ data: [] });
  });

  it('does not filter episodes when isolated is absent', async () => {
    const { where } = rigDeviceListRows([]);
    expect((await request('')).status).toBe(200);
    expect(render(where).sql).not.toContain('device_network_isolations');
  });

  it.each(['yes', '1', ''])('rejects invalid boolean %j before querying', async value => {
    expect((await request(`?isolated=${value}`)).status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('still denies a cross-organization filter', async () => {
    expect((await request('?isolated=true&orgId=22222222-2222-4222-8222-222222222222')).status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
