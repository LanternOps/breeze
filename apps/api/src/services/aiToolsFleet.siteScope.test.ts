import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deleteSpy } = vi.hoisted(() => ({ deleteSpy: vi.fn() }));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: deleteSpy, transaction: vi.fn() },
}));

// Override only the reused site-scope helpers (spread the rest so other
// importers still get the real exports). These drive SR5-05 (automations) and
// SR5-06 (reports) which delegate their site check to these functions.
vi.mock('./automationRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./automationRuntime')>();
  return { ...actual, checkAutomationTargetsWithinSiteScope: vi.fn() };
});
vi.mock('./reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reportGenerationService')>();
  return { ...actual, siteScopeRequestAllowed: vi.fn() };
});

import { db } from '../db';
import { registerFleetTools } from './aiToolsFleet';
import { checkAutomationTargetsWithinSiteScope } from './automationRuntime';
import { siteScopeRequestAllowed } from './reportGenerationService';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockCheck = checkAutomationTargetsWithinSiteScope as unknown as ReturnType<typeof vi.fn>;
const mockSiteScopeReq = siteScopeRequestAllowed as unknown as ReturnType<typeof vi.fn>;

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

describe('manage_patches — per-device site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('install denies when a target device is owned but outside the caller site scope', async () => {
    // ownedDevices returns the device (org match) WITH its real forbidden site —
    // the site gate (not org ownership) must reject it. Proves the gate is live.
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }),
    });
    const r = await handlerFor('manage_patches')({ action: 'install', patchIds: ['p1'], deviceIds: ['d1'] }, makeAuth(['site-A']));
    expect(r).toContain('Access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('install allows an unrestricted caller (no regression)', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) });
    (db as any).insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'job1' }]) }) }));
    const r = await handlerFor('manage_patches')({ action: 'install', patchIds: ['p1'], deviceIds: ['d1'] }, makeAuth(undefined));
    expect(r).not.toContain('Access denied');
  });

  it('rollback denies a device owned but outside the caller site scope', async () => {
    // rollback selects { id, siteId } for the single device; site is forbidden.
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) }),
    });
    const r = await handlerFor('manage_patches')({ action: 'rollback', patchId: 'p1', deviceIds: ['d1'] }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('manage_groups remove_devices — per-device site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only removes in-scope devices; out-of-site device ids are excluded from the delete', async () => {
    let call = 0;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // 1st select: the group row (orgId)
      if (call === 0) { call++; return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1' }]) }) }) }; }
      // 2nd select: candidate devices { id, siteId }
      return { from: () => ({ where: () => Promise.resolve([
        { id: 'd-in', siteId: 'site-A' },
        { id: 'd-out', siteId: 'site-FORBIDDEN' },
      ]) }) };
    });
    let deletedIds: string[] | null = null;
    deleteSpy.mockReturnValue({
      where: (cond: any) => {
        // Capture the device-id list the delete is scoped to by re-running the
        // inArray against a probe. We can't introspect the SQL easily, so the
        // handler must have narrowed the id list before building the condition.
        return Promise.resolve();
      },
    });
    // Spy on inArray indirectly: assert handler reports the skipped count.
    const r = await handlerFor('manage_groups')({ action: 'remove_devices', groupId: 'g1', deviceIds: ['d-in', 'd-out'] }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.success).toBe(true);
    // out-of-site device must be reported as skipped (not silently removed)
    expect(parsed.removed).toBe(1);
    expect(parsed.skipped).toBe(1);
  });

  it('removes nothing (no delete) when all requested devices are out-of-site', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call === 0) { call++; return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1' }]) }) }) }; }
      return { from: () => ({ where: () => Promise.resolve([{ id: 'd-out', siteId: 'site-FORBIDDEN' }]) }) };
    });
    const r = await handlerFor('manage_groups')({ action: 'remove_devices', groupId: 'g1', deviceIds: ['d-out'] }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.removed).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('unrestricted caller removes all requested devices (no regression)', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call === 0) { call++; return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1' }]) }) }) }; }
      return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-Z' }, { id: 'd2', siteId: 'site-Y' }]) }) };
    });
    deleteSpy.mockReturnValue({ where: () => Promise.resolve() });
    const r = await handlerFor('manage_groups')({ action: 'remove_devices', groupId: 'g1', deviceIds: ['d1', 'd2'] }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.success).toBe(true);
    expect(deleteSpy).toHaveBeenCalled();
  });
});

describe('report data device_inventory — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices gets empty inventory', async () => {
    let inventoryRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) };
      }
      inventoryRan = true;
      return { from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }) };
    });
    const r = await handlerFor('generate_report')({ action: 'data', reportType: 'device_inventory' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(0);
    expect(inventoryRan).toBe(false);
  });
});

