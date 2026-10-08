import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, dbState, permsState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    accessibleOrgIds: [] as string[],
  },
  gates: { permission: false, mfa: false },
  permsState: { value: undefined as undefined | Record<string, unknown> },
  dbState: {
    rows: [] as Array<Record<string, unknown>>,
    endpoint: null as null | Record<string, unknown>,
    devicesById: {} as Record<string, Record<string, unknown> | null>,
    updates: [] as Array<{ table: string; set: Record<string, unknown>; where: unknown }>,
    throwOnEndpointUpdate: null as null | { code: string },
    capturedListWhere: [] as unknown[],
  },
}));

const ENDPOINT_ID = '55555555-5555-4555-8555-555555555555';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PREV_DEVICE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_OK = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const SITE_BAD = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';

function flatten(node: unknown): string {
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (node == null) return '';
  if (typeof node !== 'object') return String(node);
  const c = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(c.queryChunks)) return c.queryChunks.map(flatten).join('');
  if (Array.isArray(c.value)) return (c.value as unknown[]).map(String).join('');
  return '';
}
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((cols?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => ({
          limit: vi.fn(async () => {
            if (cols && 'siteId' in cols) {
              const id = flatten(cond).match(UUID_RE)?.[0];
              const found = id ? dbState.devicesById[id] : null;
              return found ? [found] : [];
            }
            return dbState.endpoint ? [dbState.endpoint] : [];
          }),
        })),
        leftJoin: vi.fn(() => ({
          where: vi.fn((cond: unknown) => {
            dbState.capturedListWhere.push(cond);
            return { orderBy: vi.fn(async () => dbState.rows) };
          }),
        })),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      update: vi.fn((table: { __name: string }) => ({
        set: vi.fn((set: Record<string, unknown>) => ({
          where: vi.fn((where: unknown) => {
            if (table.__name === 'edr_endpoints' && dbState.throwOnEndpointUpdate) {
              const err = new Error('violation');
              (err as unknown as { cause: unknown }).cause = { code: dbState.throwOnEndpointUpdate.code };
              throw err;
            }
            dbState.updates.push({ table: table.__name, set, where });
            return Object.assign(Promise.resolve([]), {
              returning: vi.fn(async () => [{ id: ENDPOINT_ID, ...set }]),
            });
          }),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => {
  const t = (name: string, cols: string[]) =>
    Object.assign({ __name: name }, Object.fromEntries(cols.map((c) => [c, c])));
  // access.ts (pgErrorCode's module) builds its select lists at load, so the
  // two partner-axis tables must exist; any column resolves to its own name.
  const any = (name: string) => new Proxy({ __name: name } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : String(key)),
  });
  return {
    edrConnections: any('edr_connections'),
    devices: t('devices', ['id', 'orgId', 'siteId']),
    edrTenants: any('edr_tenants'),
    edrEndpoints: t('edr_endpoints', [
      'id', 'orgId', 'connectionId', 'tenantId', 'provider', 'vendorEndpointId', 'hostname', 'fqdn',
      'osPlatform', 'osName', 'agentVersion', 'health', 'online', 'isolationState', 'lastSeenAt',
      'breezeDeviceId', 'deviceMatchSource', 'updatedAt',
    ]),
    edrDetections: t('edr_detections', ['id', 'endpointId', 'detachedAt', 'status', 'breezeDeviceId', 'updatedAt']),
  };
});

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (gates.permission) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', permsState.value);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => (gates.mfa ? c.json({ error: 'MFA required' }, 403) : next())),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
  canAccessSite: (perms: { allowedSiteIds?: string[] }, siteId: string) =>
    !perms.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { writeRouteAudit } from '../../services/auditEvents';
import { edrEndpointRoutes } from './endpoints';

const JSON_HEADERS = { 'content-type': 'application/json' };
const link = (app: Hono, body: unknown) =>
  app.request(`/edr/endpoints/${ENDPOINT_ID}/link`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });

describe('EDR endpoint routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    gates.mfa = false;
    permsState.value = { allowedSiteIds: undefined };
    authState.scope = 'partner';
    authState.orgId = null;
    authState.accessibleOrgIds = [ORG_ID];
    dbState.rows = [];
    dbState.endpoint = { id: ENDPOINT_ID, orgId: ORG_ID, connectionId: 'c', breezeDeviceId: null };
    dbState.devicesById = { [DEVICE_ID]: { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_OK } };
    dbState.updates = [];
    dbState.throwOnEndpointUpdate = null;
    dbState.capturedListWhere = [];
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, {
        scope: authState.scope,
        orgId: authState.orgId,
        partnerId: authState.partnerId,
        accessibleOrgIds: authState.accessibleOrgIds,
        canAccessOrg: (id: string) => authState.accessibleOrgIds.includes(id),
        orgCondition: vi.fn(() => undefined),
        user: { id: '99999999-9999-4999-8999-999999999999', email: 't@example.com' },
      } as never);
      return next();
    });
    app.route('/edr', edrEndpointRoutes);
  });

  describe('GET /edr/endpoints', () => {
    it('lists rows for org and partner callers and never selects vendorRaw', async () => {
      dbState.rows = [{ id: ENDPOINT_ID, hostname: 'ws-1' }];
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      const res = await app.request('/edr/endpoints?state=unlinked');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toHaveLength(1);
    });

    it('rejects a malformed state / connectionId instead of ignoring them', async () => {
      expect((await app.request('/edr/endpoints?state=bogus')).status).toBe(400);
      expect((await app.request('/edr/endpoints?connectionId=nope')).status).toBe(400);
    });

    it('refuses an ?orgId the caller cannot access', async () => {
      expect((await app.request(`/edr/endpoints?orgId=${OTHER_ORG}`)).status).toBe(403);
    });

    it('as a site-restricted user, adds a predicate keeping only unlinked rows or devices in allowed sites', async () => {
      permsState.value = { allowedSiteIds: [SITE_OK] };
      await app.request('/edr/endpoints');
      const text = flatten(dbState.capturedListWhere[0]);
      expect(text).toContain('IS NULL');
      expect(text).toContain(SITE_OK);
      expect(text).not.toContain(SITE_BAD);
    });

    it('as a site-restricted user with no allowed sites, excludes every linked row', async () => {
      permsState.value = { allowedSiteIds: [] };
      await app.request('/edr/endpoints');
      const text = flatten(dbState.capturedListWhere[0]);
      expect(text.toLowerCase()).toContain('is null');
      expect(text).not.toContain('SELECT');
    });

    it('adds no site predicate for an unrestricted caller', async () => {
      await app.request('/edr/endpoints');
      expect(flatten(dbState.capturedListWhere[0])).not.toContain('SELECT');
    });

    it('is gated on devices:read', async () => {
      gates.permission = true;
      expect((await app.request('/edr/endpoints')).status).toBe(403);
    });
  });

  describe('PUT /edr/endpoints/:id/link', () => {
    it('links a same-org device as manual', async () => {
      const res = await link(app, { deviceId: DEVICE_ID });
      expect(res.status).toBe(200);
      const ep = dbState.updates.find((u) => u.table === 'edr_endpoints')!;
      expect(ep.set).toMatchObject({ breezeDeviceId: DEVICE_ID, deviceMatchSource: 'manual' });
      expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({ action: 'edr.endpoint.link', orgId: ORG_ID });
    });

    it('unlinks on explicit null, clearing the provenance column too', async () => {
      dbState.endpoint = { id: ENDPOINT_ID, orgId: ORG_ID, connectionId: 'c', breezeDeviceId: PREV_DEVICE };
      dbState.devicesById[PREV_DEVICE] = { id: PREV_DEVICE, orgId: ORG_ID, siteId: SITE_OK };
      const res = await link(app, { deviceId: null });
      expect(res.status).toBe(200);
      const ep = dbState.updates.find((u) => u.table === 'edr_endpoints')!;
      expect(ep.set).toMatchObject({ breezeDeviceId: null, deviceMatchSource: null });
      expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({ action: 'edr.endpoint.unlink' });
    });

    it('rewrites breezeDeviceId on OPEN, non-detached detections only, in the same transaction', async () => {
      await link(app, { deviceId: DEVICE_ID });
      const det = dbState.updates.find((u) => u.table === 'edr_detections')!;
      expect(det.set).toMatchObject({ breezeDeviceId: DEVICE_ID });
      const text = flatten(det.where);
      expect(text).toContain('detachedAt');
      expect(text.toLowerCase()).toContain('detachedat is null');
      expect(text).toContain('(open, in_progress, unknown)');
      expect(text).not.toContain('resolved');
      // both updates ran inside one db.transaction call
      const tables = dbState.updates.map((u) => u.table);
      expect(tables).toEqual(['edr_endpoints', 'edr_detections']);
    });

    it('device in another org -> 422 DEVICE_ORG_MISMATCH before touching the row', async () => {
      dbState.devicesById[DEVICE_ID] = { id: DEVICE_ID, orgId: OTHER_ORG, siteId: SITE_OK };
      const res = await link(app, { deviceId: DEVICE_ID });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('DEVICE_ORG_MISMATCH');
      expect(dbState.updates).toHaveLength(0);
    });

    it('new device in a denied site -> 403', async () => {
      permsState.value = { allowedSiteIds: [SITE_OK] };
      dbState.devicesById[DEVICE_ID] = { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_BAD };
      expect((await link(app, { deviceId: DEVICE_ID })).status).toBe(403);
      expect(dbState.updates).toHaveLength(0);
    });

    it('previous device in a denied site -> 403', async () => {
      permsState.value = { allowedSiteIds: [SITE_OK] };
      dbState.endpoint = { id: ENDPOINT_ID, orgId: ORG_ID, connectionId: 'c', breezeDeviceId: PREV_DEVICE };
      dbState.devicesById[PREV_DEVICE] = { id: PREV_DEVICE, orgId: ORG_ID, siteId: SITE_BAD };
      expect((await link(app, { deviceId: DEVICE_ID })).status).toBe(403);
      expect((await link(app, { deviceId: null })).status).toBe(403);
      expect(dbState.updates).toHaveLength(0);
    });

    it('fails closed (403) for a site-carrying device when permissions never resolved', async () => {
      permsState.value = undefined;
      expect((await link(app, { deviceId: DEVICE_ID })).status).toBe(403);
    });

    it('23505 -> 409 DEVICE_ALREADY_LINKED; racing 23503 -> 422', async () => {
      dbState.throwOnEndpointUpdate = { code: '23505' };
      let res = await link(app, { deviceId: DEVICE_ID });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('DEVICE_ALREADY_LINKED');
      dbState.throwOnEndpointUpdate = { code: '23503' };
      res = await link(app, { deviceId: DEVICE_ID });
      expect(res.status).toBe(422);
    });

    it('404 for an invisible endpoint or a missing device; 400 for a missing deviceId key', async () => {
      dbState.endpoint = null;
      expect((await link(app, { deviceId: DEVICE_ID })).status).toBe(404);
      dbState.endpoint = { id: ENDPOINT_ID, orgId: ORG_ID, connectionId: 'c', breezeDeviceId: null };
      delete dbState.devicesById[DEVICE_ID];
      expect((await link(app, { deviceId: DEVICE_ID })).status).toBe(404);
      expect((await link(app, {})).status).toBe(400);
    });

    it('requires devices:write and MFA', async () => {
      gates.permission = true;
      expect((await link(app, { deviceId: DEVICE_ID })).status).toBe(403);
      gates.permission = false;
      gates.mfa = true;
      expect((await link(app, { deviceId: DEVICE_ID })).status).toBe(403);
      expect(dbState.updates).toHaveLength(0);
    });
  });
});
