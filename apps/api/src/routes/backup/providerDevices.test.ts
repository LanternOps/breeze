import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

const { authState, gates, dbState, permsState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
  },
  gates: { permission: false, mfa: false },
  permsState: { value: { allowedSiteIds: undefined as string[] | undefined } as Record<string, unknown> },
  dbState: {
    rows: [] as Array<Record<string, unknown>>,
    device: null as null | Record<string, unknown>,
    // Keyed by device id — devices-table selects (previous device, new
    // device) resolve to whichever fixture matches the id actually bound
    // into the where() condition, since the route now looks up TWO distinct
    // devices in the same shape ({id, siteId}). Falls back to `device` above
    // when a test hasn't populated this map (keeps older tests unchanged).
    devicesById: {} as Record<string, Record<string, unknown> | null>,
    /** Org-wide devices list — only consulted by the GET /devices site-ceiling resolution. */
    orgDevices: [] as Array<{ id: string; siteId: string | null }>,
    providerRow: null as null | Record<string, unknown>,
    updated: [] as Array<Record<string, unknown>>,
    orgConditions: [] as unknown[],
    throwOnUpdate: null as null | { code: string },
    // Defense-in-depth: this mock's list `.where()` ignores the condition it's
    // given and returns every seeded row regardless, so deleting the
    // `orgCondition`/explicit-`orgId` tenant clause from the route would keep
    // the whole mocked suite green. RLS is the real backstop; this captures
    // the built condition so a test can assert the org column is referenced.
    capturedListWhere: [] as unknown[],
  },
}));

/** True if the drizzle condition's SQL tree references a leaf equal to `marker` (a mocked schema column is a plain string, e.g. 'org_id'). */
function referencesColumn(node: unknown, marker: string): boolean {
  if (node === marker) return true;
  if (node && typeof node === 'object' && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
    return (node as { queryChunks: unknown[] }).queryChunks.some((c) => referencesColumn(c, marker));
  }
  return false;
}

/**
 * The bound id in an `eq(devices.id, <id>)` condition. The mocked schema uses
 * plain strings for columns (not real drizzle Column instances), so drizzle's
 * `eq()` never wraps the value in an `encoder`-carrying Param — it inlines the
 * raw value into a queryChunks StringChunk instead (confirmed against
 * drizzle-orm 0.45.2). Render the condition's text and pull out the UUID.
 */
