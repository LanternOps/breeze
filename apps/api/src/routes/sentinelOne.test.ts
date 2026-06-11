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
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', orgId: 'orgId', hostname: 'hostname', siteId: 'siteId' },
  s1Actions: {
    id: 'id',
    orgId: 'orgId',
    deviceId: 'deviceId',
    status: 'status',
    requestedAt: 'requestedAt',
    completedAt: 'completedAt',
    providerActionId: 'providerActionId',
    action: 'action'
  },
  s1Agents: {
    id: 'id',
    orgId: 'orgId',
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    s1AgentId: 's1AgentId',
    infected: 'infected',
    threatCount: 'threatCount'
  },
  s1Integrations: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    managementUrl: 'managementUrl',
    apiTokenEncrypted: 'apiTokenEncrypted',
    isActive: 'isActive',
    lastSyncAt: 'lastSyncAt',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    createdBy: 'createdBy'
  },
  s1Threats: {
    id: 'id',
    s1ThreatId: 's1ThreatId',
    orgId: 'orgId',
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    detectedAt: 'detectedAt',
    updatedAt: 'updatedAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: () => undefined,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Mirror prod: requirePermission (not authMiddleware) populates `permissions`.
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

vi.mock('../jobs/s1Sync', () => ({
  isThreatAction: vi.fn(() => true),
  scheduleS1Sync: vi.fn()
}));

vi.mock('../services/sentinelOne/actions', () => ({
  executeS1IsolationForOrg: vi.fn(),
  executeS1ThreatActionForOrg: vi.fn(),
  getActiveS1IntegrationForOrg: vi.fn()
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string | undefined) => `enc:${value ?? ''}`)
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
    DEVICES_READ: { resource: 'devices', action: 'read' }
  },
  // Faithful to the real implementation: unrestricted callers (no
  // allowedSiteIds) always pass; otherwise the site must be in the allowlist.
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId)
}));

import { sentinelOneRoutes } from './sentinelOne';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
  executeS1IsolationForOrg,
  executeS1ThreatActionForOrg,
  getActiveS1IntegrationForOrg
} from '../services/sentinelOne/actions';
import { encryptSecret } from '../services/secretCrypto';

