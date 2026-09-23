/**
 * #3198 W01 — owner-aware access helpers. A partner-owned report row has
 * `org_id NULL`; every helper must resolve it through the PARTNER axis
 * (`resolveRequestPartnerReportAuthority`) and never hand an org resolver a
 * NULL org id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURED_AT = new Date('2026-09-21T12:00:00.000Z');
/** Ruling P8b: the loaders take the caller's resolved permissions. */
const ALL_PERMS = { permissions: [{ resource: '*', action: '*' }] };

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown> | null>,
  wheres: [] as unknown[],
  partnerAuthority: null as unknown,
  orgAuthority: null as unknown,
}));

vi.mock('../../db', () => {
  const select = vi.fn((projection?: Record<string, unknown>) => {
    const next = state.rows.shift();
    const rows = next === null || next === undefined ? [] : [next];
    const projected = projection
      ? rows.map((source) => Object.fromEntries(Object.keys(projection).map((k) => [k, source[k]])))
      : rows;
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(projected).then(resolve, reject),
    };
    for (const method of ['from', 'innerJoin', 'orderBy', 'limit', 'for']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.where = vi.fn((condition: unknown) => {
      state.wheres.push(condition);
      return chain;
    });
    return chain;
  });
  return {
    db: { select },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveRequestReportAuthority: vi.fn(async () => state.orgAuthority),
    resolveRequestPartnerReportAuthority: vi.fn(async () => state.partnerAuthority),
  };
});

import {
  getReportRunWithOwnerCheck,
  getReportWithOwnerCheck,
  partnerOwnedReportVisibility,
  systemPartnerWideListArm,
  tenantAuthorizedReportCondition,
} from './helpers';
import { reportRuns, reports } from '../../db/schema';
import {
  partnerWideScope,
  resolveRequestPartnerReportAuthority,
  resolveRequestReportAuthority,
  siteScopeFingerprint,
} from '../../services/siteScope';
import type { AuthContext } from '../../middleware/auth';

const dialect = new PgDialect();
const compiled = (where: unknown) => dialect.sqlToQuery(where as SQL);

function partnerAuth(partnerOrgAccess: 'all' | 'selected'): AuthContext {
  return {
    user: { id: USER_ID, email: 'tech@example.com' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    partnerOrgAccess,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
  } as unknown as AuthContext;
}

function orgAuth(): AuthContext {
  return {
    user: { id: USER_ID, email: 'tech@example.com' },
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
  } as unknown as AuthContext;
}

function partnerAuthorityResult() {
  const scope = partnerWideScope(PARTNER_ID);
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: USER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

function partnerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    reportId: REPORT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'AR aging',
    type: 'ar_aging',
    executionScopeVersion: 1,
    executionScopeKind: 'partner_wide',
    executionScopeSiteIds: null,
    executionScopeUserId: USER_ID,
    executionScopeFingerprint: siteScopeFingerprint(partnerWideScope(PARTNER_ID)),
    executionScopeCapturedAt: CAPTURED_AT,
    executionScopePrincipalKind: 'user',
    portalSelfService: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.wheres = [];
  state.partnerAuthority = partnerAuthorityResult();
  state.orgAuthority = { ok: false, reason: 'organization_inaccessible' };
});

