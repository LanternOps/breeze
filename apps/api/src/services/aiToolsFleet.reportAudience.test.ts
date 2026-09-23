/**
 * #3198 W02, ruling F1 — the org-axis AI report tool (`generate_report`) and
 * the three business report types (audience 'msp_staff').
 *
 *  - An organization-scope caller never sees one: the definition and run
 *    metadata reads and the list carry `reports.type NOT IN (<msp_staff>)`,
 *    and a leaked row is refused anyway (defense in depth).
 *  - generate-by-reportId applies the per-type permission gate (ruling P8)
 *    with the caller's LIVE permission set, before any run row is written —
 *    so a reports:* partner user without invoices:read cannot mint an
 *    orphan pending ar_aging run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { deleteSpy, reportScopeMocks, reportPreflightMock } = vi.hoisted(() => ({
  deleteSpy: vi.fn(),
  reportPreflightMock: vi.fn(),
  reportScopeMocks: {
    // #3198 W01 — mirrors siteScope.reportOwnerOf: exactly one owner axis, or
    // throw. A plain function (not vi.fn) so a mock reset cannot blank it and
    // turn aiToolsFleet's owner guard into a no-op.
    reportOwnerOf: (row: { orgId: string | null; partnerId: string | null }) => {
      const hasOrg = typeof row.orgId === 'string' && row.orgId.length > 0;
      const hasPartner = typeof row.partnerId === 'string' && row.partnerId.length > 0;
      if (hasOrg === hasPartner) throw new Error('report row must have exactly one owner axis');
      return hasOrg ? { orgId: row.orgId as string } : { partnerId: row.partnerId as string };
    },
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

// Override only the reused site-scope helpers (spread the rest so other
// importers still get the real exports). These drive SR5-05 (automations) and
// SR5-06 (reports) which delegate their site check to these functions.
vi.mock('./automationRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./automationRuntime')>();
  return { ...actual, checkAutomationTargetsWithinSiteScope: vi.fn() };
});
vi.mock('./reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reportGenerationService')>();
  return {
    ...actual,
    assertReportExecutionPreflight: (...args: unknown[]) => reportPreflightMock(...args),
  };
});
vi.mock('./siteScope', () => reportScopeMocks);
const permissionsMock = vi.hoisted(() => ({ getUserPermissions: vi.fn() }));
vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: permissionsMock.getUserPermissions };
});

import { db } from '../db';
import { registerFleetTools } from './aiToolsFleet';
import { checkAutomationTargetsWithinSiteScope } from './automationRuntime';
import {
  reportRunScopeSqlPredicate,
  resolveRequestReportAuthority,
} from './siteScope';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockCheck = checkAutomationTargetsWithinSiteScope as unknown as ReturnType<typeof vi.fn>;

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}


const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';

function orgAuth(): AuthContext {
  return { ...makeAuth(undefined), orgId: ORG_ID, accessibleOrgIds: [ORG_ID] };
}
function partnerAuth(): AuthContext {
  return {
    ...makeAuth(undefined),
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    accessibleOrgIds: [ORG_ID],
  } as AuthContext;
}

const definition = (type: string) => ({
  id: 'rep1', orgId: ORG_ID, partnerId: null, name: 'R', type, config: {},
  executionScopeVersion: 1, executionScopeKind: 'unrestricted', executionScopeSiteIds: null,
  executionScopeUserId: 'u1', executionScopeFingerprint: 'f'.repeat(64),
  executionScopeCapturedAt: new Date('2026-07-25T12:00:00.000Z'), executionScopePrincipalKind: 'user',
});
const run = (type: string) => ({
  ...definition(type), id: 'run1', reportId: 'rep1', status: 'completed', reportOrgId: ORG_ID,
  reportType: type, reportName: 'R', reportFormat: 'csv', outputUrl: 'u', rowCount: 1, completedAt: null,
  type,
});

const wheres: unknown[] = [];
/** Every select resolves `row`; each WHERE condition is recorded. */
function selectReturning(row: unknown) {
  mockDb.select.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy']) chain[m] = () => chain;
    chain.where = (c: unknown) => { wheres.push(c); return chain; };
    chain.limit = () => Promise.resolve(row ? [row] : []);
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(row ? [row] : []).then(res, rej);
    return chain;
  });
}

