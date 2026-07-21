import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate, permsState, authState } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  permsState: { permissions: undefined as { allowedSiteIds?: string[] } | undefined },
  authState: {
    scope: 'organization' as string,
    orgId: '11111111-1111-4111-8111-111111111111' as string | undefined,
    partnerId: 'a0000000-0000-4000-8000-000000000001' as string | undefined,
    partnerOrgAccess: null as 'all' | 'selected' | 'none' | null,
    accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'] as string[],
    canAccessOrg: ((orgId: string) => orgId === '11111111-1111-4111-8111-111111111111') as (orgId: string) => boolean,
    orgCondition: () => undefined as any,
  }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', orgId: 'orgId', hostname: 'hostname', siteId: 'siteId' },
  organizations: { id: 'id', name: 'name', partnerId: 'partnerId' },
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
    partnerId: 'partnerId',
    legacyOrgId: 'legacyOrgId',
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
  s1OrgMappings: {
    id: 'id',
    integrationId: 'integrationId',
    partnerId: 'partnerId',
    s1SiteId: 's1SiteId',
    s1SiteName: 's1SiteName',
    orgId: 'orgId',
    agentsCount: 'agentsCount',
    metadata: 'metadata',
    lastSeenAt: 'lastSeenAt',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
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
      scope: authState.scope,
      orgId: authState.orgId,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      accessibleOrgIds: authState.accessibleOrgIds,
      canAccessOrg: authState.canAccessOrg,
      orgCondition: authState.orgCondition,
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

import { sentinelOneRoutes, requirePartnerManager, resolvePartnerId, resolveOrgId } from './sentinelOne';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
  executeS1IsolationForOrg,
  executeS1ThreatActionForOrg,
  getActiveS1IntegrationForOrg
} from '../services/sentinelOne/actions';
import { encryptSecret } from '../services/secretCrypto';

const PARTNER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PARTNER_ID = 'a0000000-0000-4000-8000-000000000002';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID_B = '22222222-2222-4222-8222-222222222222';
const INTEGRATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INTEGRATION_ID_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const S1_SITE_ID = 's1-site-abc123';

