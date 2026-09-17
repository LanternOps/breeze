import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Exact-device axis for the fleet tools (#6096).
 *
 * `agentAuthContext.ts` pins `auth.allowedDeviceIds` to the run's device (and
 * `allowedSiteIds` to that device's site). The site pin admits every SIBLING
 * device in the same site, so any fleet tool bounded only by site — or by
 * nothing — lets a device-bound run read or act on `dev-2`. A device-LESS
 * analysis run carries `allowedDeviceIds` with NO site axis at all, so guards
 * written `if (auth.allowedSiteIds && …)` no-op for it entirely.
 */
const { deleteSpy, reportScopeMocks, reportPreflightMock, patchHelperMocks, automationTargetMock, previewMock } = vi.hoisted(() => ({
  deleteSpy: vi.fn(),
  reportPreflightMock: vi.fn(),
  automationTargetMock: vi.fn(),
  previewMock: vi.fn(async () => ({ totalCount: 0, devices: [], evaluatedAt: new Date() })),
  patchHelperMocks: {
    upsertPatchApproval: vi.fn(async () => undefined),
    resolvePartnerIdForOrg: vi.fn(async () => 'p1'),
    declineAllRingApprovals: vi.fn(async () => ({ ringIds: [], failedRingIds: [] })),
  },
  reportScopeMocks: {
    resolveRequestReportAuthority: vi.fn(),
    resolveRequestReportAuthorityMap: vi.fn(),
    decodeSiteScope: vi.fn(),
    isSiteScopeSubset: vi.fn(),
    intersectSiteScopes: vi.fn(),
    siteScopeFingerprint: vi.fn(),
    persistedSiteScopeValues: vi.fn(),
    reportDefinitionScopeSqlPredicate: vi.fn(),
    reportDefinitionMultiOrgScopeSqlPredicate: vi.fn(),
    unrestrictedReportDefinitionScopeSqlPredicate: vi.fn(),
    reportRunScopeSqlPredicate: vi.fn(),
    reportRunMultiOrgScopeSqlPredicate: vi.fn(),
    unrestrictedReportRunScopeSqlPredicate: vi.fn(),
  },
}));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: deleteSpy, transaction: vi.fn() },
}));
vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: vi.fn(async () => undefined),
}));
vi.mock('./automationRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./automationRuntime')>();
  return {
    ...actual,
    checkAutomationTargetsWithinSiteScope: vi.fn(async () => ({ ok: true, outOfScopeDeviceIds: [], unbounded: false })),
    resolveAutomationTargetDeviceIds: (...args: unknown[]) => automationTargetMock(...args),
  };
});
vi.mock('./reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reportGenerationService')>();
  return { ...actual, assertReportExecutionPreflight: (...args: unknown[]) => reportPreflightMock(...args) };
});
vi.mock('./siteScope', () => reportScopeMocks);
vi.mock('./filterEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./filterEngine')>();
  return { ...actual, evaluateFilterWithPreview: (...args: unknown[]) => (previewMock as any)(...args) };
});
vi.mock('../routes/patches/helpers', () => patchHelperMocks);

import { db } from '../db';
import { registerFleetTools } from './aiToolsFleet';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetTools(reg);
  return reg.get(name)!.handler;
}

/** Device-bound preconfigured run: one site, one device. */
function deviceBoundAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'ai_agent', agentId: 'ag-1', runId: 'run-1' },
    user: { id: 'ag-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null, partnerId: 'p1', orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], partnerOrgAccess: null,
    orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: ['site-1'], canAccessSite: (site?: string | null) => site === 'site-1',
    allowedDeviceIds: ['dev-1'],
    ...overrides,
  } as unknown as AuthContext;
}

/** Device-LESS analysis run: frozen device set, NO site axis. */
function deviceLessRunAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  const auth = deviceBoundAuth(overrides) as any;
  delete auth.allowedSiteIds;
  delete auth.canAccessSite;
  return auth as AuthContext;
}

function unrestrictedAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  const auth = deviceLessRunAuth(overrides) as any;
  delete auth.allowedDeviceIds;
  return auth as AuthContext;
}

/** A caller that clears the partner-wide gate on manage_patches approvals. */
const PARTNER_ADMIN = { scope: 'partner', partnerOrgAccess: 'all', partnerId: 'p1' } as Partial<AuthContext>;