function makeAuthWithPartner(allowedSiteIds: string[] | undefined, partnerId: string): AuthContext {
  return { ...makeAuth(allowedSiteIds), partnerId };
}

// ── SR5-22: manage_alert_rules ────────────────────────────────────────────────
describe('SR5-22 manage_alert_rules — alert site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('alert_summary narrows via device leftJoin for a site-restricted caller', async () => {
    let leftJoined = false;
    mockDb.select.mockReturnValue({
      from: () => ({
        leftJoin: () => { leftJoined = true; return { where: () => Promise.resolve([{ total: 0, active: 0 }]) }; },
        where: () => Promise.resolve([{ total: 99, active: 99 }]),
      }),
    });
    const r = await handlerFor('manage_alert_rules')({ action: 'alert_summary' }, makeAuth(['site-A']));
    expect(leftJoined).toBe(true);
    expect(JSON.parse(r).summary.total).toBe(0);
  });

  it('alert_summary uses no device join for an unrestricted caller (no regression)', async () => {
    let leftJoined = false;
    mockDb.select.mockReturnValue({
      from: () => ({
        leftJoin: () => { leftJoined = true; return { where: () => Promise.resolve([{ total: 0 }]) }; },
        where: () => Promise.resolve([{ total: 99, active: 99 }]),
      }),
    });
    const r = await handlerFor('manage_alert_rules')({ action: 'alert_summary' }, makeAuth(undefined));
    expect(leftJoined).toBe(false);
    expect(JSON.parse(r).summary.total).toBe(99);
  });

  it('get_rule denies a rule that targets a forbidden site (and never queries alerts)', async () => {
    let selectCalls = 0;
    mockDb.select.mockImplementation(() => {
      selectCalls++;
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'r1', targetType: 'site', targetId: 'site-FORBIDDEN' }]) }) }) };
    });
    const r = await handlerFor('manage_alert_rules')({ action: 'get_rule', ruleId: 'r1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
    // Only the rule lookup ran — the recent-alerts query was short-circuited.
    expect(selectCalls).toBe(1);
  });
});

// ── SR5-03: manage_deployments ────────────────────────────────────────────────
describe('SR5-03 manage_deployments — site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pause denies a site-restricted caller when a member device is out of site', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call === 0) { call++; return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'dep1', name: 'D', status: 'running' }]) }) }) }; }
      return { from: () => ({ leftJoin: () => ({ where: () => Promise.resolve([{ siteId: 'site-FORBIDDEN' }]) }) }) };
    });
    (db as any).update = vi.fn();
    const r = await handlerFor('manage_deployments')({ action: 'pause', deploymentId: 'dep1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('device_status returns empty for a zero-site restricted caller (no device query)', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'dep1' }]) }) }) });
    const r = await handlerFor('manage_deployments')({ action: 'device_status', deploymentId: 'dep1' }, makeAuth([]));
    expect(JSON.parse(r).showing).toBe(0);
  });

  it('pause allows an unrestricted caller (no regression)', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'dep1', name: 'D', status: 'running' }]) }) }) });
    (db as any).update = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) }));
    const r = await handlerFor('manage_deployments')({ action: 'pause', deploymentId: 'dep1' }, makeAuth(undefined));
    expect(JSON.parse(r).success).toBe(true);
  });
});

// ── SR5-04: manage_groups ─────────────────────────────────────────────────────
describe('SR5-04 manage_groups — group site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get denies a site-restricted caller for an out-of-site group', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1', siteId: 'site-FORBIDDEN' }]) }) }) });
    const r = await handlerFor('manage_groups')({ action: 'get', groupId: 'g1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('list returns empty for a zero-site restricted caller', async () => {
    const r = await handlerFor('manage_groups')({ action: 'list' }, makeAuth([]));
    expect(JSON.parse(r).showing).toBe(0);
  });

  it('create rejects a siteId outside the caller site scope (no insert)', async () => {
    (db as any).insert = vi.fn();
    const r = await handlerFor('manage_groups')({ action: 'create', name: 'X', siteId: 'site-FORBIDDEN' }, makeAuth(['site-A']));
    expect(r).toContain('Access denied');
    expect((db as any).insert).not.toHaveBeenCalled();
  });

  it('create allows an unrestricted caller (no regression)', async () => {
    (db as any).insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'g1', name: 'X' }]) }) }));
    const r = await handlerFor('manage_groups')({ action: 'create', name: 'X', siteId: 'site-Z' }, makeAuth(undefined));
    expect(JSON.parse(r).success).toBe(true);
  });
});