describe('sentinel one routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;

    app = new Hono();
    app.route('/s1', sentinelOneRoutes);
  });

  it('rejects integration save when permission check fails', async () => {
    permissionGate.deny = true;

    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://example.sentinelone.net',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(403);
  });

  it('fails integration save when token encryption fails', async () => {
    vi.mocked(encryptSecret).mockReturnValueOnce(null);

    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://example.sentinelone.net',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(500);
  });

  it('rejects non-HTTPS management URLs', async () => {
    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'http://example.sentinelone.net',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects management URLs not on the sentinelone.net allowlist (SSRF)', async () => {
    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://internal-vault.cluster.local/',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects management URLs pointing at cloud-metadata (SSRF)', async () => {
    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://169.254.169.254/latest/meta-data/',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(400);
  });

  it('requires token re-entry when changing the SentinelOne management host', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            id: 'integration-1',
            managementUrl: 'https://old.sentinelone.net',
            apiTokenEncrypted: 'enc:stored-token'
          }])
        }))
      }))
    } as any);

    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://new.sentinelone.net'
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('re-entered');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects isolate action when MFA check fails', async () => {
    mfaGate.deny = true;

    const res = await app.request('/s1/isolate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111']
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects cross-org status access', async () => {
    const res = await app.request('/s1/status?orgId=22222222-2222-2222-2222-222222222222');
    expect(res.status).toBe(403);
  });

  it('returns warning when isolate dispatch has no provider activity id', async () => {
    vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
      id: 'int-1',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'S1',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null
    } as any);
    vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        requestedDeviceIds: ['11111111-1111-1111-1111-111111111111'],
        inaccessibleDeviceIds: [],
        unmappedAccessibleDeviceIds: [],
        requestedDevices: 1,
        mappedAgents: 1,
        providerActionId: null,
        actions: [{ id: 'action-1', deviceId: '11111111-1111-1111-1111-111111111111' }],
        warning: 'Provider did not return activityId; action cannot be tracked'
      }
    } as any);

    const res = await app.request('/s1/isolate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111']
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toEqual(['Provider did not return activityId; action cannot be tracked']);
    expect(body.data.providerActionId).toBeNull();
  });

  it('returns 502 with persisted action details when isolate dispatch fails', async () => {
    vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
      id: 'int-1',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'S1',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null
    } as any);
    vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
      ok: true,
      status: 502,
      data: {
        requestedDeviceIds: ['11111111-1111-1111-1111-111111111111'],
        inaccessibleDeviceIds: [],
        unmappedAccessibleDeviceIds: [],
        requestedDevices: 1,
        mappedAgents: 1,
        providerActionId: null,
        actions: [{ id: 'action-err-1', deviceId: '11111111-1111-1111-1111-111111111111' }],
        warning: 'SentinelOne action dispatch failed: provider timeout'
      }
    } as any);

    const res = await app.request('/s1/isolate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111']
      })
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('SentinelOne action dispatch failed');
    expect(body.data.actions).toHaveLength(1);
  });

  it('returns partial threat action results with unmatched threat ids', async () => {
    vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
      id: 'int-1',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'S1',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null
    } as any);
    vi.mocked(executeS1ThreatActionForOrg).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        action: 'kill',
        requestedThreats: 2,
        matchedThreats: 1,
        matchedThreatIds: ['s1-threat-1'],
        unmatchedThreatIds: ['missing-threat'],
        providerActionId: 'activity-1',
        actions: [{ id: 'action-1', deviceId: 'device-1' }]
      }
    } as any);

    const res = await app.request('/s1/threat-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'kill',
        threatIds: ['s1-threat-1', 'missing-threat']
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.unmatchedThreatIds).toEqual(['missing-threat']);
    expect(body.data.matchedThreatIds).toEqual(['s1-threat-1']);
  });

  // ───────────────────── GET /threats — site scope ─────────────────────
  // A site-restricted org user (permissions.allowedSiteIds set) must not list
  // SentinelOne threats (or device hostnames) for devices in sites outside
  // their allowlist, nor target a foreign-site device via ?deviceId=.
  // Site is an app-layer concept only — Postgres RLS does not defend it.
  describe('GET /threats — site scope', () => {
    const ORG_ID = '11111111-1111-1111-1111-111111111111';
    const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
    const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
    const DEVICE_ALLOWED = '33333333-3333-3333-3333-333333333333';
    const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';

    function setAuth(allowedSiteIds?: string[]) {
      // `permissions` is populated by requirePermission (see global mock), not
      // authMiddleware — faithful to prod, so a route lacking the permission
      // gate will not receive site scoping and its tests will fail.
      permsState.permissions = allowedSiteIds ? { allowedSiteIds } : undefined;
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          orgId: ORG_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID,
          orgCondition: () => undefined,
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
    }
    const setRestricted = (allowedSiteIds: string[]) => setAuth(allowedSiteIds);

    // Mocks the device-resolution query a restricted reader runs first:
    // db.select({id, siteId}).from(devices).where(...) → rows
    function mockDeviceResolution(rows: Array<{ id: string; siteId: string | null }>) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows)
        })
      } as any);
    }

    // Mocks the main threats list select (leftJoin) + count select.
    function mockThreatsQueries(rows: any[], count: number) {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue(rows)
                  })
                })
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count }])
          })
        } as any);
    }

    it('denies an explicit deviceId outside the caller site allowlist (403)', async () => {
      setRestricted([SITE_ALLOWED]);
      mockDeviceResolution([{ id: DEVICE_DENIED, siteId: SITE_DENIED }]);

      const res = await app.request(`/s1/threats?deviceId=${DEVICE_DENIED}`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Device not found or access denied');
    });

    it('narrows the broad list to the caller accessible devices', async () => {
      setRestricted([SITE_ALLOWED]);
      // First select: device resolution (only DEVICE_ALLOWED is in-scope)
      mockDeviceResolution([
        { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
        { id: DEVICE_DENIED, siteId: SITE_DENIED }
      ]);
      // Then the threats list + count
      mockThreatsQueries(
        [{ id: 'threat-1', deviceId: DEVICE_ALLOWED, deviceName: 'PC-01' }],
        1
      );

      const res = await app.request('/s1/threats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(DEVICE_ALLOWED);
    });

    it('allows an explicit in-scope deviceId for a restricted caller', async () => {
      setRestricted([SITE_ALLOWED]);
      mockDeviceResolution([{ id: DEVICE_ALLOWED, siteId: SITE_ALLOWED }]);
      mockThreatsQueries(
        [{ id: 'threat-1', deviceId: DEVICE_ALLOWED, deviceName: 'PC-01' }],
        1
      );

      const res = await app.request(`/s1/threats?deviceId=${DEVICE_ALLOWED}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('does not narrow for an unrestricted caller (no allowedSiteIds)', async () => {
      // No permissions set — only the threats list + count run, with NO
      // device-resolution select beforehand.
      setAuth();
      mockThreatsQueries(
        [
          { id: 'threat-1', deviceId: DEVICE_ALLOWED, deviceName: 'PC-01' },
          { id: 'threat-2', deviceId: DEVICE_DENIED, deviceName: 'PC-02' }
        ],
        2
      );

      const res = await app.request('/s1/threats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });
  });
});
