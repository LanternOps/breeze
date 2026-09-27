/** Tests read isolation and retired network-check mutations. */

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
    managedByMonitorId: 'nm.managedByMonitorId',
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

// W01 (spec §4.4): query_monitors derives `assetReachability` per monitor
// through the batched loader. The derivation is pinned by
// assetReachability.test.ts; this suite owns the WIRING, so the loader is
// mocked and driven per-test (pattern from monitoring_assets_list.test.ts).
const reachabilityByAsset = new Map<string, unknown>();
vi.mock('./assetReachabilityLoader', () => ({
  loadReachability: vi.fn(async () => reachabilityByAsset),
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
    principal: { kind: 'user_session' },
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

beforeEach(() => {
  vi.clearAllMocks();
  reachabilityByAsset.clear();
});

// Build the aiTools registry and extract query_monitors handler.
function buildQueryMonitors(): (input: Record<string, unknown>, auth: AuthContext) => Promise<string> {
  const map = new Map<string, AiTool>();
  registerMonitoringTools(map);
  const tool = map.get('query_monitors');
  if (!tool) throw new Error('query_monitors not registered');
  return tool.handler as (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
}

// Chain for the unrestricted query_monitors list (select().from().where().orderBy().limit()).
function monitorListLookup(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  } as any;
}

describe('query_monitors — assetReachability (W01, spec §4.4)', () => {
  it('attaches the derived reachability for a monitor with a linked asset', async () => {
    reachabilityByAsset.set(ASSET_ALLOWED, {
      state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z',
    });
    vi.mocked(db.select).mockReturnValueOnce(monitorListLookup([monitorInAllowedSite]));

    const out = JSON.parse(await buildQueryMonitors()({}, makeUnrestrictedAuth()));

    expect(out.error).toBeUndefined();
    expect(out.monitors).toHaveLength(1);
    expect(out.monitors[0].assetReachability).toEqual({
      state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z',
    });
  });

  it('selects and returns the owning monitor definition for managed checks', async () => {
    vi.mocked(db.select).mockReturnValueOnce(monitorListLookup([
      { ...monitorInAllowedSite, managedByMonitorId: 'definition-id' },
      { ...monitorNoAsset, managedByMonitorId: null },
    ]));
    const out = JSON.parse(await buildQueryMonitors()({}, makeUnrestrictedAuth()));
    expect(db.select).toHaveBeenCalledWith(expect.objectContaining({
      managedByMonitorId: 'nm.managedByMonitorId',
    }));
    expect(out.monitors.map((row: { managedByMonitorId: string | null }) => row.managedByMonitorId))
      .toEqual(['definition-id', null]);
  });

  it('reports null assetReachability for a monitor with no linked asset', async () => {
    vi.mocked(db.select).mockReturnValueOnce(monitorListLookup([monitorNoAsset]));

    const out = JSON.parse(await buildQueryMonitors()({}, makeUnrestrictedAuth()));

    expect(out.error).toBeUndefined();
    expect(out.monitors).toHaveLength(1);
    expect(out.monitors[0].assetReachability).toBeNull();
  });
});

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

  describe('mutations are retired (W05e)', () => {
    const callers = [
      ['unrestricted', makeUnrestrictedAuth],
      ['site-restricted', makeSiteRestrictedAuth],
      ['multi-org', () => ({
        ...makeUnrestrictedAuth(), scope: 'partner' as const, orgId: null,
        partnerId: 'partner-1', accessibleOrgIds: ['org-1', 'org-2'],
      })],
    ] as const;

    for (const [label, makeAuth] of callers) {
      it.each([
        { action: 'create' },
        { action: 'create', name: 'Gateway', monitorType: 'icmp_ping', target: '10.0.0.1' },
        { action: 'create', name: 'Gateway', monitorType: 'icmp_ping', target: '10.0.0.1', assetId: ASSET_ALLOWED, orgId: 'org-2' },
        { action: 'create', assetId: ASSET_DENIED },
        { action: 'update' },
        { action: 'update', monitorId: MONITOR_ID, name: 'Renamed' },
        { action: 'delete' },
        { action: 'delete', monitorId: MONITOR_ID },
      ])(`${label} caller gets guidance without DB access: %j`, async (input) => {
        const out = JSON.parse(await handle(input, makeAuth()));
        if (input.action === 'delete') {
          expect(out).toMatchObject({
            error: 'network_check_cleanup_retired',
            hint: {
              route: 'POST /monitor-definitions/conversion/retire',
              sourceTable: 'network_monitors', reason: 'operator',
            },
          });
          expect(out.hint.sourceId).toBe(input.monitorId);
          expect(out.message).toMatch(/history/i);
        } else {
          expect(out).toMatchObject({
            error: 'network_check_authoring_retired',
            useTool: 'manage_monitor_definitions',
            example: {
              action: 'create',
              definition: {
                kind: 'network_check', name: expect.any(String),
                condition: { checkType: 'icmp_ping', target: '10.0.0.1', assetId: expect.any(String) },
              },
            },
          });
        }
        expect(db.select).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
      });
    }
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