/** Recursively: does this drizzle SQL tree contain `NOT IN` over reports.type binding the business types? */
function excludesBusinessTypes(node: unknown, seen = new Set<unknown>()): boolean {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    const text = chunks.map((c) => (c && typeof c === 'object' && 'value' in c ? String((c as { value: unknown }).value) : '')).join('');
    if (/not in/i.test(text)) {
      const params = chunks.flatMap((c) => Array.isArray(c) ? c : [c])
        .map((c) => (c && typeof c === 'object' && 'value' in c ? (c as { value: unknown }).value : undefined));
      const flat = JSON.stringify(params);
      if (['ar_aging', 'technician_time_billability', 'ticket_sla_attainment'].every((t) => flat.includes(t))) return true;
    }
    return chunks.some((c) => excludesBusinessTypes(c, seen));
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  wheres.length = 0;
  reportScopeMocks.resolveRequestReportAuthority.mockResolvedValue({
    ok: true,
    authority: {
      principalKind: 'user',
      scope: { version: 1, kind: 'unrestricted', orgId: ORG_ID },
      principalUserId: 'u1',
      capturedAt: new Date('2026-07-25T12:00:00.000Z'),
      fingerprint: 'f'.repeat(64),
    },
  });
  reportScopeMocks.resolveRequestReportAuthorityMap.mockResolvedValue(new Map());
  reportScopeMocks.decodeSiteScope.mockReturnValue({ version: 1, kind: 'unrestricted', orgId: ORG_ID });
  reportScopeMocks.isSiteScopeSubset.mockReturnValue(true);
  reportScopeMocks.intersectSiteScopes.mockReturnValue({ version: 1, kind: 'unrestricted', orgId: ORG_ID });
  reportScopeMocks.siteScopeFingerprint.mockReturnValue('f'.repeat(64));
  reportScopeMocks.persistedSiteScopeValues.mockReturnValue({});
  reportScopeMocks.reportDefinitionScopeSqlPredicate.mockReturnValue(undefined);
  reportScopeMocks.reportDefinitionMultiOrgScopeSqlPredicate.mockReturnValue(undefined);
  reportScopeMocks.reportRunScopeSqlPredicate.mockReturnValue(undefined);
  mockDb.insert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: 'new-run' }]) }) });
  mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
  permissionsMock.getUserPermissions.mockResolvedValue({ permissions: [{ resource: '*', action: '*' }] });
});

describe('generate_report hides msp_staff types from an org-scope caller (ruling F1)', () => {
  it('generate by reportId: the metadata read excludes business types; a leaked row is refused, no run', async () => {
    selectReturning(definition('ar_aging'));
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'generate', reportId: 'rep1' }, orgAuth()));
    expect(excludesBusinessTypes(wheres[0])).toBe(true);
    expect(r.success).not.toBe(true);
    expect(r.error).toBe('Report not found or access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('download: the run metadata read excludes business types; a leaked run is refused', async () => {
    selectReturning(run('technician_time_billability'));
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'download', reportRunId: 'run1' }, orgAuth()));
    expect(excludesBusinessTypes(wheres[0])).toBe(true);
    expect(r.error).toBe('Report run not found');
  });

  it('history: a leaked business definition is refused', async () => {
    selectReturning(definition('ticket_sla_attainment'));
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'history', reportId: 'rep1' }, orgAuth()));
    expect(r.error).toBe('Report not found or access denied');
  });

  it('list: carries the exclusion for an org-scope caller, not for a partner caller', async () => {
    selectReturning(null);
    await handlerFor('generate_report')({ action: 'list' }, orgAuth());
    expect(excludesBusinessTypes(wheres[0])).toBe(true);
    wheres.length = 0;
    await handlerFor('generate_report')({ action: 'list' }, partnerAuth());
    expect(excludesBusinessTypes(wheres[0])).toBe(false);
  });

  it('positive control: an org-scope caller still generates a device_inventory report', async () => {
    selectReturning(definition('device_inventory'));
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'generate', reportId: 'rep1' }, orgAuth()));
    expect(r.success).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });
});

describe('generate_report by reportId applies the per-type permission gate (ruling P8)', () => {
  it('refuses a partner caller without invoices:read on an ar_aging definition, before any run row', async () => {
    permissionsMock.getUserPermissions.mockResolvedValue({
      permissions: [{ resource: 'reports', action: '*' }, { resource: 'tickets', action: 'read' }],
    });
    selectReturning(definition('ar_aging'));
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'generate', reportId: 'rep1' }, partnerAuth()));
    expect(r.error).toBe('Insufficient permissions');
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(permissionsMock.getUserPermissions).toHaveBeenCalledWith(
      'u1', expect.objectContaining({ partnerId: PARTNER_ID, scope: 'partner' }),
    );
  });

  it('refuses when no permission set resolves at all', async () => {
    permissionsMock.getUserPermissions.mockResolvedValue(null);
    selectReturning(definition('ar_aging'));
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'generate', reportId: 'rep1' }, partnerAuth()));
    expect(r.error).toBe('Insufficient permissions');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('positive control: a partner caller holding invoices:read generates it', async () => {
    permissionsMock.getUserPermissions.mockResolvedValue({
      permissions: [{ resource: 'reports', action: '*' }, { resource: 'invoices', action: 'read' }],
    });
    selectReturning(definition('ar_aging'));
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'generate', reportId: 'rep1' }, partnerAuth()));
    expect(r.success).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('a pre-#3198 type resolves no permission set (no extra query)', async () => {
    selectReturning(definition('device_inventory'));
    await handlerFor('generate_report')({ action: 'generate', reportId: 'rep1' }, partnerAuth());
    expect(permissionsMock.getUserPermissions).not.toHaveBeenCalled();
  });
});