beforeEach(() => {
  vi.clearAllMocks();
  patchHelperMocks.resolvePartnerIdForOrg.mockResolvedValue('p1' as never);
  reportScopeMocks.resolveRequestReportAuthority.mockImplementation(
    async (auth: AuthContext, orgId: string) => ({
      ok: true,
      authority: {
        principalKind: 'user',
        scope: auth.allowedSiteIds === undefined
          ? { version: 1, kind: 'unrestricted', orgId }
          : { version: 1, kind: 'restricted', orgId, siteIds: auth.allowedSiteIds },
        principalUserId: auth.user.id,
        capturedAt: new Date('2026-09-16T00:00:00.000Z'),
        fingerprint: 'a'.repeat(64),
      },
    }),
  );
});

// ── 1. manage_patches approvals are fleet-wide policy ────────────────────────
describe('manage_patches approvals — device/site-narrowed callers cannot set fleet policy', () => {
  it('denies approve for a partner admin bound to one device', async () => {
    const r = await handlerFor('manage_patches')(
      { action: 'approve', patchId: 'p-1' },
      deviceBoundAuth(PARTNER_ADMIN),
    );
    expect(JSON.parse(r).error).toMatch(/cannot act on the fleet|organization-wide/i);
    expect(patchHelperMocks.upsertPatchApproval).not.toHaveBeenCalled();
  });

  it('denies bulk_approve for a device-LESS analysis run', async () => {
    const r = await handlerFor('manage_patches')(
      { action: 'bulk_approve', patchIds: ['p-1'] },
      deviceLessRunAuth(PARTNER_ADMIN),
    );
    expect(JSON.parse(r).error).toMatch(/cannot act on the fleet/i);
    expect(patchHelperMocks.upsertPatchApproval).not.toHaveBeenCalled();
  });

  it('denies defer for a site-restricted (no device axis) partner admin', async () => {
    const auth = deviceBoundAuth(PARTNER_ADMIN) as any;
    delete auth.allowedDeviceIds;
    const r = await handlerFor('manage_patches')({ action: 'defer', patchId: 'p-1' }, auth);
    expect(JSON.parse(r).error).toMatch(/organization-wide|cannot act on the fleet/i);
    expect(patchHelperMocks.upsertPatchApproval).not.toHaveBeenCalled();
  });

  it('still lets an unrestricted partner admin approve (no regression)', async () => {
    const r = await handlerFor('manage_patches')(
      { action: 'approve', patchId: 'p-1' },
      unrestrictedAuth(PARTNER_ADMIN),
    );
    expect(JSON.parse(r).success).toBe(true);
    expect(patchHelperMocks.upsertPatchApproval).toHaveBeenCalled();
  });

  it('scopes the compliance approval counts to the caller org', async () => {
    let approvalCondition: SQL | undefined;
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return { from: () => ({ where: (cond: SQL) => { approvalCondition = cond; return Promise.resolve([{ total: 3 }]); } }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'snap1' }]) }) }) }) };
    });
    await handlerFor('manage_patches')({ action: 'compliance' }, unrestrictedAuth({ partnerId: 'p1' }));
    const rendered = new PgDialect().sqlToQuery(approvalCondition!);
    expect(rendered.sql).toContain('device_patches');
    expect(rendered.params).toContain('org-1');
  });
});

// ── 3. manage_deployments control actions ────────────────────────────────────
describe('manage_deployments — control actions carry the device axis', () => {
  function mockDeployment(members: Array<{ deviceId: string; siteId: string }>) {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'dep-1', name: 'D', status: 'draft' }]) }) }) };
      }
      return { from: () => ({ leftJoin: () => ({ where: () => Promise.resolve(members) }) }) };
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
  }

  it('denies start when the deployment includes a sibling device at the same site', async () => {
    mockDeployment([{ deviceId: 'dev-1', siteId: 'site-1' }, { deviceId: 'dev-2', siteId: 'site-1' }]);
    const r = await handlerFor('manage_deployments')({ action: 'start', deploymentId: 'dep-1' }, deviceBoundAuth());
    expect(JSON.parse(r).error).toContain('access denied');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('still starts a deployment made only of the run device', async () => {
    mockDeployment([{ deviceId: 'dev-1', siteId: 'site-1' }]);
    const r = await handlerFor('manage_deployments')({ action: 'start', deploymentId: 'dep-1' }, deviceBoundAuth());
    expect(JSON.parse(r).success).toBe(true);
  });

  it('denies cancel for a device-LESS run whose deployment reaches other devices', async () => {
    mockDeployment([{ deviceId: 'dev-2', siteId: 'site-9' }]);
    const r = await handlerFor('manage_deployments')({ action: 'cancel', deploymentId: 'dep-1' }, deviceLessRunAuth());
    expect(JSON.parse(r).error).toContain('access denied');
  });

  it('device_status narrows the per-device rows to the allowlist', async () => {
    let dsCondition: SQL | undefined;
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'dep-1', name: 'D', status: 'running' }]) }) }) };
      }
      return { from: () => ({ leftJoin: () => ({ where: (cond: SQL) => { dsCondition = cond; return { limit: () => Promise.resolve([]) }; } }) }) };
    });
    await handlerFor('manage_deployments')({ action: 'device_status', deploymentId: 'dep-1' }, deviceLessRunAuth());
    const rendered = new PgDialect().sqlToQuery(dsCondition!);
    expect(rendered.params).toContain('dev-1');
  });
});

