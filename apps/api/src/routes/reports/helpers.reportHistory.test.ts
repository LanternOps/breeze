/**
 * #6771 — the report-history branch of the report access helpers.
 *
 * An active partner may read (never generate, export or mutate) report
 * history of its own orgs that are out of service. Those orgs are NOT in
 * `auth.accessibleOrgIds`; the auth bootstrap hands the report-history GET
 * routes a separate, verified `auth.reportHistory` capability instead. These
 * tests pin that the helpers:
 *  - admit a history org ONLY for the 'read_history' action,
 *  - resolve its authority from the capability, never through the live
 *    resolver that escapes to a system context on a second connection
 *    (`resolveRequestReportAuthority` → runOutsideDbContext +
 *    withSystemDbAccessContext), and
 *  - never let the history ids leak into a mutation/export tenant condition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ACTIVE_ORG_ID = '22222222-2222-4222-8222-222222222222';
const HISTORY_ORG_ID = '55555555-5555-4555-8555-555555555555';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '77777777-7777-4777-8777-777777777777';
const CAPTURED_AT = new Date('2026-09-21T12:00:00.000Z');
const ALL_PERMS = { permissions: [{ resource: '*', action: '*' }] };

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown> | null>,
  wheres: [] as unknown[],
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
  // The history path must never escape the request transaction. Throwing
  // here turns any such call into a hard failure of the test.
  return {
    db: { select },
    runOutsideDbContext: vi.fn(() => {
      throw new Error('runOutsideDbContext must not be called on the report-history path');
    }),
    withSystemDbAccessContext: vi.fn(() => {
      throw new Error('withSystemDbAccessContext must not be called on the report-history path');
    }),
  };
});

vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveRequestReportAuthority: vi.fn(async () => ({ ok: false, reason: 'organization_inaccessible' })),
    resolveRequestPartnerReportAuthority: vi.fn(async () => ({ ok: false, reason: 'partner_inaccessible' })),
  };
});

import {
  getReportRunWithOwnerCheck,
  getReportWithOwnerCheck,
  resolveOrgReportAuthority,
  tenantAuthorizedReportCondition,
  tenantAuthorizedRunCondition,
} from './helpers';
import {
  resolveRequestReportAuthority,
  siteScopeFingerprint,
  type LiveSiteScopeV1,
} from '../../services/siteScope';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';

const dialect = new PgDialect();
const compiled = (where: unknown) => dialect.sqlToQuery(where as SQL);

function historyAuth(
  scope: LiveSiteScopeV1 = { version: 1, kind: 'unrestricted', orgId: HISTORY_ORG_ID },
  partnerOrgAccess: 'all' | 'selected' = 'all',
): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: USER_ID, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    partnerOrgAccess,
    accessibleOrgIds: [ACTIVE_ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ACTIVE_ORG_ID,
    reportHistory: {
      orgIds: [HISTORY_ORG_ID],
      scopes: new Map([[HISTORY_ORG_ID, scope]]),
    },
  } as unknown as AuthContext;
}

function withoutHistory(auth: AuthContext): AuthContext {
  return { ...auth, reportHistory: undefined } as AuthContext;
}

function orgRow(scope: LiveSiteScopeV1, overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    reportId: REPORT_ID,
    orgId: HISTORY_ORG_ID,
    partnerId: null,
    name: 'Inventory',
    type: 'device_inventory',
    executionScopeVersion: 1,
    executionScopeKind: scope.kind,
    executionScopeSiteIds: scope.kind === 'restricted' ? scope.siteIds : null,
    executionScopeUserId: USER_ID,
    executionScopeFingerprint: siteScopeFingerprint(scope),
    executionScopeCapturedAt: CAPTURED_AT,
    executionScopePrincipalKind: 'user',
    portalSelfService: false,
    ...overrides,
  };
}

const UNRESTRICTED: LiveSiteScopeV1 = { version: 1, kind: 'unrestricted', orgId: HISTORY_ORG_ID };

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.wheres = [];
});

describe('resolveOrgReportAuthority — report-history branch (#6771)', () => {
  it('resolves a history org from the verified capability for read_history, without the system-escaping resolver', async () => {
    const result = await resolveOrgReportAuthority(historyAuth(), HISTORY_ORG_ID, 'read_history');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.authority.scope).toEqual(UNRESTRICTED);
    expect(result.authority.principalUserId).toBe(USER_ID);
    expect(result.authority.fingerprint).toBe(siteScopeFingerprint(UNRESTRICTED));
    expect(resolveRequestReportAuthority).not.toHaveBeenCalled();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('keeps a site restriction carried by the capability (org-membership precedence)', async () => {
    const restricted: LiveSiteScopeV1 = {
      version: 1, kind: 'restricted', orgId: HISTORY_ORG_ID, siteIds: [SITE_ID],
    };
    const result = await resolveOrgReportAuthority(historyAuth(restricted), HISTORY_ORG_ID, 'read_history');
    expect(result.ok && result.authority.scope).toEqual(restricted);
  });

  it.each(['read', 'write', 'export', 'delete'] as const)(
    'never admits a history org for %s — falls through to the live resolver',
    async (action) => {
      const result = await resolveOrgReportAuthority(historyAuth(), HISTORY_ORG_ID, action);
      expect(result.ok).toBe(false);
      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(expect.anything(), HISTORY_ORG_ID, action);
    },
  );

  it('uses the live resolver for an org in accessibleOrgIds (active orgs never take the history branch)', async () => {
    await resolveOrgReportAuthority(historyAuth(), ACTIVE_ORG_ID, 'read_history');
    expect(resolveRequestReportAuthority).toHaveBeenCalledWith(expect.anything(), ACTIVE_ORG_ID, 'read_history');
  });

  it('refuses a history org when the request carries no capability', async () => {
    const result = await resolveOrgReportAuthority(withoutHistory(historyAuth()), HISTORY_ORG_ID, 'read_history');
    expect(result.ok).toBe(false);
  });

  it('refuses a capability on a non-partner scope', async () => {
    const orgScoped = { ...historyAuth(), scope: 'organization', orgId: HISTORY_ORG_ID } as AuthContext;
    const result = await resolveOrgReportAuthority(orgScoped, HISTORY_ORG_ID, 'read_history');
    expect(result.ok).toBe(false);
  });
});

describe('tenant conditions — report-history ids (#6771)', () => {
  it('tenantAuthorizedReportCondition includes history ids only when asked', () => {
    const auth = historyAuth();
    expect(compiled(tenantAuthorizedReportCondition(REPORT_ID, auth, ALL_PERMS)).params)
      .not.toContain(HISTORY_ORG_ID);
    const withHistory = compiled(
      tenantAuthorizedReportCondition(REPORT_ID, auth, ALL_PERMS, { reportHistory: true }),
    );
    expect(withHistory.params).toContain(HISTORY_ORG_ID);
    expect(withHistory.params).toContain(ACTIVE_ORG_ID);
  });

  it('a selected-access caller also gets the history branch (its capability is already intersected)', () => {
    const cond = compiled(
      tenantAuthorizedReportCondition(REPORT_ID, historyAuth(UNRESTRICTED, 'selected'), ALL_PERMS, { reportHistory: true }),
    );
    expect(cond.params).toContain(HISTORY_ORG_ID);
    expect(cond.params).not.toContain(PARTNER_ID);
  });

  it('tenantAuthorizedRunCondition includes history ids only when asked', () => {
    const auth = historyAuth();
    expect(compiled(tenantAuthorizedRunCondition(auth, ALL_PERMS)!).params).not.toContain(HISTORY_ORG_ID);
    expect(compiled(tenantAuthorizedRunCondition(auth, ALL_PERMS, { reportHistory: true })!).params)
      .toContain(HISTORY_ORG_ID);
  });

  it('a history-only caller (no active orgs) is not collapsed to "nothing" for history reads', () => {
    const auth = { ...historyAuth(UNRESTRICTED, 'selected'), accessibleOrgIds: [] } as unknown as AuthContext;
    expect(tenantAuthorizedRunCondition(auth, ALL_PERMS)).toBeNull();
    const cond = tenantAuthorizedRunCondition(auth, ALL_PERMS, { reportHistory: true });
    expect(cond).not.toBeNull();
    expect(compiled(cond!).params).toContain(HISTORY_ORG_ID);
  });

  it('never adds history ids for an org-scope caller', () => {
    const orgScoped = { ...historyAuth(), scope: 'organization', orgId: ACTIVE_ORG_ID } as AuthContext;
    expect(compiled(tenantAuthorizedReportCondition(REPORT_ID, orgScoped, ALL_PERMS, { reportHistory: true })).params)
      .not.toContain(HISTORY_ORG_ID);
  });
});

describe('by-id loaders — report-history org (#6771)', () => {
  it('getReportWithOwnerCheck(read_history) loads a history-org definition without escaping the request context', async () => {
    state.rows = [orgRow(UNRESTRICTED), orgRow(UNRESTRICTED)];

    const report = await getReportWithOwnerCheck(REPORT_ID, historyAuth(), ALL_PERMS, 'read_history');

    expect(report).not.toBeNull();
    expect(report!.owner).toEqual({ orgId: HISTORY_ORG_ID });
    expect(compiled(state.wheres[0]).params).toContain(HISTORY_ORG_ID);
    expect(resolveRequestReportAuthority).not.toHaveBeenCalled();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('getReportWithOwnerCheck(read) does not put history ids in the tenant condition', async () => {
    state.rows = [null];
    expect(await getReportWithOwnerCheck(REPORT_ID, historyAuth(), ALL_PERMS, 'read')).toBeNull();
    expect(compiled(state.wheres[0]).params).not.toContain(HISTORY_ORG_ID);
  });

  it('getReportWithOwnerCheck(read_history) refuses a row whose stored site scope exceeds the capability', async () => {
    const restricted: LiveSiteScopeV1 = {
      version: 1, kind: 'restricted', orgId: HISTORY_ORG_ID, siteIds: [SITE_ID],
    };
    state.rows = [orgRow(UNRESTRICTED), orgRow(UNRESTRICTED)];
    expect(await getReportWithOwnerCheck(REPORT_ID, historyAuth(restricted), ALL_PERMS, 'read_history')).toBeNull();
  });

  it('getReportRunWithOwnerCheck(read_history) loads a history-org run from the capability', async () => {
    state.rows = [orgRow(UNRESTRICTED, { id: RUN_ID })];

    const access = await getReportRunWithOwnerCheck(RUN_ID, historyAuth(), 'read_history', ALL_PERMS);

    expect(access).not.toBeNull();
    expect(access!.owner).toEqual({ orgId: HISTORY_ORG_ID });
    expect(compiled(state.wheres[0]).params).toContain(HISTORY_ORG_ID);
    expect(resolveRequestReportAuthority).not.toHaveBeenCalled();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
  });

  it('getReportRunWithOwnerCheck(export) — the download path — never sees history ids', async () => {
    state.rows = [null];
    expect(await getReportRunWithOwnerCheck(RUN_ID, historyAuth(), 'export', ALL_PERMS)).toBeNull();
    expect(compiled(state.wheres[0]).params).not.toContain(HISTORY_ORG_ID);
  });
});