// ── SR5-05: manage_automations ────────────────────────────────────────────────
describe('SR5-05 manage_automations — target site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  const autoRow = { id: 'a1', orgId: 'org-1', partnerId: null, trigger: {}, conditions: {} };

  it('get denies when the target site-scope check fails', async () => {
    mockCheck.mockResolvedValue({ ok: false, unbounded: false, outOfScopeDeviceIds: ['d1'] });
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([autoRow]) }) }) });
    const r = await handlerFor('manage_automations')({ action: 'get', automationId: 'a1' }, makeAuth(['site-A']));
    expect(r).toContain('target sites denied');
  });

  it('run denies an unbounded (all-devices) automation for a restricted caller', async () => {
    mockCheck.mockResolvedValue({ ok: false, unbounded: true, outOfScopeDeviceIds: [] });
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([autoRow]) }) }) });
    (db as any).insert = vi.fn();
    const r = await handlerFor('manage_automations')({ action: 'run', automationId: 'a1' }, makeAuth(['site-A']));
    expect(r).toContain('target all devices');
    expect((db as any).insert).not.toHaveBeenCalled();
  });

  it('get allows an unrestricted caller (check passes)', async () => {
    mockCheck.mockResolvedValue({ ok: true, unbounded: false, outOfScopeDeviceIds: [] });
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([autoRow]) }) }) });
    const r = await handlerFor('manage_automations')({ action: 'get', automationId: 'a1' }, makeAuth(undefined));
    expect(JSON.parse(r).automation.id).toBe('a1');
  });

  it('list omits automations that fail the site-scope check', async () => {
    mockCheck.mockImplementation(async (a: any) => ({ ok: a.id === 'keep', unbounded: false, outOfScopeDeviceIds: [] }));
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([
      { id: 'keep', name: 'K', trigger: {}, orgId: 'org-1', partnerId: null, conditions: {} },
      { id: 'drop', name: 'D', trigger: {}, orgId: 'org-1', partnerId: null, conditions: {} },
    ]) }) }) }) });
    const r = await handlerFor('manage_automations')({ action: 'list' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(1);
    expect(parsed.automations[0].id).toBe('keep');
  });
});

// ── SR5-06: generate_report (history/download scope gate) ──────────────────────
describe('SR5-06 generate_report — run scope gating', () => {
  beforeEach(() => vi.clearAllMocks());

  const runRow = { id: 'run1', reportId: 'rep1', status: 'completed', reportOrgId: 'org-1', reportConfig: {}, outputUrl: 'u', reportName: 'N', reportType: 't', reportFormat: 'csv', rowCount: 1, completedAt: null };

  it('download denies when the report scope exceeds the caller sites', async () => {
    mockSiteScopeReq.mockResolvedValue(false);
    mockDb.select.mockReturnValue({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([runRow]) }) }) }) });
    const r = await handlerFor('generate_report')({ action: 'download', reportRunId: 'run1' }, makeAuth(['site-A']));
    expect(r).toContain('report scope denied');
  });

  it('download allows an unrestricted caller (no regression)', async () => {
    mockSiteScopeReq.mockResolvedValue(true);
    mockDb.select.mockReturnValue({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([runRow]) }) }) }) });
    const r = await handlerFor('generate_report')({ action: 'download', reportRunId: 'run1' }, makeAuth(undefined));
    expect(JSON.parse(r).outputUrl).toBe('u');
  });

  it('report data alert_summary zeroes out for a zero-site restricted caller', async () => {
    // resolveSiteAllowedDeviceIds → org devices, all filtered out by the empty allowlist.
    mockDb.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-A' }]) }) });
    const r = await handlerFor('generate_report')({ action: 'data', reportType: 'alert_summary' }, makeAuth([]));
    expect(JSON.parse(r).data.total).toBe(0);
  });
});

// ── SR5-20: manage_patches compliance ─────────────────────────────────────────
describe('SR5-20 manage_patches — compliance site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recomputes (zeroed) for a zero-site restricted caller instead of the org snapshot', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call === 0) { call++; return { from: () => ({ where: () => Promise.resolve([{ total: 3, pending: 1 }]) }) }; }
      // resolveSiteAllowedDeviceIds — org devices filtered out by empty allowlist.
      return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-A' }]) }) };
    });
    const r = await handlerFor('manage_patches')({ action: 'compliance' }, makeAuthWithPartner([], 'p1'));
    const parsed = JSON.parse(r);
    expect(parsed.snapshot.siteScoped).toBe(true);
    expect(parsed.snapshot.totalDevices).toBe(0);
    expect(parsed.approvals.total).toBe(3);
  });

  it('returns the precomputed snapshot for an unrestricted caller (no regression)', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call === 0) { call++; return { from: () => ({ where: () => Promise.resolve([{ total: 3 }]) }) }; }
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'snap1', totalDevices: 10 }]) }) }) }) };
    });
    const r = await handlerFor('manage_patches')({ action: 'compliance' }, makeAuthWithPartner(undefined, 'p1'));
    expect(JSON.parse(r).snapshot.id).toBe('snap1');
  });
});