describe('sentinel one routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    // Default: org-scope caller (reset all authState fields)
    authState.scope = 'organization';
    authState.orgId = ORG_ID;
    authState.partnerId = PARTNER_ID;
    authState.partnerOrgAccess = 'all';
    authState.accessibleOrgIds = [ORG_ID];
    authState.canAccessOrg = (orgId: string) => orgId === ORG_ID;
    authState.orgCondition = () => undefined as any;
    permsState.permissions = undefined;

    app = new Hono();
    app.route('/s1', sentinelOneRoutes);
  });

  it.each([
    ['GET', '/s1/integration', undefined],
    ['POST', '/s1/integration', {
      name: 'SentinelOne',
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'secret',
    }],
    ['POST', '/s1/sync', {}],
    ['GET', '/s1/sites', undefined],
    ['POST', '/s1/organizations/map', {
      integrationId: INTEGRATION_ID,
      s1SiteId: S1_SITE_ID,
      orgId: null,
    }],
  ])('rejects selected-org partner access before shared integration work: %s %s', async (method, path, body) => {
    authState.scope = 'partner';
    authState.orgId = undefined;
    authState.partnerOrgAccess = 'selected';

    const res = await app.request(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  // ───────────────────── B1: Helper unit tests ─────────────────────
  describe('requirePartnerManager', () => {
    it('rejects organization scope', () => {
      const r = requirePartnerManager({ scope: 'organization', partnerId: 'p1' } as any);
      expect(r).toEqual({ error: 'SentinelOne credentials and mappings are managed at partner scope', status: 403 });
    });
    it('pins partner scope to its partnerId', () => {
      const r = requirePartnerManager({ scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'all' } as any);
      expect(r).toEqual({ partnerId: 'p1' });
    });
    it('rejects partner scope without full partner organization access', () => {
      const r = requirePartnerManager({ scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'selected' } as any);
      expect(r).toMatchObject({ status: 403 });
    });
    it('system scope requires explicit partnerId', () => {
      const r = requirePartnerManager({ scope: 'system' } as any);
      expect(r).toEqual({ error: 'partnerId is required for system scope', status: 400 });
    });
    it('system scope with explicit partnerId resolves', () => {
      const r = requirePartnerManager({ scope: 'system' } as any, 'p1');
      expect(r).toEqual({ partnerId: 'p1' });
    });
    it('rejects partner trying to access another partner', () => {
      const r = requirePartnerManager({ scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'all' } as any, 'p2');
      expect(r).toEqual({ error: 'Access to this partner denied', status: 403 });
    });
  });

  describe('resolvePartnerId', () => {
    it('resolves org scope to its partnerId', () => {
      const r = resolvePartnerId({ scope: 'organization', partnerId: 'p1' } as any);
      expect(r).toEqual({ partnerId: 'p1' });
    });
    it('org scope rejects cross-partner request', () => {
      const r = resolvePartnerId({ scope: 'organization', partnerId: 'p1' } as any, 'p2');
      expect(r).toEqual({ error: 'Access to this partner denied', status: 403 });
    });
    it('system scope with no requested partnerId returns error', () => {
      const r = resolvePartnerId({ scope: 'system' } as any);
      expect(r).toEqual({ error: 'partnerId is required for system scope', status: 400 });
    });
  });

  describe('resolveOrgId', () => {
    it('org scope returns its orgId', () => {
      const r = resolveOrgId({ scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'], canAccessOrg: () => true } as any);
      expect(r).toEqual({ orgId: 'o1' });
    });
    it('org scope rejects cross-org access', () => {
      const r = resolveOrgId({ scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'], canAccessOrg: (id: string) => id === 'o1' } as any, 'o2');
      expect(r).toEqual({ error: 'Access to this organization denied', status: 403 });
    });
  });

  // ───────────────────── B2: POST /integration ─────────────────────
  describe('POST /integration', () => {
    it('rejects org scope with 403', async () => {
      // requireScope is mocked to always pass, but our route logic rejects org scope
      authState.scope = 'organization';

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
      const body = await res.json();
      expect(body.error).toContain('partner scope');
    });

    it('allows partner scope and inserts with partnerId', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;

      // First select: check existing (returns nothing)
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);
      // insert returning
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: INTEGRATION_ID,
            partnerId: PARTNER_ID,
            name: 'SentinelOne Prod',
            managementUrl: 'https://example.sentinelone.net',
            isActive: true,
            lastSyncAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }])
        })
      } as any);

      const { scheduleS1Sync } = await import('../jobs/s1Sync');
      vi.mocked(scheduleS1Sync).mockResolvedValueOnce('job-1');

      const res = await app.request('/s1/integration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SentinelOne Prod',
          managementUrl: 'https://example.sentinelone.net',
          apiToken: 'token'
        })
      });

      expect(res.status).toBe(201);
      const resBody = await res.json();
      expect(resBody.data.partnerId).toBe(PARTNER_ID);
    });

    it('updates when existing integration found (filters by partner_id)', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;

      // First select: returns existing integration
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              managementUrl: 'https://example.sentinelone.net',
              apiTokenEncrypted: 'enc:stored-token'
            }])
          })
        })
      } as any);
      // update returning
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
              name: 'SentinelOne Prod',
              managementUrl: 'https://example.sentinelone.net',
              isActive: true,
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSyncError: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            }])
          })
        })
      } as any);

      const { scheduleS1Sync } = await import('../jobs/s1Sync');
      vi.mocked(scheduleS1Sync).mockResolvedValueOnce('job-2');

      const res = await app.request('/s1/integration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SentinelOne Prod',
          managementUrl: 'https://example.sentinelone.net',
          apiToken: 'new-token'
        })
      });

      expect(res.status).toBe(200);
      // update was called (not insert)
      expect(db.update).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
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
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;
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
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;

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
  });

  // ───────────────────── B2: GET /integration ─────────────────────
  describe('GET /integration', () => {
    const INTEGRATION_ROW = {
      id: INTEGRATION_ID,
      partnerId: PARTNER_ID,
      name: 'S1 Prod',
      managementUrl: 'https://example.sentinelone.net',
      isActive: true,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      hasApiToken: true,
    };

    // Mocks the integration lookup (db.select from s1Integrations)
    function mockIntegrationLookup(result: typeof INTEGRATION_ROW | null) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(result ? [result] : [])
          })
        })
      } as any);
    }

    // Mocks the s1OrgMappings mapped-check (db.select from s1OrgMappings)
    function mockMappingLookup(found: boolean) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(found ? [{ id: 'mapping-1' }] : [])
          })
        })
      } as any);
    }

    it('(a) org-scope caller whose org IS mapped returns 200 with integration data', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      authState.partnerId = PARTNER_ID;

      mockIntegrationLookup(INTEGRATION_ROW);
      mockMappingLookup(true);

      const res = await app.request('/s1/integration');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).not.toBeNull();
      expect(body.data.id).toBe(INTEGRATION_ID);
      expect(body.data.partnerId).toBe(PARTNER_ID);
      // Verify the mapping check ran (db.select called twice: integration + mapping)
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('(b) org-scope caller whose org is NOT mapped returns 200 with mapped:false and data:null', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      authState.partnerId = PARTNER_ID;

      mockIntegrationLookup(INTEGRATION_ROW);
      mockMappingLookup(false);

      const res = await app.request('/s1/integration');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeNull();
      expect(body.mapped).toBe(false);
      // `connected: true` lets the web distinguish "your org isn't mapped"
      // (partner IS connected) from "no integration at all" (`{ data: null }`).
      expect(body.connected).toBe(true);
      // Verify the mapping check did run (not skipped)
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('(c) org-scope caller passing a different orgId than their own gets 403', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      authState.partnerId = PARTNER_ID;

      // Integration lookup runs first (before resolveOrgId is called)
      mockIntegrationLookup(INTEGRATION_ROW);
      // No mapping lookup should run — the 403 fires first

      const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
      const res = await app.request(`/s1/integration?orgId=${OTHER_ORG_ID}`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/organization/i);
      // Mapping check must NOT have run (only 1 select: the integration lookup)
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('(d) org-scope caller passing a partnerId that does not match their own gets 403', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      authState.partnerId = PARTNER_ID;

      // resolvePartnerId fires before the DB lookup — no select should run
      const res = await app.request(`/s1/integration?partnerId=${OTHER_PARTNER_ID}`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/partner/i);
      // No DB calls should have been made
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  // ───────────────────── B3: POST /organizations/map ─────────────────────
  describe('POST /organizations/map', () => {
    it('rejects org scope with 403', async () => {
      authState.scope = 'organization';

      const res = await app.request('/s1/organizations/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: INTEGRATION_ID,
          s1SiteId: S1_SITE_ID,
          orgId: ORG_ID
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('partner scope');
    });

    it('partner maps own site to org successfully', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;
      authState.canAccessOrg = (orgId: string) => orgId === ORG_ID;

      // 1. Integration lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
            }])
          })
        })
      } as any);
      // 2. Target org lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: ORG_ID,
              partnerId: PARTNER_ID,
            }])
          })
        })
      } as any);
      // 3. Update s1OrgMappings
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              s1SiteId: S1_SITE_ID,
              mappedOrgId: ORG_ID,
            }])
          })
        })
      } as any);

      const res = await app.request('/s1/organizations/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: INTEGRATION_ID,
          s1SiteId: S1_SITE_ID,
          orgId: ORG_ID
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.s1SiteId).toBe(S1_SITE_ID);
      expect(body.data.mappedOrgId).toBe(ORG_ID);
    });

    it('rejects mapping an org from a different partner (cross-partner org)', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;
      authState.canAccessOrg = (orgId: string) => orgId === ORG_ID;

      // Integration belongs to PARTNER_ID
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
            }])
          })
        })
      } as any);
      // Target org belongs to OTHER_PARTNER_ID
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: ORG_ID,
              partnerId: OTHER_PARTNER_ID,
            }])
          })
        })
      } as any);

      const res = await app.request('/s1/organizations/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: INTEGRATION_ID,
          s1SiteId: S1_SITE_ID,
          orgId: ORG_ID
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('does not belong to this partner');
    });

    it('returns 404 when discovered site not found (non-existent s1SiteId)', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;
      authState.canAccessOrg = (orgId: string) => orgId === ORG_ID;

      // Integration lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
            }])
          })
        })
      } as any);
      // Target org lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: ORG_ID,
              partnerId: PARTNER_ID,
            }])
          })
        })
      } as any);
      // Update returns empty (no matching row)
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/s1/organizations/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: INTEGRATION_ID,
          s1SiteId: 'nonexistent-site-id',
          orgId: ORG_ID
        })
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Run sync first to discover sites');
    });

    it('partner can unmap by passing orgId=null', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;
      authState.canAccessOrg = (orgId: string) => orgId === ORG_ID;

      // Integration lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
            }])
          })
        })
      } as any);
      // Update returns row with null orgId
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              s1SiteId: S1_SITE_ID,
              mappedOrgId: null,
            }])
          })
        })
      } as any);

      const res = await app.request('/s1/organizations/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: INTEGRATION_ID,
          s1SiteId: S1_SITE_ID,
          orgId: null
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.mappedOrgId).toBeNull();
    });
  });

  // ───────────────────── B4: /status ─────────────────────
  describe('GET /status', () => {
    it('returns empty summary when no integration found', async () => {
      authState.scope = 'organization';
      authState.partnerId = PARTNER_ID;

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/s1/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.integration).toBeNull();
      expect(body.summary.totalAgents).toBe(0);
      // Shape must match the success branch so the web tiles never render blank.
      expect(body.summary.highOrCriticalThreats).toBe(0);
      expect(body.summary.reportedThreatCount).toBe(0);
    });

    it('org scope returns empty summary when org is not mapped', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      authState.partnerId = PARTNER_ID;

      // Integration found
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
              name: 'S1',
              managementUrl: 'https://example.sentinelone.net',
              isActive: true,
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSyncError: null,
            }])
          })
        })
      } as any);
      // No mapping for this org
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/s1/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mapped).toBe(false);
      expect(body.summary.totalAgents).toBe(0);
    });

    it('partner scope returns cross-org coverage', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;

      // Integration found
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
              name: 'S1',
              managementUrl: 'https://example.sentinelone.net',
              isActive: true,
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSyncError: null,
            }])
          })
        })
      } as any);

      // Agent summary
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            totalAgents: 5,
            mappedDevices: 3,
            infectedAgents: 1,
            totalThreatCount: 2
          }])
        })
      } as any);
      // Threat summary
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            activeThreats: 2,
            highOrCritical: 1
          }])
        })
      } as any);
      // Action summary
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            pendingActions: 0
          }])
        })
      } as any);

      const res = await app.request('/s1/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mapped).toBe(true);
      expect(body.summary.totalAgents).toBe(5);
      expect(body.summary.activeThreats).toBe(2);
    });

    it('rejects cross-org status access for org scope', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      authState.canAccessOrg = (orgId: string) => orgId === ORG_ID;

      const res = await app.request('/s1/status?orgId=b0000000-0000-4000-8000-000000000099');
      expect(res.status).toBe(403);
    });
  });

  // ───────────────────── B4: /isolate ─────────────────────
  describe('POST /isolate', () => {
    it('rejects isolate action when MFA check fails', async () => {
      mfaGate.deny = true;

      const res = await app.request('/s1/isolate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [ORG_ID]
        })
      });

      expect(res.status).toBe(403);
    });

    it('calls getActiveS1IntegrationForOrg with orgId and writes audit with orgId', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;

      vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
        id: INTEGRATION_ID,
        orgId: ORG_ID,
        name: 'S1',
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null
      } as any);
      vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          requestedDeviceIds: [ORG_ID],
          inaccessibleDeviceIds: [],
          unmappedAccessibleDeviceIds: [],
          requestedDevices: 1,
          mappedAgents: 1,
          providerActionId: 'activity-1',
          actions: [{ id: 'action-1', deviceId: ORG_ID }],
          warning: null
        }
      } as any);

      const { writeRouteAudit } = await import('../services/auditEvents');

      const res = await app.request('/s1/isolate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [ORG_ID]
        })
      });

      expect(res.status).toBe(200);
      expect(getActiveS1IntegrationForOrg).toHaveBeenCalledWith(ORG_ID);
      // Audit written with orgId
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgId: ORG_ID })
      );
    });

    it('returns warning when isolate dispatch has no provider activity id', async () => {
      vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
        id: 'int-1',
        orgId: ORG_ID,
        name: 'S1',
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null
      } as any);
      vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          requestedDeviceIds: [ORG_ID],
          inaccessibleDeviceIds: [],
          unmappedAccessibleDeviceIds: [],
          requestedDevices: 1,
          mappedAgents: 1,
          providerActionId: null,
          actions: [{ id: 'action-1', deviceId: ORG_ID }],
          warning: 'Provider did not return activityId; action cannot be tracked'
        }
      } as any);

      const res = await app.request('/s1/isolate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [ORG_ID]
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
        orgId: ORG_ID,
        name: 'S1',
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null
      } as any);
      vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
        ok: true,
        status: 502,
        data: {
          requestedDeviceIds: [ORG_ID],
          inaccessibleDeviceIds: [],
          unmappedAccessibleDeviceIds: [],
          requestedDevices: 1,
          mappedAgents: 1,
          providerActionId: null,
          actions: [{ id: 'action-err-1', deviceId: ORG_ID }],
          warning: 'SentinelOne action dispatch failed: provider timeout'
        }
      } as any);

      const res = await app.request('/s1/isolate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [ORG_ID]
        })
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain('SentinelOne action dispatch failed');
      expect(body.data.actions).toHaveLength(1);
    });
  });

  // ───────────────────── B4: /threat-action ─────────────────────
  describe('POST /threat-action', () => {
    it('calls getActiveS1IntegrationForOrg and writes audit with orgId', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;

      vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
        id: INTEGRATION_ID,
        orgId: ORG_ID,
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
          requestedThreats: 1,
          matchedThreats: 1,
          matchedThreatIds: ['s1-threat-1'],
          unmatchedThreatIds: [],
          providerActionId: 'activity-2',
          actions: [{ id: 'action-2', deviceId: 'device-1' }]
        }
      } as any);

      const { writeRouteAudit } = await import('../services/auditEvents');

      const res = await app.request('/s1/threat-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'kill',
          threatIds: ['s1-threat-1']
        })
      });

      expect(res.status).toBe(200);
      expect(getActiveS1IntegrationForOrg).toHaveBeenCalledWith(ORG_ID);
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgId: ORG_ID })
      );
    });

    it('returns partial threat action results with unmatched threat ids', async () => {
      vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
        id: 'int-1',
        orgId: ORG_ID,
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
  });

  // ───────────────────── B4: POST /sync ─────────────────────
  describe('POST /sync', () => {
    it('rejects org scope with 403', async () => {
      authState.scope = 'organization';

      const res = await app.request('/s1/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('partner scope');
    });

    it('partner scope finds active integration and schedules sync', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: INTEGRATION_ID,
              partnerId: PARTNER_ID,
              name: 'S1',
              isActive: true,
            }])
          })
        })
      } as any);

      const { scheduleS1Sync } = await import('../jobs/s1Sync');
      vi.mocked(scheduleS1Sync).mockResolvedValueOnce('sync-job-1');

      const res = await app.request('/s1/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.integrationId).toBe(INTEGRATION_ID);
      expect(body.data.jobId).toBe('sync-job-1');
    });

    it('returns 404 when no active integration found for partner', async () => {
      authState.scope = 'partner';
      authState.partnerId = PARTNER_ID;

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/s1/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(404);
    });
  });

  // ───────────────────── GET /threats — partner scope ─────────────────────
  describe('GET /threats — partner scope', () => {
    function mockActiveIntegrations(rows: Array<{ id: string }>) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows)
        })
      } as any);
    }

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

    it('GET /threats rejects system scope without explicit partnerId', async () => {
      authState.scope = 'system';
      authState.orgId = undefined;
      authState.partnerId = undefined;
      authState.accessibleOrgIds = [];
      authState.canAccessOrg = () => false;
      authState.orgCondition = () => undefined as any;

      const res = await app.request('/s1/threats');
      expect(res.status).toBe(400);
    });

    it('GET /threats lists across all partner orgs for a partner-scoped caller without orgId', async () => {
      authState.scope = 'partner';
      authState.orgId = undefined;
      authState.partnerId = PARTNER_ID;
      authState.accessibleOrgIds = [ORG_ID, ORG_ID_B];
      authState.canAccessOrg = (orgId: string) => [ORG_ID, ORG_ID_B].includes(orgId);
      authState.orgCondition = () => undefined as any;

      mockActiveIntegrations([{ id: INTEGRATION_ID }, { id: INTEGRATION_ID_B }]);
      mockThreatsQueries(
        [
          { id: 'threat-a', orgId: ORG_ID, integrationId: INTEGRATION_ID },
          { id: 'threat-b', orgId: ORG_ID_B, integrationId: INTEGRATION_ID_B }
        ],
        2
      );

      const res = await app.request('/s1/threats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((t: any) => t.orgId).sort()).toEqual([ORG_ID, ORG_ID_B].sort());
      expect(body.pagination.total).toBe(2);
    });
  });

  // ───────────────────── GET /threats — site scope ─────────────────────
  // A site-restricted org user (permissions.allowedSiteIds set) must not list
  // SentinelOne threats (or device hostnames) for devices in sites outside
  // their allowlist, nor target a foreign-site device via ?deviceId=.
  // Site is an app-layer concept only — Postgres RLS does not defend it.
  describe('GET /threats — site scope', () => {
    const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
    const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
    const DEVICE_ALLOWED = 'd0000000-0000-4000-8000-000000000001';
    const DEVICE_DENIED = 'd0000000-0000-4000-8000-000000000002';

    function setAuth(allowedSiteIds?: string[]) {
      // `permissions` is populated by requirePermission (see global mock), not
      // authMiddleware — faithful to prod, so a route lacking the permission
      // gate will not receive site scoping and its tests will fail.
      permsState.permissions = allowedSiteIds ? { allowedSiteIds } : undefined;
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      authState.accessibleOrgIds = [ORG_ID];
      authState.canAccessOrg = (orgId: string) => orgId === ORG_ID;
      authState.orgCondition = () => undefined as any;
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
