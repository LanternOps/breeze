// apps/api/src/routes/backup/health.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A = '11111111-1111-4111-8111-111111111111';

const listMock = vi.fn();
const summarizeMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../services/backupHealthReadModel', () => ({
  listBackupHealthRows: (...a: unknown[]) => listMock(...(a as [])),
  summarizeBackupHealth: (...a: unknown[]) => summarizeMock(...(a as [])),
}));
vi.mock('../../middleware/auth', () => ({ requirePermission: vi.fn(() => (c: any, next: any) => next()) }));
vi.mock('../../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...(a as [])) } }));
vi.mock('../../db/schema', () => ({
  backupProviderConnections: { partnerId: 'bpn.partner_id', isActive: 'bpn.is_active', lastSyncUnmappedDevices: 'bpn.last_sync_unmapped_devices', lastSyncAt: 'bpn.last_sync_at', syncIntervalMinutes: 'bpn.sync_interval_minutes' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ op: 'and', conditions: c.filter(Boolean) }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
}));

import { backupHealthRoutes } from './health';

const emptySummary = {
  endpoints: { total: 0, covered: 0, uncovered: 0 },
  providerOnly: 0, m365Accounts: 0,
  byStatus: {}, byHealth: {}, byRecency: {},
};

let authState: any;
let permissionsState: any;

function chain(rows: unknown[]) {
  const c: Record<string, any> = {};
  for (const m of ['from', 'where', 'limit']) c[m] = vi.fn(() => Object.assign(Promise.resolve(rows), c));
  c.then = (ok: any, err: any) => Promise.resolve(rows).then(ok, err);
  return c;
}

describe('GET /backup/health/devices', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ rows: [], nextCursor: null });
    summarizeMock.mockResolvedValue(emptySummary);
    selectMock.mockImplementation(() => chain([]));
    authState = {
      scope: 'partner', orgId: null, partnerId: 'p1',
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: (id: string) => [ORG_A, ORG_B].includes(id),
      allowedSiteIds: undefined,
      user: { id: 'u1' },
    };
    permissionsState = undefined;
    app = new Hono();
    app.use('*', async (c: any, next) => {
      c.set('auth', authState);
      if (permissionsState) c.set('permissions', permissionsState);
      await next();
    });
    app.route('/backup', backupHealthRoutes);
  });

  it('defaults to every accessible org when no orgId is given', async () => {
    const res = await app.request('/backup/health/devices');
    expect(res.status).toBe(200);
    expect(listMock.mock.calls[0]![0]).toEqual({ orgIds: [ORG_A, ORG_B], siteIds: undefined });
  });

  it('narrows to one org when orgId is given and accessible', async () => {
    await app.request(`/backup/health/devices?orgId=${ORG_A}`);
    expect(listMock.mock.calls[0]![0]).toMatchObject({ orgIds: [ORG_A] });
  });

  it('403s for an inaccessible orgId rather than silently narrowing to nothing', async () => {
    const res = await app.request('/backup/health/devices?orgId=99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('400s for a system-scope caller with no orgId (accessibleOrgIds is null = all orgs)', async () => {
    authState.scope = 'system';
    authState.accessibleOrgIds = null;
    const res = await app.request('/backup/health/devices');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgId is required for this scope' });
  });

  it('passes the site ceiling from auth into the scope', async () => {
    authState.allowedSiteIds = [SITE_A];
    await app.request('/backup/health/devices');
    expect(listMock.mock.calls[0]![0]).toEqual({ orgIds: [ORG_A, ORG_B], siteIds: [SITE_A] });
  });

  it('falls back to the permissions context when auth carries no site ceiling', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    await app.request('/backup/health/devices');
    expect(listMock.mock.calls[0]![0]).toMatchObject({ siteIds: [SITE_A] });
  });

  it('parses the filter query into read-model options', async () => {
    await app.request(
      `/backup/health/devices?source=provider&health=critical,warning&status=failed&withBackup=false&search=srv&limit=25&cursor=abc`,
    );
    expect(listMock.mock.calls[0]![1]).toMatchObject({
      sources: ['provider'],
      onlyWithBackup: false,
      filter: { health: ['critical', 'warning'], status: ['failed'], search: 'srv' },
      page: { limit: 25, cursor: 'abc' },
    });
  });

  it('defaults withBackup to true, matching the Cove-email view', async () => {
    await app.request('/backup/health/devices');
    expect(listMock.mock.calls[0]![1]).toMatchObject({ onlyWithBackup: true });
  });

  it('caps limit at BACKUP_HEALTH_MAX_LIMIT', async () => {
    const res = await app.request('/backup/health/devices?limit=5000');
    expect(res.status).toBe(400); // zod max
  });

  it('422s on an unknown health value instead of silently ignoring it', async () => {
    const res = await app.request('/backup/health/devices?health=green');
    expect(res.status).toBe(400);
  });

  it('returns rows, summary and nextCursor under data', async () => {
    listMock.mockResolvedValue({ rows: [{ key: 'breeze:1', stale: false }], nextCursor: 'next' });
    const res = await app.request('/backup/health/devices');
    expect(await res.json()).toMatchObject({
      data: { rows: [{ key: 'breeze:1' }], summary: emptySummary, nextCursor: 'next', stale: false, unmappedDevices: 0 },
    });
  });

  it('reports stale:true when any returned row is stale', async () => {
    listMock.mockResolvedValue({ rows: [{ key: 'provider:1', stale: true }], nextCursor: null });
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.stale).toBe(true);
  });

  it('rolls up unmappedDevices across the partner active connections for a partner caller', async () => {
    selectMock.mockImplementation(() => chain([{ unmapped: 4, isActive: true, lastSyncAt: null, syncIntervalMinutes: 30 }, { unmapped: 3, isActive: true, lastSyncAt: null, syncIntervalMinutes: 30 }]));
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.unmappedDevices).toBe(7);
  });

  it('reports unmappedDevices 0 for an org-scope caller, which cannot read connections', async () => {
    authState.scope = 'organization';
    authState.orgId = ORG_A;
    authState.accessibleOrgIds = [ORG_A];
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.unmappedDevices).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns an empty payload without querying when the site ceiling is empty', async () => {
    authState.allowedSiteIds = [];
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.rows).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });
});