// ── 2. manage_automations run/enable/disable ─────────────────────────────────
describe('manage_automations — run/enable carry the device axis', () => {
  const AUTOMATION = {
    id: 'auto-1', name: 'A', orgId: 'org-1', partnerId: null, trigger: {}, conditions: {},
    managedByAgentId: null, managedByMonitorId: null, enabled: true,
  };

  function mockAutomation() {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([AUTOMATION]) }) }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
    mockDb.insert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: 'run-1' }]) }) });
  }

  it('denies run when the automation targets a sibling device', async () => {
    mockAutomation();
    automationTargetMock.mockResolvedValue(['dev-1', 'dev-2']);
    const r = await handlerFor('manage_automations')({ action: 'run', automationId: 'auto-1' }, deviceBoundAuth());
    expect(JSON.parse(r).error).toMatch(/cannot act on the fleet/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('still runs an automation targeting only the run device', async () => {
    mockAutomation();
    automationTargetMock.mockResolvedValue(['dev-1']);
    const r = await handlerFor('manage_automations')({ action: 'run', automationId: 'auto-1' }, deviceBoundAuth());
    expect(JSON.parse(r).success).toBe(true);
  });

  it('denies disable for a device-LESS run when targets escape the frozen set', async () => {
    mockAutomation();
    automationTargetMock.mockResolvedValue(['dev-2']);
    const r = await handlerFor('manage_automations')({ action: 'disable', automationId: 'auto-1' }, deviceLessRunAuth());
    expect(JSON.parse(r).error).toMatch(/cannot act on the fleet/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('leaves an unrestricted caller untouched (target resolution never runs)', async () => {
    mockAutomation();
    const r = await handlerFor('manage_automations')({ action: 'run', automationId: 'auto-1' }, unrestrictedAuth());
    expect(JSON.parse(r).success).toBe(true);
    expect(automationTargetMock).not.toHaveBeenCalled();
  });
});

// ── 4. manage_groups get / membership_log ────────────────────────────────────
describe('manage_groups — member lists are narrowed to the allowlist', () => {
  function mockGroupWith(rows: Array<Record<string, unknown>>) {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1', siteId: 'site-1' }]) }) }) };
      }
      return { from: () => ({ leftJoin: () => ({ where: () => ({
        limit: () => Promise.resolve(rows),
        orderBy: () => ({ limit: () => Promise.resolve(rows) }),
      }) }) }) };
    });
  }

  it('get drops sibling devices from the member list', async () => {
    mockGroupWith([
      { deviceId: 'dev-1', hostname: 'own' },
      { deviceId: 'dev-2', hostname: 'sibling' },
    ]);
    const body = JSON.parse(await handlerFor('manage_groups')({ action: 'get', groupId: 'g1' }, deviceBoundAuth()));
    expect(body.members.map((m: any) => m.deviceId)).toEqual(['dev-1']);
    expect(body.memberCount).toBe(1);
  });

  it('membership_log drops sibling devices for a device-LESS run', async () => {
    mockGroupWith([
      { deviceId: 'dev-1', hostname: 'own', action: 'added' },
      { deviceId: 'dev-2', hostname: 'sibling', action: 'added' },
    ]);
    const body = JSON.parse(await handlerFor('manage_groups')({ action: 'membership_log', groupId: 'g1' }, deviceLessRunAuth()));
    expect(body.log.map((m: any) => m.deviceId)).toEqual(['dev-1']);
    expect(body.showing).toBe(1);
  });

  it('unrestricted caller sees every member (no regression)', async () => {
    mockGroupWith([
      { deviceId: 'dev-1', hostname: 'own' },
      { deviceId: 'dev-2', hostname: 'sibling' },
    ]);
    const body = JSON.parse(await handlerFor('manage_groups')({ action: 'get', groupId: 'g1' }, unrestrictedAuth()));
    expect(body.members).toHaveLength(2);
  });

  it('preview passes the device allowlist to the filter engine', async () => {
    const body = JSON.parse(await handlerFor('manage_groups')(
      { action: 'preview', filterConditions: { logic: 'and', conditions: [] } },
      deviceBoundAuth(),
    ));
    expect(body.error).toBeUndefined();
    expect(previewMock).toHaveBeenCalled();
    expect((previewMock.mock.calls[0] as any[])[1]).toMatchObject({ allowedDeviceIds: ['dev-1'] });
  });
});

// ── 5. manage_alert_rules ────────────────────────────────────────────────────
describe('manage_alert_rules — alert reads carry the device axis', () => {
  const RULE = { id: 'r1', name: 'R', isActive: true, targetType: 'site', targetId: 'site-1', orgId: 'org-1' };

  function mockRule(capture: (cond: SQL) => void) {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([RULE]) }) }) };
      }
      const chain = {
        leftJoin: () => chain,
        where: (cond: SQL) => { capture(cond); return {
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
          then: (resolve: any) => resolve([{ total: 0, active: 0 }]),
        }; },
      };
      return { from: () => chain };
    });
  }

  it('get_rule narrows recent alerts to the allowlist for a device-LESS run', async () => {
    let cond: SQL | undefined;
    mockRule((c) => { cond = c; });
    await handlerFor('manage_alert_rules')({ action: 'get_rule', ruleId: 'r1' }, deviceLessRunAuth());
    expect(cond, 'a device-LESS run must still narrow the alert read').toBeDefined();
    const rendered = new PgDialect().sqlToQuery(cond!);
    expect(rendered.params).toContain('dev-1');
  });

  it('test_rule narrows the alert count for a device-bound run', async () => {
    let cond: SQL | undefined;
    mockRule((c) => { cond = c; });
    await handlerFor('manage_alert_rules')({ action: 'test_rule', ruleId: 'r1' }, deviceBoundAuth());
    const rendered = new PgDialect().sqlToQuery(cond!);
    expect(rendered.params).toContain('dev-1');
  });

  it('alert_summary narrows to the allowlist', async () => {
    let cond: SQL | undefined;
    const chain: any = {
      leftJoin: () => chain,
      where: (c: SQL) => { cond = c; return Promise.resolve([{ total: 0 }]); },
    };
    mockDb.select.mockReturnValue({ from: () => chain });
    await handlerFor('manage_alert_rules')({ action: 'alert_summary' }, deviceBoundAuth());
    const rendered = new PgDialect().sqlToQuery(cond!);
    expect(rendered.params).toContain('dev-1');
  });

  it('leaves an unrestricted caller unnarrowed (no regression)', async () => {
    let cond: SQL | undefined;
    const chain: any = {
      leftJoin: () => chain,
      where: (c: SQL) => { cond = c; return Promise.resolve([{ total: 0 }]); },
    };
    mockDb.select.mockReturnValue({ from: () => chain });
    await handlerFor('manage_alert_rules')({ action: 'alert_summary' }, unrestrictedAuth());
    expect(cond).toBeUndefined();
  });
});

