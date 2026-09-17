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

// ── 2b. manage_patches list — the org-wide catalog is a sibling inventory ────
describe('manage_patches list — patch inventory carries both axes', () => {
  /** First select = the org device scan (resolveSiteAllowedDeviceIds); second = the list. */
  function mockList(orgDevices: Array<{ id: string; siteId: string | null }>) {
    const wheres: SQL[] = [];
    let call = 0;
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: (cond: SQL) => {
          wheres.push(cond);
          return call++ === 0 && orgDevices.length > 0
            ? Promise.resolve(orgDevices)
            : { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
        },
        innerJoin: () => ({
          where: (cond: SQL) => { wheres.push(cond); return { orderBy: () => ({ limit: () => Promise.resolve([]) }) }; },
        }),
      }),
    }));
    (mockDb as any).selectDistinct = mockDb.select;
    return wheres;
  }
  const render = (cond: SQL) => new PgDialect().sqlToQuery(cond);

  it.each([
    ['device-bound run', () => deviceBoundAuth()],
    ['device-LESS run', () => deviceLessRunAuth()],
  ])('%s: the org-wide list is narrowed to the run device, never a sibling', async (_name, auth) => {
    const wheres = mockList([{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }]);
    await handlerFor('manage_patches')({ action: 'list' }, auth());
    const listed = render(wheres.at(-1)!);
    expect(listed.sql).toMatch(/"device_id" in \(/);
    expect(listed.params).toContain('dev-1');
    expect(listed.params).not.toContain('dev-2');
  });

  it('unrestricted caller: no device narrowing and no org device scan', async () => {
    const wheres = mockList([]);
    await handlerFor('manage_patches')({ action: 'list' }, unrestrictedAuth());
    expect(wheres).toHaveLength(1);
    expect(render(wheres[0]!).sql).not.toMatch(/"device_id" in \(/);
  });
});

// ── 3. manage_deployments control actions ────────────────────────────────────
describe('manage_deployments — control actions carry the device axis', () => {
  function mockDeployment(members: Array<{ deviceId: string; siteId: string }>) {
    // The membership query is batched by deployment id (one query for any
    // number of deployments), so each member row carries its deploymentId.
    const memberRows = members.map((m) => ({ deploymentId: 'dep-1', ...m }));
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'dep-1', name: 'D', status: 'draft' }]) }) }) };
      }
      return { from: () => ({ leftJoin: () => ({ where: () => Promise.resolve(memberRows) }) }) };
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

// ── 9. alert RULES: the target gate must apply without a site axis ───────────
/**
 * #6096 C2 — `alertRuleTargetDenied` opened with
 * `if (!auth.allowedSiteIds || !auth.canAccessSite) return false`, so a
 * device-LESS analysis run (device axis only) was treated as unrestricted and
 * every org-wide rule resolved for it. The second half of that guard also
 * failed OPEN when `allowedSiteIds` was set but `canAccessSite` was not.
 */