function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (node == null) return '';
  if (typeof node !== 'object') return String(node);
  const c = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(c.queryChunks)) return c.queryChunks.map(flattenText).join('');
  if (Array.isArray(c.value)) return (c.value as unknown[]).map(String).join('');
  return '';
}
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function boundId(node: unknown): string | undefined {
  return flattenText(node).match(UUID_RE)?.[0];
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((cols?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => {
          // Single-device lookup by id (previous device / new device — always
          // chains .limit(1)): resolve from devicesById, falling back to the
          // single `device` fixture so pre-existing tests need no changes.
          const singleDeviceRows = () => {
            const id = boundId(cond);
            if (typeof id === 'string' && id in dbState.devicesById) {
              const found = dbState.devicesById[id];
              return found ? [found] : [];
            }
            return dbState.device ? [dbState.device] : [];
          };
          return {
            limit: vi.fn(async () => (cols && 'siteId' in cols ? singleDeviceRows() : (dbState.providerRow ? [dbState.providerRow] : []))),
            orderBy: vi.fn(async () => dbState.rows),
            // The site-ceiling org-wide devices list (no .limit()/.orderBy()
            // chained — the route just `await`s the query directly).
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.orgDevices).then(resolve),
          };
        }),
        leftJoin: vi.fn(() => ({
          where: vi.fn((cond: unknown) => {
            dbState.capturedListWhere.push(cond);
            return { orderBy: vi.fn(async () => dbState.rows) };
          }),
        })),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      update: vi.fn(() => ({
        set: vi.fn((v: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (dbState.throwOnUpdate) {
                const err = new Error('violates foreign key constraint');
                (err as unknown as { cause: unknown }).cause = { code: dbState.throwOnUpdate.code };
                throw err;
              }
              dbState.updated.push(v);
              return [{ id: PROVIDER_ROW_ID, ...v }];
            }),
          })),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  backupProviderDevices: {
    id: 'id', orgId: 'org_id', connectionId: 'connection_id', customerId: 'customer_id',
    provider: 'provider', vendorDeviceId: 'vendor_device_id', vendorDeviceName: 'vendor_device_name',
    computerName: 'computer_name', osType: 'os_type', accountType: 'account_type',
    status: 'status', lastSuccessAt: 'last_success_at', lastSessionAt: 'last_session_at',
    selectedBytes: 'selected_bytes', usedBytes: 'used_bytes', errorsCount: 'errors_count',
    dataSources: 'data_sources', breezeDeviceId: 'breeze_device_id',
    deviceMatchSource: 'device_match_source', updatedAt: 'updated_at',
  },
  backupProviderCustomers: { id: 'id', vendorCustomerName: 'vendor_customer_name' },
  // providerDevices.ts now imports `pgErrorCode` from `./providerAccess`,
  // which computes `CONNECTION_PUBLIC_SELECT` eagerly at module load and
  // needs this export to exist, even though this route file never uses it.
  backupProviderConnections: {
    id: 'id', partnerId: 'partner_id', provider: 'provider', name: 'name', baseUrl: 'base_url',
    credentialsEncrypted: 'credentials_encrypted', vendorRootId: 'vendor_root_id',
    vendorRootName: 'vendor_root_name', isActive: 'is_active', status: 'status',
    syncIntervalMinutes: 'sync_interval_minutes', showProviderNameInPortal: 'show_provider_name_in_portal',
    lastSyncAt: 'last_sync_at', lastSyncStatus: 'last_sync_status', lastSyncError: 'last_sync_error',
    lastSyncCustomers: 'last_sync_customers', lastSyncUnmappedCustomers: 'last_sync_unmapped_customers',
    lastSyncDevices: 'last_sync_devices', lastSyncUnmappedDevices: 'last_sync_unmapped_devices',
    lastSyncLinkedDevices: 'last_sync_linked_devices', lastSyncAmbiguousDevices: 'last_sync_ambiguous_devices',
    createdBy: 'created_by', createdAt: 'created_at', updatedAt: 'updated_at',
  },
  devices: { id: 'id', orgId: 'org_id', hostname: 'hostname', displayName: 'display_name' },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) =>
    gates.permission ? c.json({ error: 'Forbidden' }, 403) : next()),
  requireMfa: vi.fn(() => async (c: any, next: any) =>
    gates.mfa ? c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403) : next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BACKUP_READ: { resource: 'backup', action: 'read' },
    BACKUP_WRITE: { resource: 'backup', action: 'write' },
  },
  // Faithful to the real implementation: unrestricted (no allowedSiteIds)
  // always passes; otherwise the site must be in the allowlist.
  canAccessSite: (perms: { allowedSiteIds?: string[] | null } | undefined, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { backupProviderDeviceRoutes } from './providerDevices';

const PROVIDER_ROW_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '77777777-7777-4777-8777-777777777777';

describe('backup provider device routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    gates.mfa = false;
    authState.scope = 'partner';
    authState.orgId = null;
    authState.accessibleOrgIds = [ORG_ID];
    dbState.rows = [];
    dbState.device = { id: DEVICE_ID, orgId: ORG_ID, hostname: 'srv-fs01', siteId: null };
    dbState.devicesById = {};
    dbState.orgDevices = [];
    dbState.providerRow = { id: PROVIDER_ROW_ID, orgId: ORG_ID, breezeDeviceId: null };
    dbState.updated = [];
    dbState.orgConditions = [];
    dbState.throwOnUpdate = null;
    dbState.capturedListWhere = [];
    permsState.value = { allowedSiteIds: undefined };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        principal: { kind: 'user_session' },
        scope: authState.scope,
        orgId: authState.orgId,
        partnerId: authState.partnerId,
        accessibleOrgIds: authState.accessibleOrgIds,
        canAccessOrg: (id: string) => authState.accessibleOrgIds.includes(id),
        // Returns a REAL scoping condition (not `undefined`, as a no-op mock
        // would) so the "does the returned condition actually reach the
        // query" defense-in-depth test below has something to find.
        orgCondition: vi.fn((col: unknown) => {
          dbState.orgConditions.push(col);
          // Returns a REAL scoping condition (not `undefined`, as a no-op
          // mock would) so the "does the returned condition actually reach
          // the query" defense-in-depth test below has something to find. The
          // mocked schema column is a plain string ('org_id'), which `eq`
          // isn't typed to accept — cast through `unknown`, same as the
          // string-keyed schema mocks elsewhere in this file.
          return eq('org_id' as unknown as Parameters<typeof eq>[0], '__scoped__');
        }),
        user: { id: '99999999-9999-4999-8999-999999999999', email: 't@example.com', name: 'Test Tech', isPlatformAdmin: false },
        token: null,
      });
      c.set('permissions', permsState.value as any);
      await next();
    });
    app.route('/backup/providers', backupProviderDeviceRoutes);
  });

  describe('GET /devices', () => {
    it('scopes by auth.orgCondition when no orgId is given (all accessible orgs)', async () => {
      const res = await app.request('/backup/providers/devices');
      expect(res.status).toBe(200);
      expect(dbState.orgConditions).toHaveLength(1);
      // Defense-in-depth: prove the condition orgCondition() RETURNED actually
      // flows into the query, not just that the function was called.
      expect(dbState.capturedListWhere).toHaveLength(1);
      expect(referencesColumn(dbState.capturedListWhere[0], 'org_id')).toBe(true);
    });

    it('honours an explicit accessible ?orgId', async () => {
      const res = await app.request(`/backup/providers/devices?orgId=${ORG_ID}`);
      expect(res.status).toBe(200);
      // Defense-in-depth: the explicit-orgId path builds its OWN condition
      // (`eq(backupProviderDevices.orgId, query.orgId)`) rather than calling
      // auth.orgCondition — prove that one reaches the query too.
      expect(dbState.capturedListWhere).toHaveLength(1);
      expect(referencesColumn(dbState.capturedListWhere[0], 'org_id')).toBe(true);
    });

    it('refuses an ?orgId the caller cannot access', async () => {
      const res = await app.request(`/backup/providers/devices?orgId=${OTHER_ORG_ID}`);
      expect(res.status).toBe(403);
    });

    it('rejects a malformed ?orgId', async () => {
      const res = await app.request('/backup/providers/devices?orgId=not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('rejects a malformed ?linked value instead of silently ignoring it', async () => {
      const res = await app.request('/backup/providers/devices?linked=maybe');
      expect(res.status).toBe(400);
    });

    it('is gated on backup:read', async () => {
      gates.permission = true;
      const res = await app.request('/backup/providers/devices');
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /devices/:id/link', () => {
    it('links a device in the SAME org', async () => {
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(200);
      expect(dbState.updated[0]).toMatchObject({ breezeDeviceId: DEVICE_ID, deviceMatchSource: 'manual' });
    });

    it('unlinks on an explicit null, clearing the provenance column too', async () => {
      dbState.providerRow = { id: PROVIDER_ROW_ID, orgId: ORG_ID, breezeDeviceId: DEVICE_ID };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: null }),
      });
      expect(res.status).toBe(200);
      // Leaving device_match_source = 'manual' behind would make W02's matcher
      // skip the row forever (manual links are never re-matched).
      expect(dbState.updated[0]).toMatchObject({ breezeDeviceId: null, deviceMatchSource: null });
    });

    it('PRE-CHECKS a cross-org device and refuses with 422 before touching the row', async () => {
      dbState.device = { id: DEVICE_ID, orgId: OTHER_ORG_ID, hostname: 'srv-other' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(422);
      expect(dbState.updated).toHaveLength(0);
    });

    it('maps a racing 23503 from the composite FK to 422, not a 500', async () => {
      dbState.throwOnUpdate = { code: '23503' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(422);
    });

    it('maps a 23505 from the one-row-per-device index to 409', async () => {
      dbState.throwOnUpdate = { code: '23505' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(409);
    });

    it('runs the write inside a nested transaction (savepoint) so the caught error does not poison the request', async () => {
      const { db } = await import('../../db');
      await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(db.transaction).toHaveBeenCalled();
    });

    it('404s for a provider row the caller cannot see', async () => {
      dbState.providerRow = null;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(404);
    });

    it('404s when the target device does not exist', async () => {
      dbState.device = null;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects a missing deviceId key rather than silently unlinking', async () => {
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('is gated on backup:write', async () => {
      gates.permission = true;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: null }),
      });
      expect(res.status).toBe(403);
    });

    it('requires MFA', async () => {
      gates.mfa = true;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MFA_REQUIRED');
      expect(dbState.updated).toHaveLength(0);
    });

    it('refuses to link a device outside the caller\'s allowed sites', async () => {
      permsState.value = { allowedSiteIds: ['site-allowed'] };
      dbState.device = { id: DEVICE_ID, orgId: ORG_ID, siteId: 'site-hidden' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(403);
      expect(dbState.updated).toHaveLength(0);
    });

    it('allows linking a device inside the caller\'s allowed sites', async () => {
      permsState.value = { allowedSiteIds: ['site-allowed'] };
      dbState.device = { id: DEVICE_ID, orgId: ORG_ID, siteId: 'site-allowed' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(200);
    });

    it('refuses to unlink (or relink) away from a PREVIOUS device outside the caller\'s allowed sites', async () => {
      const previousDeviceId = '88888888-8888-4888-8888-888888888888';
      dbState.providerRow = { id: PROVIDER_ROW_ID, orgId: ORG_ID, breezeDeviceId: previousDeviceId };
      dbState.devicesById[previousDeviceId] = { id: previousDeviceId, siteId: 'site-hidden' };
      permsState.value = { allowedSiteIds: ['site-allowed'] };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: null }),
      });
      expect(res.status).toBe(403);
      expect(dbState.updated).toHaveLength(0);
    });

    it('allows unlinking a PREVIOUS device inside the caller\'s allowed sites', async () => {
      const previousDeviceId = '88888888-8888-4888-8888-888888888888';
      dbState.providerRow = { id: PROVIDER_ROW_ID, orgId: ORG_ID, breezeDeviceId: previousDeviceId };
      dbState.devicesById[previousDeviceId] = { id: previousDeviceId, siteId: 'site-allowed' };
      permsState.value = { allowedSiteIds: ['site-allowed'] };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: null }),
      });
      expect(res.status).toBe(200);
    });

    it('fails closed (403) linking a site-carrying device when permissions never resolved', async () => {
      permsState.value = undefined as unknown as Record<string, unknown>;
      dbState.device = { id: DEVICE_ID, orgId: ORG_ID, siteId: 'site-allowed' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(403);
      expect(dbState.updated).toHaveLength(0);
    });

    it('fails closed (403) unlinking away from a site-carrying PREVIOUS device when permissions never resolved', async () => {
      const previousDeviceId = '88888888-8888-4888-8888-888888888888';
      dbState.providerRow = { id: PROVIDER_ROW_ID, orgId: ORG_ID, breezeDeviceId: previousDeviceId };
      dbState.devicesById[previousDeviceId] = { id: previousDeviceId, siteId: 'site-allowed' };
      permsState.value = undefined as unknown as Record<string, unknown>;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: null }),
      });
      expect(res.status).toBe(403);
      expect(dbState.updated).toHaveLength(0);
    });
  });

  describe('GET /devices — site ceiling', () => {
    it('intersects the list condition with the allowed-site device set (org-scoped, site-restricted)', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      permsState.value = { allowedSiteIds: ['site-allowed'] };
      dbState.orgDevices = [
        { id: 'aaaaaaaa-0000-4000-8000-000000000001', siteId: 'site-allowed' },
        { id: 'bbbbbbbb-0000-4000-8000-000000000002', siteId: 'site-hidden' },
      ];
      const res = await app.request('/backup/providers/devices');
      expect(res.status).toBe(200);
      // The site-derived condition reaches the actual list query (not just a
      // resolution step that never gets wired in): it references the
      // breeze_device_id column, includes the ALLOWED device's id, and does
      // NOT include the HIDDEN device's id.
      expect(dbState.capturedListWhere).toHaveLength(1);
      const where = dbState.capturedListWhere[0];
      expect(referencesColumn(where, 'breeze_device_id')).toBe(true);
      const text = flattenText(where);
      expect(text).toContain('aaaaaaaa-0000-4000-8000-000000000001');
      expect(text).not.toContain('bbbbbbbb-0000-4000-8000-000000000002');
    });

    it('excludes every linked row (isNull only) when no site is allowed', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      permsState.value = { allowedSiteIds: [] };
      dbState.orgDevices = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', siteId: 'site-hidden' }];
      const res = await app.request('/backup/providers/devices');
      expect(res.status).toBe(200);
      const text = flattenText(dbState.capturedListWhere[0]);
      expect(text).not.toContain('aaaaaaaa-0000-4000-8000-000000000001');
    });

    it('does not apply a site filter for an unrestricted caller', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      permsState.value = { allowedSiteIds: undefined };
      dbState.orgDevices = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', siteId: 'site-hidden' }];
      const res = await app.request('/backup/providers/devices');
      expect(res.status).toBe(200);
      expect(referencesColumn(dbState.capturedListWhere[0], 'breeze_device_id')).toBe(false);
    });
  });
});
