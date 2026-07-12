/**
 * aiToolsMonitoring — manage_monitors site-axis gate tests.
 *
 * Verifies that the manage_monitors tool's get/update/delete actions enforce
 * the intra-org site axis for site-restricted callers (auth.canAccessSite set).
 * The list action (query_monitors) has its own site gate; these tests cover the
 * per-monitor CRUD actions that previously skipped the axis entirely.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema/monitors', () => ({
  networkMonitors: {
    id: 'nm.id',
    orgId: 'nm.orgId',
    name: 'nm.name',
    assetId: 'nm.assetId',
  },
  networkMonitorResults: {
    id: 'nmr.id',
    monitorId: 'nmr.monitorId',
    status: 'nmr.status',
    responseMs: 'nmr.responseMs',
    statusCode: 'nmr.statusCode',
    error: 'nmr.error',
    details: 'nmr.details',
    timestamp: 'nmr.timestamp',
  },
  networkMonitorAlertRules: {
    id: 'nmar.id',
    monitorId: 'nmar.monitorId',
    condition: 'nmar.condition',
    threshold: 'nmar.threshold',
    severity: 'nmar.severity',
    message: 'nmar.message',
    isActive: 'nmar.isActive',
  },
}));

vi.mock('../db/schema/serviceProcessMonitoring', () => ({
  serviceProcessCheckResults: {},
}));

vi.mock('../db/schema', () => ({
  deviceChangeLog: {},
  discoveredAssets: {
    id: 'da.id',
    orgId: 'da.orgId',
    siteId: 'da.siteId',
  },
}));

import { db } from '../db';
import { registerMonitoringTools } from './aiToolsMonitoring';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

// Build the aiTools registry and extract manage_monitors handler.
function buildManageMonitors(): (input: Record<string, unknown>, auth: AuthContext) => Promise<string> {
  const map = new Map<string, AiTool>();
  registerMonitoringTools(map);
  const tool = map.get('manage_monitors');
  if (!tool) throw new Error('manage_monitors not registered');
  return tool.handler as (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
}

// Unrestricted org-scope caller.
function makeUnrestrictedAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as AuthContext;
}

// Site-restricted caller: only allowed into site-1.
function makeSiteRestrictedAuth(): AuthContext {
  return {
    ...makeUnrestrictedAuth(),
    allowedSiteIds: ['site-1'],
    canAccessSite: (siteId: string | null | undefined) => siteId === 'site-1',
  };
}

const MONITOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ASSET_ALLOWED = 'bbbbbbbb-0000-0000-0000-000000000001';
const ASSET_DENIED  = 'cccccccc-0000-0000-0000-000000000002';

// A monitor whose linked asset is in site-1 (allowed).
const monitorInAllowedSite = { id: MONITOR_ID, orgId: 'org-1', assetId: ASSET_ALLOWED, name: 'Allowed Monitor', updatedAt: new Date() };
// A monitor whose linked asset is in site-2 (denied) or has no asset.
const monitorInDeniedSite  = { id: MONITOR_ID, orgId: 'org-1', assetId: ASSET_DENIED,  name: 'Denied Monitor',  updatedAt: new Date() };
const monitorNoAsset       = { id: MONITOR_ID, orgId: 'org-1', assetId: null,           name: 'Assetless',       updatedAt: new Date() };

// Chain for networkMonitors lookup (select().from().where().limit() → [monitor]).
function monitorLookup(monitor: typeof monitorInAllowedSite | typeof monitorNoAsset | null) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(monitor ? [monitor] : []) }),
    }),
  } as any;
}

// Chain for discoveredAssets lookup (select().from().where().limit() → [{siteId}]).
function assetLookup(siteId: string | null) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(siteId ? [{ siteId }] : []) }),
    }),
  } as any;
}

// Chain for networkMonitorResults/networkMonitorAlertRules (select().from().where().orderBy().limit()).
function resultsLookup() {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
    }),
  } as any;
}

// Chain for networkMonitorAlertRules (select().from().where()).
function rulesLookup() {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('manage_monitors — site-axis enforcement', () => {
  let handle: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

  beforeEach(() => {
    handle = buildManageMonitors();
  });

  // ─── get action ──────────────────────────────────────────────────────────

  describe('action: get', () => {
    it('allows unrestricted caller to read a monitor (no site check)', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInDeniedSite)) // monitor row
        .mockReturnValueOnce(resultsLookup())                    // recent results
        .mockReturnValueOnce(rulesLookup());                     // alert rules

      const out = JSON.parse(await handle({ action: 'get', monitorId: MONITOR_ID }, makeUnrestrictedAuth()));
      expect(out).not.toHaveProperty('error');
      expect(out.monitor).toBeDefined();
    });

    it('denies site-restricted caller when monitor asset is in a forbidden site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInDeniedSite)) // monitor row
        .mockReturnValueOnce(assetLookup('site-2'));             // asset lookup → site-2 (denied)

      const out = JSON.parse(await handle({ action: 'get', monitorId: MONITOR_ID }, makeSiteRestrictedAuth()));
      expect(out.error).toMatch(/not found or access denied/i);
    });

    it('denies site-restricted caller when monitor has no linked asset (fail-closed)', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorNoAsset)); // monitor row (assetId null)
      // No asset lookup needed — assertMonitorSiteAccess returns false immediately.

      const out = JSON.parse(await handle({ action: 'get', monitorId: MONITOR_ID }, makeSiteRestrictedAuth()));
      expect(out.error).toMatch(/not found or access denied/i);
    });

    it('allows site-restricted caller when monitor asset is in an allowed site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInAllowedSite)) // monitor row
        .mockReturnValueOnce(assetLookup('site-1'))               // asset lookup → site-1 (allowed)
        .mockReturnValueOnce(resultsLookup())                     // recent results
        .mockReturnValueOnce(rulesLookup());                      // alert rules

      const out = JSON.parse(await handle({ action: 'get', monitorId: MONITOR_ID }, makeSiteRestrictedAuth()));
      expect(out).not.toHaveProperty('error');
      expect(out.monitor).toBeDefined();
    });
  });

  // ─── update action ───────────────────────────────────────────────────────

  describe('action: update', () => {
    it('denies site-restricted caller updating a monitor in a forbidden site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInDeniedSite)) // monitor row
        .mockReturnValueOnce(assetLookup('site-2'));             // asset → site-2 (denied)

      const out = JSON.parse(await handle(
        { action: 'update', monitorId: MONITOR_ID, name: 'hacked' },
        makeSiteRestrictedAuth(),
      ));
      expect(out.error).toMatch(/not found or access denied/i);
      // db.update must NOT have been called
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('denies site-restricted caller updating a monitor with no asset (fail-closed)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(monitorLookup(monitorNoAsset));

      const out = JSON.parse(await handle(
        { action: 'update', monitorId: MONITOR_ID, name: 'hacked' },
        makeSiteRestrictedAuth(),
      ));
      expect(out.error).toMatch(/not found or access denied/i);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('allows site-restricted caller to update a monitor in an allowed site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInAllowedSite)) // monitor row
        .mockReturnValueOnce(assetLookup('site-1'));              // asset → site-1 (allowed)
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      } as any);

      const out = JSON.parse(await handle(
        { action: 'update', monitorId: MONITOR_ID, name: 'renamed' },
        makeSiteRestrictedAuth(),
      ));
      expect(out.success).toBe(true);
      expect(vi.mocked(db.update)).toHaveBeenCalledOnce();
    });
  });

  // ─── delete action ───────────────────────────────────────────────────────

  describe('action: delete', () => {
    it('denies site-restricted caller deleting a monitor in a forbidden site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInDeniedSite))
        .mockReturnValueOnce(assetLookup('site-2'));

      const out = JSON.parse(await handle(
        { action: 'delete', monitorId: MONITOR_ID },
        makeSiteRestrictedAuth(),
      ));
      expect(out.error).toMatch(/not found or access denied/i);
      expect(vi.mocked(db.delete)).not.toHaveBeenCalled();
    });

    it('denies site-restricted caller deleting a monitor with no asset (fail-closed)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(monitorLookup(monitorNoAsset));

      const out = JSON.parse(await handle(
        { action: 'delete', monitorId: MONITOR_ID },
        makeSiteRestrictedAuth(),
      ));
      expect(out.error).toMatch(/not found or access denied/i);
      expect(vi.mocked(db.delete)).not.toHaveBeenCalled();
    });

    it('allows site-restricted caller to delete a monitor in an allowed site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInAllowedSite))
        .mockReturnValueOnce(assetLookup('site-1'));
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const out = JSON.parse(await handle(
        { action: 'delete', monitorId: MONITOR_ID },
        makeSiteRestrictedAuth(),
      ));
      expect(out.success).toBe(true);
      expect(vi.mocked(db.delete)).toHaveBeenCalledOnce();
    });
  });

  // ─── create action (SR5-08) ──────────────────────────────────────────────

  describe('action: create', () => {
    // db.insert().values().returning() → [monitor]
    function insertReturning(monitor: Record<string, unknown>) {
      return {
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([monitor]) }),
      } as any;
    }
    // db.select().from().where().limit() → [{ id }] (asset org-ownership check).
    function assetOwnerLookup(found: boolean) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(found ? [{ id: ASSET_ALLOWED }] : []) }),
        }),
      } as any;
    }

    const CREATE = {
      action: 'create',
      name: 'db-probe',
      monitorType: 'tcp_port',
      target: '10.0.0.5:5432',
    };

    it('denies a site-restricted caller creating an UNBOUND monitor (fail-closed)', async () => {
      const out = JSON.parse(await handle({ ...CREATE }, makeSiteRestrictedAuth()));
      expect(out.error).toMatch(/site-restricted/i);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('denies a site-restricted caller binding an asset in a forbidden site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(assetOwnerLookup(true))   // org-ownership check passes
        .mockReturnValueOnce(assetLookup('site-2'));    // asset resolves to denied site
      const out = JSON.parse(await handle({ ...CREATE, assetId: ASSET_ALLOWED }, makeSiteRestrictedAuth()));
      expect(out.error).toMatch(/site-restricted/i);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('rejects a cross-org assetId (fail-closed)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(assetOwnerLookup(false)); // asset not in caller org
      const out = JSON.parse(await handle({ ...CREATE, assetId: ASSET_DENIED }, makeSiteRestrictedAuth()));
      expect(out.error).toMatch(/asset not found or access denied/i);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('allows a site-restricted caller binding an asset in an allowed site', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(assetOwnerLookup(true))   // org-ownership check passes
        .mockReturnValueOnce(assetLookup('site-1'));    // asset resolves to allowed site
      vi.mocked(db.insert).mockReturnValue(insertReturning({ id: 'new-mon', name: 'db-probe' }));
      const out = JSON.parse(await handle({ ...CREATE, assetId: ASSET_ALLOWED }, makeSiteRestrictedAuth()));
      expect(out.success).toBe(true);
      expect(vi.mocked(db.insert)).toHaveBeenCalledOnce();
    });

    it('allows an unrestricted caller to create an assetless monitor (behavior preserved)', async () => {
      vi.mocked(db.insert).mockReturnValue(insertReturning({ id: 'new-mon', name: 'db-probe' }));
      const out = JSON.parse(await handle({ ...CREATE }, makeUnrestrictedAuth()));
      expect(out.success).toBe(true);
      // No asset lookups for an unrestricted, unbound create.
      expect(vi.mocked(db.select)).not.toHaveBeenCalled();
      expect(vi.mocked(db.insert)).toHaveBeenCalledOnce();
    });
  });

  // ─── unrestricted caller invariant ───────────────────────────────────────

  describe('unrestricted caller bypass', () => {
    it('get action: unrestricted caller always passes site check regardless of asset siteId', async () => {
      // For an unrestricted caller, assertMonitorSiteAccess returns true without
      // querying discoveredAssets — only the monitor lookup + results + rules queries run.
      vi.mocked(db.select)
        .mockReturnValueOnce(monitorLookup(monitorInDeniedSite)) // monitor row
        .mockReturnValueOnce(resultsLookup())                    // results (no asset lookup between)
        .mockReturnValueOnce(rulesLookup());                     // rules

      const out = JSON.parse(await handle({ action: 'get', monitorId: MONITOR_ID }, makeUnrestrictedAuth()));
      expect(out).not.toHaveProperty('error');
      // Exactly 3 select calls — no asset lookup issued
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(3);
    });
  });
});
