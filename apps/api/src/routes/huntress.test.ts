import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate, permsState } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  permsState: { permissions: undefined as { allowedSiteIds?: string[] } | undefined }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    hostname: 'hostname',
    orgId: 'orgId',
    siteId: 'siteId',
  },
  huntressIntegrations: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    accountId: 'accountId',
    apiBaseUrl: 'apiBaseUrl',
    apiKeyEncrypted: 'apiKeyEncrypted',
    webhookSecretEncrypted: 'webhookSecretEncrypted',
    isActive: 'isActive',
    lastSyncAt: 'lastSyncAt',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    createdBy: 'createdBy',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  huntressAgents: {
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    status: 'status',
  },
  huntressIncidents: {
    id: 'id',
    orgId: 'orgId',
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    huntressIncidentId: 'huntressIncidentId',
    severity: 'severity',
    category: 'category',
    title: 'title',
    description: 'description',
    recommendation: 'recommendation',
    status: 'status',
    reportedAt: 'reportedAt',
    resolvedAt: 'resolvedAt',
    details: 'details',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: vi.fn(() => undefined),
      user: { id: 'user-123', email: 'test@example.com' }
    });
    // NOTE: authMiddleware does NOT populate `permissions` in production — only
    // requirePermission does (auth.ts). Setting it here would mask routes that
    // rely on `c.get('permissions')` for site-scoping but lack a requirePermission
    // gate. Keep this faithful to prod so such gaps fail their site-scope tests.
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Mirror prod: requirePermission is the gate that populates `permissions`.
    c.set('permissions', permsState.permissions);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  })
}));