// ── 6. generate_report ───────────────────────────────────────────────────────
describe('generate_report — device-bound runs cannot mint site-wide reports', () => {
  it('denies generate for a device-bound run', async () => {
    const r = await handlerFor('generate_report')({ action: 'generate', reportType: 'device_inventory' }, deviceBoundAuth());
    expect(JSON.parse(r).error).toMatch(/fixed set of devices/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('denies download for a device-LESS analysis run', async () => {
    const r = await handlerFor('generate_report')({ action: 'download', reportRunId: 'rr-1' }, deviceLessRunAuth());
    expect(JSON.parse(r).error).toMatch(/fixed set of devices/i);
  });

  it('data/device_inventory narrows to the allowlist', async () => {
    let cond: SQL | undefined;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'dev-1', siteId: 'site-1' }]) }) };
      }
      return { from: () => ({ leftJoin: () => ({ where: (c: SQL) => { cond = c; return { orderBy: () => ({ limit: () => Promise.resolve([]) }) }; } }) }) };
    });
    await handlerFor('generate_report')({ action: 'data', reportType: 'device_inventory' }, deviceBoundAuth());
    const rendered = new PgDialect().sqlToQuery(cond!);
    expect(rendered.params).toContain('dev-1');
  });
});

// ── 7. manage_maintenance_windows get ────────────────────────────────────────
/** A result that is both awaitable (row list) and chainable (.orderBy().limit()). */
function hybrid(rows: unknown[]): any {
  const p: any = Promise.resolve(rows);
  p.orderBy = () => ({ limit: () => Promise.resolve([]) });
  return p;
}