describe('manage_alert_rules target gate — device axis without a site axis', () => {
  function mockRules(rules: Array<Record<string, unknown>>) {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(rules),
              orderBy: () => ({ limit: () => Promise.resolve(rules) }),
            }),
          }),
        };
      }
      const chain: any = {
        leftJoin: () => chain,
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
          then: (resolve: any) => resolve([{ total: 0 }]),
        }),
      };
      return { from: () => chain };
    });
  }

  const ALL_RULE = { id: 'r-all', name: 'Org-wide', targetType: 'all', targetId: 'org-1', orgId: 'org-1' };
  const SITE_RULE = { id: 'r-site', name: 'Site', targetType: 'site', targetId: 'site-1', orgId: 'org-1' };
  const SIBLING_DEVICE_RULE = { id: 'r-dev2', name: 'Sibling', targetType: 'device', targetId: 'dev-2', orgId: 'org-1' };

  it('get_rule hides an org-wide ("all") rule from a device-LESS run', async () => {
    mockRules([ALL_RULE]);
    const r = await handlerFor('manage_alert_rules')({ action: 'get_rule', ruleId: 'r-all' }, deviceLessRunAuth());
    expect(JSON.parse(r).error).toMatch(/not found or access denied/i);
  });

  it('get_rule hides a rule targeting a SIBLING DEVICE from a device-LESS run', async () => {
    mockRules([SIBLING_DEVICE_RULE]);
    const r = await handlerFor('manage_alert_rules')({ action: 'get_rule', ruleId: 'r-dev2' }, deviceLessRunAuth());
    expect(JSON.parse(r).error).toMatch(/not found or access denied/i);
  });

  it('keeps a SITE-shaped rule reachable for a device-LESS run (#6096 D2 — the alert DATA is narrowed instead)', async () => {
    mockRules([SITE_RULE]);
    const body = JSON.parse(await handlerFor('manage_alert_rules')({ action: 'get_rule', ruleId: 'r-site' }, deviceLessRunAuth()));
    expect(body.error).toBeUndefined();
    expect(body.rule.id).toBe('r-site');
  });

  it('list_rules drops org-wide and sibling-device rules for a device-LESS run', async () => {
    mockRules([ALL_RULE, SIBLING_DEVICE_RULE]);
    const body = JSON.parse(await handlerFor('manage_alert_rules')({ action: 'list_rules' }, deviceLessRunAuth()));
    expect(body.rules).toEqual([]);
    expect(body.showing).toBe(0);
  });

  it('a device-BOUND run keeps a rule targeting its own site (no regression)', async () => {
    mockRules([SITE_RULE]);
    const body = JSON.parse(await handlerFor('manage_alert_rules')({ action: 'get_rule', ruleId: 'r-site' }, deviceBoundAuth()));
    expect(body.error).toBeUndefined();
    expect(body.rule.id).toBe('r-site');
  });

  it('an unrestricted caller keeps every rule (no regression)', async () => {
    mockRules([ALL_RULE, SITE_RULE]);
    const body = JSON.parse(await handlerFor('manage_alert_rules')({ action: 'list_rules' }, unrestrictedAuth()));
    expect(body.showing).toBe(2);
  });
});

// ── 10. manage_automations list ──────────────────────────────────────────────
describe('manage_automations list — the target scan runs for the device axis too', () => {
  const AUTO = {
    id: 'auto-1', name: 'A', description: null, enabled: true, trigger: {}, onFailure: 'stop',
    lastRunAt: null, runCount: 0, createdAt: new Date('2026-09-01T00:00:00.000Z'),
    orgId: 'org-1', partnerId: null, conditions: {}, managedByMonitorId: null,
  };

  function mockList(rows: unknown[]) {
    mockDb.select.mockImplementation(() => {
      const tail: any = {
        orderBy: () => tail,
        limit: () => tail,
        offset: () => Promise.resolve(rows),
        then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
      };
      return { from: () => ({ where: () => tail }) };
    });
  }

  it('omits an automation that targets a sibling device (device-LESS run)', async () => {
    mockList([AUTO]);
    automationTargetMock.mockResolvedValue(['dev-2']);
    const body = JSON.parse(await handlerFor('manage_automations')({ action: 'list' }, deviceLessRunAuth()));
    expect(body.automations).toEqual([]);
    expect(body.showing).toBe(0);
  });

  it('keeps an automation that targets only the run device', async () => {
    mockList([AUTO]);
    automationTargetMock.mockResolvedValue(['dev-1']);
    const body = JSON.parse(await handlerFor('manage_automations')({ action: 'list' }, deviceLessRunAuth()));
    expect(body.showing).toBe(1);
    expect(body.automations[0].id).toBe('auto-1');
  });

  it('an unrestricted caller lists everything and resolves no targets', async () => {
    mockList([AUTO]);
    const body = JSON.parse(await handlerFor('manage_automations')({ action: 'list' }, unrestrictedAuth()));
    expect(body.showing).toBe(1);
    expect(automationTargetMock).not.toHaveBeenCalled();
  });
});