describe('owner-aware report helpers (#3198 W01)', () => {
  it('getReportWithOwnerCheck resolves a partner-owned row through resolveRequestPartnerReportAuthority', async () => {
    const auth = partnerAuth('all');
    state.rows = [partnerRow(), partnerRow()];

    const report = await getReportWithOwnerCheck(REPORT_ID, auth, ALL_PERMS);

    expect(report).not.toBeNull();
    expect(report!.owner).toEqual({ partnerId: PARTNER_ID });
    expect(report!.partnerId).toBe(PARTNER_ID);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(auth, PARTNER_ID, 'read');
    expect(resolveRequestReportAuthority).not.toHaveBeenCalled();
    // The row read is pinned to the owning partner AND a complete partner_wide envelope.
    const rowRead = compiled(state.wheres[1]);
    expect(rowRead.params).toContain(PARTNER_ID);
    expect(rowRead.params).toContain('partner_wide');
    expect(rowRead.sql).toContain('"reports"."partner_id"');
  });

  it('getReportWithOwnerCheck returns null for a partner-owned row when the caller is org scope', async () => {
    // Even if a row with this id came back (it cannot: the org predicate is
    // `org_id = auth.orgId`), the owner check refuses it.
    state.rows = [partnerRow(), partnerRow()];

    const report = await getReportWithOwnerCheck(REPORT_ID, orgAuth(), ALL_PERMS);

    expect(report).toBeNull();
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
    const metadataRead = compiled(state.wheres[0]);
    expect(metadataRead.params).not.toContain(PARTNER_ID);
    expect(metadataRead.params).toContain(ORG_ID);
    expect(metadataRead.sql).not.toContain('partner_id');
  });

  it('getReportWithOwnerCheck returns null for a selected-access partner user', async () => {
    state.rows = [partnerRow(), partnerRow()];

    const report = await getReportWithOwnerCheck(REPORT_ID, partnerAuth('selected'), ALL_PERMS);

    expect(report).toBeNull();
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('getReportWithOwnerCheck returns null when the live partner authority is refused', async () => {
    state.partnerAuthority = { ok: false, reason: 'partner_access_not_all' };
    state.rows = [partnerRow(), partnerRow()];

    expect(await getReportWithOwnerCheck(REPORT_ID, partnerAuth('all'), ALL_PERMS)).toBeNull();
  });

  it('getReportRunWithOwnerCheck returns the partner_wide run predicate for a partner-owned run', async () => {
    const auth = partnerAuth('all');
    state.rows = [partnerRow({ id: RUN_ID })];

    const access = await getReportRunWithOwnerCheck(RUN_ID, auth, 'export', ALL_PERMS);

    expect(access).not.toBeNull();
    expect(access!.owner).toEqual({ partnerId: PARTNER_ID });
    expect(access!.metadata.partnerId).toBe(PARTNER_ID);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(auth, PARTNER_ID, 'export');
    const runPredicate = compiled(access!.runScopePredicate);
    expect(runPredicate.params).toContain('partner_wide');
    expect(runPredicate.params).toContain(PARTNER_ID);
    expect(runPredicate.params).toContain('user');
    expect(runPredicate.sql).toContain('"report_runs"."execution_scope_site_ids" is null');
    // Metadata join: partner branch present for an 'all' caller.
    expect(compiled(state.wheres[0]).params).toContain(PARTNER_ID);
  });

  it('getReportRunWithOwnerCheck returns null for a selected-access partner user', async () => {
    state.rows = [partnerRow({ id: RUN_ID })];

    expect(await getReportRunWithOwnerCheck(RUN_ID, partnerAuth('selected'), 'read', ALL_PERMS)).toBeNull();
    expect(compiled(state.wheres[0]).params).not.toContain(PARTNER_ID);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });
});

describe('partnerOwnedReportVisibility (#3198 W01 spec 3.1a)', () => {
  it('is partner_id = auth.partnerId for an all-access partner admin', () => {
    const query = compiled(partnerOwnedReportVisibility(partnerAuth('all')));
    expect(query.params).toEqual([PARTNER_ID]);
    expect(query.sql).toBe('"reports"."partner_id" = $1');
  });

  it('is FALSE for a selected-access partner user and for an org token', () => {
    expect(compiled(partnerOwnedReportVisibility(partnerAuth('selected'))).sql).toBe('FALSE');
    expect(compiled(partnerOwnedReportVisibility(orgAuth())).sql).toBe('FALSE');
  });

  it('is TRUE for system scope', () => {
    const system = { scope: 'system', partnerId: null, partnerOrgAccess: undefined } as unknown as AuthContext;
    expect(compiled(partnerOwnedReportVisibility(system)).sql).toBe('TRUE');
  });

  it('tenantAuthorizedReportCondition adds the partner branch only for an all-access partner', () => {
    expect(compiled(tenantAuthorizedReportCondition(REPORT_ID, partnerAuth('all'), ALL_PERMS)).params).toContain(PARTNER_ID);
    expect(compiled(tenantAuthorizedReportCondition(REPORT_ID, partnerAuth('selected'), ALL_PERMS)).params).not.toContain(PARTNER_ID);
    const org = compiled(tenantAuthorizedReportCondition(REPORT_ID, orgAuth(), ALL_PERMS));
    expect(org.params).not.toContain(PARTNER_ID);
    expect(org.sql).not.toContain('partner_id');
  });
});

describe('systemPartnerWideListArm (#3198 W02, addendum B7)', () => {
  it.each(['partner', 'organization'] as const)('returns undefined for a %s token', (scope) => {
    expect(systemPartnerWideListArm({ scope }, reports)).toBeUndefined();
    expect(systemPartnerWideListArm({ scope }, reportRuns)).toBeUndefined();
  });

  it('returns the any-partner partner_wide predicate for a system token', () => {
    for (const columns of [reports, reportRuns]) {
      const arm = systemPartnerWideListArm({ scope: 'system' }, columns);
      expect(arm).toBeDefined();
      const { sql, params } = compiled(arm);
      expect(sql).toMatch(/partner_id/);
      expect(params).toContain('partner_wide');
    }
  });
});