vi.mock('../jobs/huntressSync', () => ({
  scheduleHuntressSync: vi.fn(async () => 'job-1'),
  ingestHuntressWebhookPayload: vi.fn(async () => ({
    integrationId: 'integration-1',
    fetchedAgents: 0,
    fetchedIncidents: 0,
    upsertedAgents: 0,
    createdIncidents: 0,
    updatedIncidents: 0,
  })),
  findHuntressIntegrationByAccount: vi.fn(async () => ({ status: 'none' as const })),
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string | undefined) => `enc:${value ?? ''}`),
  decryptSecret: vi.fn(() => 'webhook-secret'),
  decryptForColumn: vi.fn(() => 'webhook-secret'),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' }
  },
  canAccessSite: (perms: { allowedSiteIds?: string[] } | undefined, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

import { db } from '../db';
import { findHuntressIntegrationByAccount } from '../jobs/huntressSync';
import { huntressRoutes } from './huntress';

describe('huntress routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    permsState.permissions = undefined;
    app = new Hono();
    app.route('/huntress', huntressRoutes);
  });

  it('rejects integration upsert when permission check fails', async () => {
    permissionGate.deny = true;
    const res = await app.request('/huntress/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Primary Huntress',
        apiKey: 'api-key',
      }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects webhook payloads with missing signature when webhook secret is configured', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
	            id: 'integration-1',
	            orgId: 'org-1',
	            accountId: 'acct-123',
	            webhookSecretEncrypted: 'enc:webhook',
	            isActive: true,
	          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=integration-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(String(body.error)).toContain('signature');
  });

  it('rejects webhook payloads with missing timestamp when signature auth is enabled', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
	            id: 'integration-1',
	            orgId: 'org-1',
	            accountId: 'acct-123',
	            webhookSecretEncrypted: 'enc:webhook',
	            isActive: true,
	          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=integration-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-huntress-signature': 'sha256=abc123',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(String(body.error)).toContain('timestamp');
  });

  it('rejects webhook accountId routing when multiple integrations match', async () => {
    vi.mocked(findHuntressIntegrationByAccount).mockResolvedValueOnce({ status: 'ambiguous' });

    const res = await app.request('/huntress/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-huntress-account-id': 'acct-123',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toContain('integrationId');
  });

  it('rejects explicit integrationId when the payload accountId belongs to another Huntress account', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            id: 'integration-1',
            orgId: 'org-1',
            accountId: 'acct-stored',
            webhookSecretEncrypted: 'enc:webhook',
            isActive: true,
          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=integration-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-huntress-account-id': 'acct-other',
      },
      body: JSON.stringify({ accountId: 'acct-other' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toContain('account');
  });

  describe('GET /incidents site-scope narrowing', () => {
    const ALLOWED_SITE = 'site-allowed';
    const FOREIGN_SITE = 'site-foreign';
    const ALLOWED_DEVICE = '22222222-2222-2222-2222-222222222222';
    const FOREIGN_DEVICE = '33333333-3333-3333-3333-333333333333';

    // Mock the device-resolution select (runs first when site-restricted),
    // returning all org devices with their siteId for the narrowing filter.
    function mockDeviceResolution() {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { id: ALLOWED_DEVICE, siteId: ALLOWED_SITE },
            { id: FOREIGN_DEVICE, siteId: FOREIGN_SITE },
          ]),
        })),
      } as any);
    }

    // Capture the where clause passed to the main incidents query so we can
    // assert how the route narrowed, and return a fixed result set.
    function mockIncidentQuery(captured: { where?: unknown }, rows: unknown[]) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn((w: unknown) => {
              captured.where = w;
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    offset: vi.fn(async () => rows),
                  })),
                })),
              };
            }),
          })),
        })),
      } as any);
      // Count query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ count: rows.length }]),
        })),
      } as any);
    }

    it('returns 403 when a site-restricted caller requests a deviceId outside their allowed sites', async () => {
      permsState.permissions = { allowedSiteIds: [ALLOWED_SITE] };
      mockDeviceResolution();

      const res = await app.request(`/huntress/incidents?deviceId=${FOREIGN_DEVICE}`);

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(String(body.error)).toContain('access denied');
    });

    it('allows a site-restricted caller to request a deviceId within their allowed sites', async () => {
      permsState.permissions = { allowedSiteIds: [ALLOWED_SITE] };
      mockDeviceResolution();
      const captured: { where?: unknown } = {};
      mockIncidentQuery(captured, [
        { id: 'inc-1', deviceId: ALLOWED_DEVICE, title: 'allowed' },
      ]);

      const res = await app.request(`/huntress/incidents?deviceId=${ALLOWED_DEVICE}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('narrows results to allowed devices + provider-level (null-device) incidents for restricted callers', async () => {
      permsState.permissions = { allowedSiteIds: [ALLOWED_SITE] };
      mockDeviceResolution();
      const captured: { where?: unknown } = {};
      // The DB-level narrowing is asserted via the where clause; here we just
      // confirm the route issues the query and returns rows successfully.
      mockIncidentQuery(captured, [
        { id: 'inc-allowed', deviceId: ALLOWED_DEVICE, title: 'allowed-device' },
        { id: 'inc-provider', deviceId: null, title: 'provider-level' },
      ]);

      const res = await app.request('/huntress/incidents');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      // A narrowing condition must have been applied to the main query.
      expect(captured.where).toBeDefined();
    });

    it('still narrows (allowing only null-device incidents) when the caller has no allowed devices', async () => {
      permsState.permissions = { allowedSiteIds: ['site-with-no-devices'] };
      // No org devices match the allowlist.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { id: ALLOWED_DEVICE, siteId: ALLOWED_SITE },
            { id: FOREIGN_DEVICE, siteId: FOREIGN_SITE },
          ]),
        })),
      } as any);
      const captured: { where?: unknown } = {};
      mockIncidentQuery(captured, [
        { id: 'inc-provider', deviceId: null, title: 'provider-level' },
      ]);

      const res = await app.request('/huntress/incidents');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(captured.where).toBeDefined();
    });

    it('does not narrow for unrestricted callers (no device-resolution query issued)', async () => {
      permsState.permissions = undefined; // unrestricted
      const captured: { where?: unknown } = {};
      // Only the main query + count query should be issued (no device resolution).
      mockIncidentQuery(captured, [
        { id: 'inc-1', deviceId: FOREIGN_DEVICE, title: 'foreign-device' },
        { id: 'inc-2', deviceId: null, title: 'provider-level' },
      ]);

      const res = await app.request('/huntress/incidents');

      expect(res.status).toBe(200);
      const body = await res.json();
      // Unrestricted: foreign-device rows remain visible.
      expect(body.data).toHaveLength(2);
      // db.select called exactly twice (main + count), proving no device-resolution query.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    });
  });
});