// ── 11. manage_patches compliance ────────────────────────────────────────────
describe('manage_patches compliance — the org-wide snapshot is not for narrowed runs', () => {
  function mockCompliance(orgDevices: Array<{ id: string; siteId: string }>) {
    mockDb.select.mockImplementation((cols?: any) => {
      const keys = cols ? Object.keys(cols) : [];
      if (keys.length === 2 && keys.includes('id') && keys.includes('siteId')) {
        return { from: () => ({ where: () => Promise.resolve(orgDevices) }) };
      }
      if (keys.includes('devicesNeedingPatches')) {
        return { from: () => ({ where: () => Promise.resolve([{ pending: 2, installed: 1, failed: 0, missing: 1, devicesNeedingPatches: 1 }]) }) };
      }
      if (keys.includes('total')) {
        return { from: () => ({ where: () => Promise.resolve([{ total: 3 }]) }) };
      }
      // precomputed org-wide snapshot
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'snap-1', totalDevices: 999 }]) }) }) }) };
    });
  }

  it('recomputes over the allowlist for a device-LESS run instead of returning the org snapshot', async () => {
    mockCompliance([{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }]);
    const body = JSON.parse(await handlerFor('manage_patches')({ action: 'compliance' }, deviceLessRunAuth()));
    expect(body.snapshot.id).toBeUndefined();
    expect(body.snapshot.siteScoped).toBe(true);
    expect(body.snapshot.totalDevices).toBe(1);
  });

  it('an unrestricted caller still gets the precomputed snapshot (no regression)', async () => {
    mockCompliance([]);
    const body = JSON.parse(await handlerFor('manage_patches')({ action: 'compliance' }, unrestrictedAuth()));
    expect(body.snapshot.id).toBe('snap-1');
  });
});

// ── 12. manage_groups update / delete reach every member ─────────────────────
/**
 * #6096 I2 — update/delete were gated on the GROUP's site alone. Deleting a
 * group removes every member's membership and reconciles peripheral policy for
 * all of them; updating one can rewrite the dynamic `filterConditions` that
 * decide who is in it. Both reach devices, so the device axis applies.
 */
describe('manage_groups update/delete — the device axis covers the membership', () => {
  function mockGroupMembers(memberIds: Array<string | null>) {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call++ === 0) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1', siteId: 'site-1' }]) }) }) };
      }
      return { from: () => ({ where: () => Promise.resolve(memberIds.map((deviceId) => ({ deviceId }))) }) };
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
  }

  it('denies delete when the group holds a sibling device at the same site', async () => {
    mockGroupMembers(['dev-1', 'dev-2']);
    const r = await handlerFor('manage_groups')({ action: 'delete', groupId: 'g1' }, deviceBoundAuth());
    expect(JSON.parse(r).error).toMatch(/access denied|cannot act on the fleet/i);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('denies delete for a device-LESS run whose group reaches other devices', async () => {
    mockGroupMembers(['dev-2']);
    const r = await handlerFor('manage_groups')({ action: 'delete', groupId: 'g1' }, deviceLessRunAuth());
    expect(JSON.parse(r).error).toMatch(/access denied|cannot act on the fleet/i);
  });

  it('denies update when the group holds a sibling device', async () => {
    mockGroupMembers(['dev-1', 'dev-2']);
    const r = await handlerFor('manage_groups')({ action: 'update', groupId: 'g1', name: 'renamed' }, deviceBoundAuth());
    expect(JSON.parse(r).error).toMatch(/access denied|cannot act on the fleet/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('denies a filterConditions rewrite even when the group is currently in scope', async () => {
    mockGroupMembers(['dev-1']);
    const r = await handlerFor('manage_groups')(
      { action: 'update', groupId: 'g1', filterConditions: { logic: 'and', conditions: [] } },
      deviceBoundAuth(),
    );
    expect(JSON.parse(r).error).toMatch(/access denied|cannot act on the fleet/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('still allows a rename when every member is the run device', async () => {
    mockGroupMembers(['dev-1']);
    const r = await handlerFor('manage_groups')({ action: 'update', groupId: 'g1', name: 'renamed' }, deviceBoundAuth());
    expect(JSON.parse(r).success).toBe(true);
  });

  it('a site-restricted human (no device ceiling) is unaffected', async () => {
    const auth = deviceBoundAuth() as any;
    delete auth.allowedDeviceIds;
    mockGroupMembers(['dev-1', 'dev-2']);
    const r = await handlerFor('manage_groups')({ action: 'update', groupId: 'g1', name: 'renamed' }, auth);
    expect(JSON.parse(r).success).toBe(true);
  });
});