describe('manage_maintenance_windows get — device targets are narrowed', () => {
  const WINDOW = {
    id: 'w1', name: 'W', orgId: 'org-1', targetType: 'device',
    siteIds: null, groupIds: null, deviceIds: ['dev-1', 'dev-2'],
    startTime: null, endTime: null, recurrence: 'once', status: 'scheduled',
    suppressAlerts: true, suppressPatching: true,
  };

  function mockWindow() {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve([WINDOW]) }) }) };
      // Either filterWindowsToSiteScope's device-site resolution (awaited) or
      // the occurrences read (.orderBy().limit()), depending on the caller.
      return { from: () => ({ where: () => hybrid([
        { id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' },
      ]) }) };
    });
  }

  it('returns only the run device in the window target list', async () => {
    mockWindow();
    const body = JSON.parse(await handlerFor('manage_maintenance_windows')({ action: 'get', windowId: 'w1' }, deviceBoundAuth()));
    expect(body.window.deviceIds).toEqual(['dev-1']);
  });

  it('unrestricted caller keeps every target (no regression)', async () => {
    mockWindow();
    const body = JSON.parse(await handlerFor('manage_maintenance_windows')({ action: 'get', windowId: 'w1' }, unrestrictedAuth()));
    expect(body.window.deviceIds).toEqual(['dev-1', 'dev-2']);
  });
});

// ── 8. manage_service_monitors ───────────────────────────────────────────────
describe('manage_service_monitors list — narrowed to policies that reach the caller', () => {
  function mockMonitors(assignments: Array<Record<string, unknown>>) {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        const chain: any = {
          innerJoin: () => chain,
          where: () => ({ orderBy: () => Promise.resolve([
            { watchId: 'w1', name: 'svc-a', policyId: 'pol-1' },
            { watchId: 'w2', name: 'svc-b', policyId: 'pol-2' },
          ]) }),
        };
        return { from: () => chain };
      }
      return { from: () => ({ where: () => Promise.resolve(assignments) }) };
    });
  }

  it('drops a policy assigned only to a sibling device', async () => {
    mockMonitors([
      { configPolicyId: 'pol-1', level: 'device', targetId: 'dev-1' },
      { configPolicyId: 'pol-2', level: 'device', targetId: 'dev-2' },
    ]);
    const body = JSON.parse(await handlerFor('manage_service_monitors')({ action: 'list' }, deviceBoundAuth()));
    expect(body.monitors.map((m: any) => m.policyId)).toEqual(['pol-1']);
    expect(body.showing).toBe(1);
  });

  it('keeps an org-wide policy, which reaches the run device too', async () => {
    mockMonitors([
      { configPolicyId: 'pol-1', level: 'organization', targetId: 'org-1' },
      { configPolicyId: 'pol-2', level: 'site', targetId: 'site-9' },
    ]);
    const body = JSON.parse(await handlerFor('manage_service_monitors')({ action: 'list' }, deviceBoundAuth()));
    expect(body.monitors.map((m: any) => m.policyId)).toEqual(['pol-1']);
  });

  it('unrestricted caller sees every monitor and runs no assignment query', async () => {
    let assignmentQueries = 0;
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        const chain: any = {
          innerJoin: () => chain,
          where: () => ({ orderBy: () => Promise.resolve([
            { watchId: 'w1', policyId: 'pol-1' }, { watchId: 'w2', policyId: 'pol-2' },
          ]) }),
        };
        return { from: () => chain };
      }
      assignmentQueries++;
      return { from: () => ({ where: () => Promise.resolve([]) }) };
    });
    const body = JSON.parse(await handlerFor('manage_service_monitors')({ action: 'list' }, unrestrictedAuth()));
    expect(body.showing).toBe(2);
    expect(assignmentQueries).toBe(0);
  });
});
