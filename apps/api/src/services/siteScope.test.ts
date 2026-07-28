import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { reportRuns, reports } from '../db/schema';
import * as siteScopeModule from './siteScope';

const liveDbState = vi.hoisted(() => ({
  rows: [] as Array<unknown[] | Error>,
  projections: [] as unknown[],
  fromTables: [] as unknown[],
  whereConditions: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn((projection?: unknown) => {
      liveDbState.projections.push(projection);
      const result = liveDbState.rows.shift() ?? [];
      const promise = result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
      const chain: any = {
        from: vi.fn((table: unknown) => {
          liveDbState.fromTables.push(table);
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn((condition: unknown) => {
          liveDbState.whereConditions.push(condition);
          return chain;
        }),
        limit: vi.fn(() => chain),
        then: promise.then.bind(promise),
      };
      return chain;
    }),
  },
  runOutsideDbContext: vi.fn((callback: () => unknown) => callback()),
  withSystemDbAccessContext: vi.fn((callback: () => unknown) => callback()),
}));

import {
  decodeSiteScope,
  intersectSiteScopes,
  isSiteScopeSubset,
  normalizeSiteIds,
  persistedSiteScopeValues,
  reportDefinitionMultiOrgScopeSqlPredicate,
  reportDefinitionScopeSqlPredicate,
  resolveLiveReportAuthority,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  siteScopeFingerprint,
  siteScopeFromPermissions,
  unrestrictedReportDefinitionScopeSqlPredicate,
  type LiveSiteScopeV1,
  type PersistedSiteScopeColumns,
  type ReportAction,
  type ReportExecutionAuthority,
  type SiteScopeV1,
} from './siteScope';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CAPTURED_AT = new Date('2026-07-25T12:34:56.000Z');

const unrestricted = (orgId = ORG_A): LiveSiteScopeV1 => ({
  version: 1,
  kind: 'unrestricted',
  orgId,
});

const restricted = (
  siteIds: string[],
  orgId = ORG_A,
): LiveSiteScopeV1 => ({
  version: 1,
  kind: 'restricted',
  orgId,
  siteIds,
});

const legacy = (orgId = ORG_A): SiteScopeV1 => ({
  version: 1,
  kind: 'legacy_unscoped',
  orgId,
});

function persisted(
  overrides: Partial<PersistedSiteScopeColumns> = {},
): PersistedSiteScopeColumns {
  const scope = restricted([SITE_A]);
  return {
    executionScopeVersion: 1,
    executionScopeKind: 'restricted',
    executionScopeSiteIds: [SITE_A],
    executionScopeUserId: USER_ID,
    executionScopeFingerprint: siteScopeFingerprint(scope),
    executionScopeCapturedAt: CAPTURED_AT,
    ...overrides,
  };
}

function renderSql(condition: SQL): { sql: string; params: unknown[] } {
  const rendered = new PgDialect().sqlToQuery(condition);
  return { sql: rendered.sql, params: rendered.params };
}

describe('canonical site-scope algebra', () => {
  it('sorts and deduplicates restricted IDs without mutating the input', () => {
    const input = [SITE_B, SITE_A, SITE_B];

    expect(normalizeSiteIds(input)).toEqual([SITE_A, SITE_B]);
    expect(input).toEqual([SITE_B, SITE_A, SITE_B]);
  });

  it.each([
    {
      name: 'undefined permissions remain unrestricted',
      allowedSiteIds: undefined,
      expected: unrestricted(),
    },
    {
      name: 'an empty permission set remains restricted-empty',
      allowedSiteIds: [],
      expected: restricted([]),
    },
    {
      name: 'restricted permissions are normalized',
      allowedSiteIds: [SITE_B, SITE_A, SITE_B],
      expected: restricted([SITE_A, SITE_B]),
    },
  ])('$name', ({ allowedSiteIds, expected }) => {
    expect(
      siteScopeFromPermissions(ORG_A, {
        permissions: [],
        partnerId: null,
        orgId: ORG_A,
        roleId: 'role-id',
        scope: 'organization',
        allowedSiteIds,
      }),
    ).toEqual(expected);
  });

  it('represents unrestricted and restricted-empty with different kinds and fingerprints', () => {
    const openScope = unrestricted();
    const emptyScope = restricted([]);

    expect(openScope.kind).not.toBe(emptyScope.kind);
    expect(siteScopeFingerprint(openScope)).not.toBe(siteScopeFingerprint(emptyScope));
  });

  it.each([
    {
      name: 'unrestricted intersect unrestricted returns current',
      persistedScope: unrestricted(),
      currentScope: unrestricted(),
      expected: unrestricted(),
    },
    {
      name: 'unrestricted intersect restricted returns current',
      persistedScope: unrestricted(),
      currentScope: restricted([SITE_B, SITE_A, SITE_B]),
      expected: restricted([SITE_A, SITE_B]),
    },
    {
      name: 'unrestricted intersect restricted-empty preserves restricted-empty',
      persistedScope: unrestricted(),
      currentScope: restricted([]),
      expected: restricted([]),
    },
    {
      name: 'restricted intersect unrestricted returns persisted restriction',
      persistedScope: restricted([SITE_B, SITE_A, SITE_B]),
      currentScope: unrestricted(),
      expected: restricted([SITE_A, SITE_B]),
    },
    {
      name: 'restricted intersect restricted returns the sorted set intersection',
      persistedScope: restricted([SITE_C, SITE_B, SITE_A]),
      currentScope: restricted([SITE_B, SITE_C]),
      expected: restricted([SITE_B, SITE_C]),
    },
    {
      name: 'restricted-empty intersect unrestricted remains restricted-empty',
      persistedScope: restricted([]),
      currentScope: unrestricted(),
      expected: restricted([]),
    },
    {
      name: 'disjoint restricted scopes fail closed',
      persistedScope: restricted([SITE_A]),
      currentScope: restricted([SITE_B]),
      expected: null,
    },
    {
      name: 'legacy persisted scope fails closed',
      persistedScope: legacy(),
      currentScope: unrestricted(),
      expected: null,
    },
    {
      name: 'legacy persisted scope with restricted current fails closed',
      persistedScope: legacy(),
      currentScope: restricted([SITE_A]),
      expected: null,
    },
    {
      name: 'legacy intersect legacy fails closed',
      persistedScope: legacy(),
      currentScope: legacy(),
      expected: null,
    },
    {
      name: 'legacy current scope fails closed',
      persistedScope: unrestricted(),
      currentScope: legacy(),
      expected: null,
    },
    {
      name: 'restricted intersect legacy fails closed',
      persistedScope: restricted([SITE_A]),
      currentScope: legacy(),
      expected: null,
    },
    {
      name: 'different organizations fail closed',
      persistedScope: restricted([SITE_A], ORG_A),
      currentScope: unrestricted(ORG_B),
      expected: null,
    },
  ])('$name', ({ persistedScope, currentScope, expected }) => {
    expect(intersectSiteScopes(persistedScope, currentScope)).toEqual(expected);
  });

  it.each([
    {
      name: 'restricted is a subset of unrestricted',
      candidate: restricted([SITE_A]),
      current: unrestricted(),
      expected: true,
    },
    {
      name: 'unrestricted is not a subset of restricted',
      candidate: unrestricted(),
      current: restricted([SITE_A]),
      expected: false,
    },
    {
      name: 'a narrower restricted set is a subset',
      candidate: restricted([SITE_A]),
      current: restricted([SITE_B, SITE_A]),
      expected: true,
    },
    {
      name: 'restricted-empty is a subset of a live restricted scope',
      candidate: restricted([]),
      current: restricted([SITE_A]),
      expected: true,
    },
    {
      name: 'a foreign site is not a subset',
      candidate: restricted([SITE_B]),
      current: restricted([SITE_A]),
      expected: false,
    },
    {
      name: 'a different organization is not a subset',
      candidate: restricted([SITE_A], ORG_B),
      current: unrestricted(ORG_A),
      expected: false,
    },
    {
      name: 'legacy candidate is visible to an unrestricted same-organization caller',
      candidate: legacy(),
      current: unrestricted(),
      expected: true,
    },
    {
      name: 'legacy current scope fails closed',
      candidate: unrestricted(),
      current: legacy(),
      expected: false,
    },
  ])('$name', ({ candidate, current, expected }) => {
    expect(isSiteScopeSubset(candidate, current)).toBe(expected);
  });
});

describe('siteScopeFingerprint', () => {
  it('hashes deterministic stable JSON with normalized site IDs', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          kind: 'restricted',
          orgId: ORG_A,
          siteIds: [SITE_A, SITE_B],
        }),
      )
      .digest('hex');

    expect(siteScopeFingerprint(restricted([SITE_B, SITE_A, SITE_B]))).toBe(expected);
    expect(siteScopeFingerprint(restricted([SITE_A, SITE_B]))).toBe(expected);
  });

  it.each([
    unrestricted(),
    restricted([]),
    restricted([SITE_A]),
    legacy(),
  ])('is deterministic for $kind', (scope) => {
    expect(siteScopeFingerprint(scope)).toBe(siteScopeFingerprint(scope));
    expect(siteScopeFingerprint(scope)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('persisted site-scope columns', () => {
  it.each([
    {
      name: 'unrestricted authority',
      scope: unrestricted(),
      expectedSiteIds: null,
    },
    {
      name: 'restricted authority',
      scope: restricted([SITE_B, SITE_A, SITE_B]),
      expectedSiteIds: [SITE_A, SITE_B],
    },
    {
      name: 'restricted-empty authority',
      scope: restricted([]),
      expectedSiteIds: [],
    },
  ])('encodes a complete $name', ({ scope, expectedSiteIds }) => {
    const normalizedScope =
      scope.kind === 'restricted'
        ? restricted(scope.siteIds)
        : scope;
    const authority: ReportExecutionAuthority = {
      scope,
      principalUserId: USER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(normalizedScope),
    };

    expect(persistedSiteScopeValues(authority)).toEqual({
      executionScopeVersion: 1,
      executionScopeKind: normalizedScope.kind,
      executionScopeSiteIds: expectedSiteIds,
      executionScopeUserId: USER_ID,
      executionScopeFingerprint: authority.fingerprint,
      executionScopeCapturedAt: CAPTURED_AT,
    });
  });

  it('decodes an all-null old-writer row as legacy_unscoped for the supplied organization', () => {
    expect(
      decodeSiteScope(
        {
          executionScopeVersion: null,
          executionScopeKind: null,
          executionScopeSiteIds: null,
          executionScopeUserId: null,
          executionScopeFingerprint: null,
          executionScopeCapturedAt: null,
        },
        ORG_A,
      ),
    ).toEqual(legacy());
  });

  it.each([
    {
      name: 'complete unrestricted',
      row: persisted({
        executionScopeKind: 'unrestricted',
        executionScopeSiteIds: null,
        executionScopeFingerprint: siteScopeFingerprint(unrestricted()),
      }),
      expected: unrestricted(),
    },
    {
      name: 'complete restricted',
      row: persisted({
        executionScopeSiteIds: [SITE_B, SITE_A, SITE_B],
        executionScopeFingerprint: siteScopeFingerprint(restricted([SITE_A, SITE_B])),
      }),
      expected: restricted([SITE_A, SITE_B]),
    },
    {
      name: 'complete restricted-empty',
      row: persisted({
        executionScopeSiteIds: [],
        executionScopeFingerprint: siteScopeFingerprint(restricted([])),
      }),
      expected: restricted([]),
    },
    {
      name: 'complete legacy with nullable initiating user',
      row: persisted({
        executionScopeKind: 'legacy_unscoped',
        executionScopeSiteIds: null,
        executionScopeUserId: null,
        executionScopeFingerprint: siteScopeFingerprint(legacy()),
      }),
      expected: legacy(),
    },
  ])('decodes a $name row', ({ row, expected }) => {
    expect(decodeSiteScope(row, ORG_A)).toEqual(expected);
  });

  it.each([
    ['executionScopeVersion', 1],
    ['executionScopeKind', 'restricted'],
    ['executionScopeSiteIds', []],
    ['executionScopeUserId', USER_ID],
    ['executionScopeFingerprint', 'f'.repeat(64)],
    ['executionScopeCapturedAt', CAPTURED_AT],
  ] as const)('rejects an all-null row with only %s populated', (field, value) => {
    expect(() =>
      decodeSiteScope(
        {
          executionScopeVersion: null,
          executionScopeKind: null,
          executionScopeSiteIds: null,
          executionScopeUserId: null,
          executionScopeFingerprint: null,
          executionScopeCapturedAt: null,
          [field]: value,
        },
        ORG_A,
      ),
    ).toThrow(/partial|invalid|malformed/i);
  });

  it.each([
    {
      name: 'unknown version',
      row: persisted({ executionScopeVersion: 2 }),
    },
    {
      name: 'unknown kind',
      row: persisted({ executionScopeKind: 'unknown' as 'restricted' }),
    },
    {
      name: 'restricted without a site array',
      row: persisted({ executionScopeSiteIds: null }),
    },
    {
      name: 'restricted without a user',
      row: persisted({ executionScopeUserId: null }),
    },
    {
      name: 'unrestricted with a site array',
      row: persisted({
        executionScopeKind: 'unrestricted',
        executionScopeSiteIds: [],
      }),
    },
    {
      name: 'unrestricted without a user',
      row: persisted({
        executionScopeKind: 'unrestricted',
        executionScopeSiteIds: null,
        executionScopeUserId: null,
      }),
    },
    {
      name: 'legacy with a site array',
      row: persisted({
        executionScopeKind: 'legacy_unscoped',
        executionScopeSiteIds: [],
      }),
    },
    {
      name: 'missing fingerprint',
      row: persisted({ executionScopeFingerprint: null }),
    },
    {
      name: 'missing capture time',
      row: persisted({ executionScopeCapturedAt: null }),
    },
    {
      name: 'invalid capture time',
      row: persisted({ executionScopeCapturedAt: new Date(Number.NaN) }),
    },
    {
      name: 'malformed fingerprint',
      row: persisted({ executionScopeFingerprint: 'not-a-sha256-digest' }),
    },
    {
      name: 'fingerprint for a different scope',
      row: persisted({
        executionScopeFingerprint: siteScopeFingerprint(restricted([SITE_B])),
      }),
    },
  ])('rejects $name', ({ row }) => {
    expect(() => decodeSiteScope(row, ORG_A)).toThrow(/partial|invalid|malformed/i);
  });
});

describe('report definition scope SQL predicates', () => {
  it.each([
    {
      name: 'unrestricted includes complete and old-writer shapes',
      scope: unrestricted() as LiveSiteScopeV1,
      includes: ['is null', 'is not null'],
      excludes: ['<@'],
      expectedKinds: ['unrestricted', 'restricted', 'legacy_unscoped'],
    },
    {
      name: 'restricted uses only the complete subset branch',
      scope: restricted([SITE_B, SITE_A, SITE_B]) as LiveSiteScopeV1,
      includes: ['<@', 'array['],
      excludes: [],
      expectedKinds: ['restricted'],
    },
    {
      name: 'restricted-empty remains a bound subset check',
      scope: restricted([]) as LiveSiteScopeV1,
      includes: ['<@', 'array[]::uuid[]'],
      excludes: [],
      expectedKinds: ['restricted'],
    },
  ])('$name', ({ scope, includes, excludes, expectedKinds }) => {
    const rendered = renderSql(reportDefinitionScopeSqlPredicate(reports, scope));

    for (const fragment of includes) {
      expect(rendered.sql.toLowerCase()).toContain(fragment);
    }
    for (const fragment of excludes) {
      expect(rendered.sql.toLowerCase()).not.toContain(fragment);
    }
    expect(rendered.sql).not.toContain(ORG_A);
    expect(rendered.sql).not.toContain(SITE_A);
    expect(rendered.sql).not.toContain(SITE_B);
    for (const kind of expectedKinds) {
      expect(rendered.params).toContain(kind);
    }
    if (scope.kind === 'restricted') {
      for (const siteId of normalizeSiteIds(scope.siteIds)) {
        expect(rendered.params).toContain(siteId);
      }
    }
  });

  it('fails closed for a forced legacy live caller value', () => {
    const rendered = renderSql(
      reportDefinitionScopeSqlPredicate(
        reports,
        legacy() as unknown as LiveSiteScopeV1,
      ),
    );

    expect(rendered.sql.toLowerCase()).toContain('false');
    expect(rendered.params).toEqual([]);
  });

  it('exposes the same unrestricted branch without a fabricated organization', () => {
    const exact = renderSql(
      reportDefinitionScopeSqlPredicate(reports, unrestricted()),
    );
    const system = renderSql(
      unrestrictedReportDefinitionScopeSqlPredicate(reports),
    );

    expect(system).toEqual(exact);
    expect(system.sql).not.toContain(ORG_A);
  });

  it('builds bound per-organization branches', () => {
    const rendered = renderSql(
      reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, [
        unrestricted(ORG_A),
        restricted([SITE_B, SITE_A, SITE_B], ORG_B),
      ]),
    );

    expect(rendered.sql.toLowerCase()).toContain(' or ');
    expect(rendered.sql.toLowerCase()).toContain('<@');
    expect(rendered.sql).not.toContain(ORG_A);
    expect(rendered.sql).not.toContain(ORG_B);
    expect(rendered.sql).not.toContain(SITE_A);
    expect(rendered.sql).not.toContain(SITE_B);
    expect(rendered.params).toContain(ORG_A);
    expect(rendered.params).toContain(ORG_B);
    expect(rendered.params).toContain(SITE_A);
    expect(rendered.params).toContain(SITE_B);
  });

  it('deduplicates organizations and site IDs before binding', () => {
    const rendered = renderSql(
      reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, [
        restricted([SITE_B, SITE_A, SITE_B], ORG_A),
        restricted([SITE_A, SITE_B], ORG_A),
      ]),
    );

    expect(rendered.params.filter((value) => value === ORG_A)).toHaveLength(1);
    expect(rendered.params.filter((value) => value === SITE_A)).toHaveLength(1);
    expect(rendered.params.filter((value) => value === SITE_B)).toHaveLength(1);
  });

  it('returns SQL FALSE for an empty multi-organization scope list', () => {
    const rendered = renderSql(
      reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, []),
    );

    expect(rendered.sql.toLowerCase()).toContain('false');
    expect(rendered.params).toEqual([]);
  });

  it('omits restricted-empty organizations from a composite predicate', () => {
    const rendered = renderSql(
      reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, [
        unrestricted(ORG_A),
        restricted([], ORG_B),
      ]),
    );

    expect(rendered.params).toContain(ORG_A);
    expect(rendered.params).not.toContain(ORG_B);
  });
});

describe('report run scope SQL predicates', () => {
  const task5SiteScope = siteScopeModule as unknown as {
    reportRunScopeSqlPredicate: (
      columns: typeof reportRuns,
      scope: LiveSiteScopeV1,
    ) => SQL;
    unrestrictedReportRunScopeSqlPredicate: (
      columns: typeof reportRuns,
    ) => SQL;
    reportRunMultiOrgScopeSqlPredicate: (
      rowOrgId: typeof reports.orgId,
      columns: typeof reportRuns,
      scopes: readonly LiveSiteScopeV1[],
    ) => SQL;
  };

  it.each([
    {
      name: 'unrestricted admits complete unrestricted, restricted, legacy, and all-null rows',
      scope: unrestricted(),
      expectedKinds: ['unrestricted', 'restricted', 'legacy_unscoped'],
      expectedSql: ['is null', 'is not null'],
      forbiddenSql: ['<@'],
    },
    {
      name: 'restricted admits only complete restricted subset rows',
      scope: restricted([SITE_B, SITE_A, SITE_B]),
      expectedKinds: ['restricted'],
      expectedSql: ['<@', 'array['],
      forbiddenSql: [],
    },
    {
      name: 'restricted-empty remains a valid bound subset',
      scope: restricted([]),
      expectedKinds: ['restricted'],
      expectedSql: ['<@', 'array[]::uuid[]'],
      forbiddenSql: [],
    },
  ])(
    '$name',
    ({ scope, expectedKinds, expectedSql, forbiddenSql }) => {
      const rendered = renderSql(
        task5SiteScope.reportRunScopeSqlPredicate(reportRuns, scope),
      );

      for (const fragment of expectedSql) {
        expect(rendered.sql.toLowerCase()).toContain(fragment);
      }
      for (const fragment of forbiddenSql) {
        expect(rendered.sql.toLowerCase()).not.toContain(fragment);
      }
      expect(rendered.sql).not.toContain(ORG_A);
      expect(rendered.sql).not.toContain(SITE_A);
      expect(rendered.sql).not.toContain(SITE_B);
      for (const kind of expectedKinds) {
        expect(rendered.params).toContain(kind);
      }
      if (scope.kind === 'restricted') {
        for (const siteId of normalizeSiteIds(scope.siteIds)) {
          expect(rendered.params).toContain(siteId);
        }
      }
    },
  );

  it('rejects unrestricted, legacy, all-null, foreign-site, partial, invalid-kind, and invalid-version rows from the restricted SQL branch', () => {
    const rendered = renderSql(
      task5SiteScope.reportRunScopeSqlPredicate(
        reportRuns,
        restricted([SITE_A]),
      ),
    );

    expect(rendered.params).toContain('restricted');
    expect(rendered.params).not.toContain('unrestricted');
    expect(rendered.params).not.toContain('legacy_unscoped');
    expect(rendered.sql.toLowerCase()).toContain('<@');
    expect(rendered.sql.toLowerCase()).toContain('is not null');
    expect(rendered.sql.toLowerCase()).not.toContain(' or ');
    expect(rendered.params).toContain(SITE_A);
    expect(rendered.params).not.toContain(SITE_B);
  });

  it('fails closed for a forced runtime legacy caller scope', () => {
    const rendered = renderSql(
      task5SiteScope.reportRunScopeSqlPredicate(
        reportRuns,
        legacy() as unknown as LiveSiteScopeV1,
      ),
    );

    expect(rendered.sql.toLowerCase()).toContain('false');
    expect(rendered.params).toEqual([]);
  });

  it('exposes exactly the same unrestricted run branch without a fabricated organization', () => {
    const exact = renderSql(
      task5SiteScope.reportRunScopeSqlPredicate(
        reportRuns,
        unrestricted(),
      ),
    );
    const system = renderSql(
      task5SiteScope.unrestrictedReportRunScopeSqlPredicate(reportRuns),
    );

    expect(system).toEqual(exact);
    expect(system.sql).not.toContain(ORG_A);
  });

  it('builds bound per-organization run branches for unrestricted A and Site B1-restricted B', () => {
    const rendered = renderSql(
      task5SiteScope.reportRunMultiOrgScopeSqlPredicate(
        reports.orgId,
        reportRuns,
        [
          unrestricted(ORG_A),
          restricted([SITE_B, SITE_A, SITE_B], ORG_B),
        ],
      ),
    );

    expect(rendered.sql.toLowerCase()).toContain(' or ');
    expect(rendered.sql.toLowerCase()).toContain('<@');
    for (const value of [ORG_A, ORG_B, SITE_A, SITE_B]) {
      expect(rendered.sql).not.toContain(value);
      expect(rendered.params).toContain(value);
    }
  });

  it('deduplicates run organizations/sites and omits restricted-empty organizations', () => {
    const rendered = renderSql(
      task5SiteScope.reportRunMultiOrgScopeSqlPredicate(
        reports.orgId,
        reportRuns,
        [
          restricted([SITE_B, SITE_A, SITE_B], ORG_A),
          restricted([SITE_A, SITE_B], ORG_A),
          restricted([], ORG_B),
        ],
      ),
    );

    expect(rendered.params.filter((value) => value === ORG_A)).toHaveLength(1);
    expect(rendered.params.filter((value) => value === ORG_B)).toHaveLength(0);
    expect(rendered.params.filter((value) => value === SITE_A)).toHaveLength(1);
    expect(rendered.params.filter((value) => value === SITE_B)).toHaveLength(1);
  });

  it('returns SQL FALSE when no organization has a successful non-empty run scope', () => {
    const rendered = renderSql(
      task5SiteScope.reportRunMultiOrgScopeSqlPredicate(
        reports.orgId,
        reportRuns,
        [],
      ),
    );

    expect(rendered.sql.toLowerCase()).toContain('false');
    expect(rendered.params).toEqual([]);
  });
});

describe('live report authority resolution', () => {
  const PARTNER_A = '44444444-4444-4444-8444-444444444444';
  const PARTNER_B = '55555555-5555-4555-8555-555555555555';
  const ROLE_ORG = '66666666-6666-4666-8666-666666666666';
  const ROLE_PARTNER = '77777777-7777-4777-8777-777777777777';

  function queueRows(...rows: Array<unknown[] | Error>) {
    liveDbState.rows.push(...rows);
  }

  function activeUser(overrides: Record<string, unknown> = {}) {
    return {
      id: USER_ID,
      status: 'active',
      isPlatformAdmin: false,
      partnerId: PARTNER_A,
      ...overrides,
    };
  }

  function organization(id = ORG_A, partnerId = PARTNER_A) {
    return { id, partnerId };
  }

  function orgMembership(siteIds: string[] | null, roleId: string | null = ROLE_ORG) {
    return { roleId, siteIds };
  }

  function permission(
    action: ReportAction,
    scope: 'organization' | 'partner' = 'organization',
  ) {
    return {
      resource: 'reports',
      action,
      roleScope: scope,
      roleIsSystem: false,
      roleOrgId: scope === 'organization' ? ORG_A : null,
      rolePartnerId: PARTNER_A,
    };
  }

  function requestAuth(overrides: Record<string, unknown> = {}) {
    return {
      user: {
        id: USER_ID,
        email: 'security@example.com',
        name: 'Security User',
        isPlatformAdmin: false,
      },
      token: {},
      partnerId: PARTNER_A,
      orgId: ORG_A,
      scope: 'organization',
      accessibleOrgIds: [ORG_A],
      orgCondition: vi.fn(),
      canAccessOrg: (orgId: string) => orgId === ORG_A,
      ...overrides,
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    liveDbState.rows.length = 0;
    liveDbState.projections.length = 0;
    liveDbState.fromTables.length = 0;
    liveDbState.whereConditions.length = 0;
  });

  it('requires an explicit report action on every resolver', () => {
    expectTypeOf<Parameters<typeof resolveLiveReportAuthority>['length']>()
      .toEqualTypeOf<3>();
    expectTypeOf<Parameters<typeof resolveRequestReportAuthority>['length']>()
      .toEqualTypeOf<3>();
    expectTypeOf<Parameters<typeof resolveRequestReportAuthorityMap>['length']>()
      .toEqualTypeOf<3>();
    expectTypeOf(resolveLiveReportAuthority).parameter(2).toEqualTypeOf<ReportAction>();
    expectTypeOf(resolveRequestReportAuthority).parameter(2).toEqualTypeOf<ReportAction>();
    expectTypeOf(resolveRequestReportAuthorityMap).parameter(2).toEqualTypeOf<ReportAction>();
  });

  it.each([
    {
      name: 'organization NULL sites are unrestricted',
      siteIds: null,
      expected: unrestricted(),
    },
    {
      name: 'organization sites are normalized and restricted',
      siteIds: [SITE_B, SITE_A, SITE_B],
      expected: restricted([SITE_A, SITE_B]),
    },
  ])('$name', async ({ siteIds, expected }) => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership(siteIds)],
      [permission('read')],
    );

    const result = await resolveLiveReportAuthority(USER_ID, ORG_A, 'read');

    expect(result).toMatchObject({
      ok: true,
      authority: {
        scope: expected,
        principalUserId: USER_ID,
      },
    });
    if (result.ok) {
      expect(result.authority.fingerprint).toBe(siteScopeFingerprint(expected));
      expect(result.authority.capturedAt).toBeInstanceOf(Date);
    }
  });

  it('returns empty_scope for an authoritative restricted-empty organization membership', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership([])],
      [permission('read')],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'empty_scope' });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
  });

  it('never falls through to broader partner authority when an organization row lacks permission', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership([SITE_A])],
      [],
      [{ roleId: ROLE_PARTNER, orgAccess: 'all', orgIds: null }],
      [permission('read', 'partner')],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'permission_removed' });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
    expect(liveDbState.rows).toHaveLength(2);
  });

  it('fails closed when an organization membership points at a role owned by another organization', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership([SITE_A])],
      [{
        resource: 'reports',
        action: 'read',
        roleScope: 'organization',
        roleIsSystem: false,
        roleOrgId: ORG_B,
        rolePartnerId: PARTNER_A,
      }],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'permission_removed' });
  });

  it('fails closed when duplicate organization memberships exist', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership(null), orgMembership([SITE_A])],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'unverifiable_scope' });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(3);
  });

  it('accepts a system-defined organization role with no tenant owner', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership([SITE_A])],
      [{
        resource: 'reports',
        action: 'read',
        roleScope: 'organization',
        roleIsSystem: true,
        roleOrgId: null,
        rolePartnerId: null,
      }],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toMatchObject({
        ok: true,
        authority: { scope: restricted([SITE_A]) },
      });
  });

  it.each([
    {
      name: 'all organizations',
      orgAccess: 'all',
      orgIds: null,
    },
    {
      name: 'an admitted selected organization',
      orgAccess: 'selected',
      orgIds: [ORG_B, ORG_A],
    },
  ])('uses unrestricted partner fallback for $name', async ({ orgAccess, orgIds }) => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [{ roleId: ROLE_PARTNER, orgAccess, orgIds }],
      [permission('read', 'partner')],
    );

    const result = await resolveLiveReportAuthority(USER_ID, ORG_A, 'read');

    expect(result).toMatchObject({
      ok: true,
      authority: { scope: unrestricted() },
    });
  });

  it.each([
    {
      name: 'org_access none',
      membership: { roleId: ROLE_PARTNER, orgAccess: 'none', orgIds: null },
      userPartnerId: PARTNER_A,
      orgPartnerId: PARTNER_A,
      expected: 'organization_inaccessible',
    },
    {
      name: 'selected list misses the organization',
      membership: { roleId: ROLE_PARTNER, orgAccess: 'selected', orgIds: [ORG_B] },
      userPartnerId: PARTNER_A,
      orgPartnerId: PARTNER_A,
      expected: 'organization_inaccessible',
    },
    {
      name: 'partner membership was removed',
      membership: null,
      userPartnerId: PARTNER_A,
      orgPartnerId: PARTNER_A,
      expected: 'membership_removed',
    },
    {
      name: 'organization belongs to another partner',
      membership: null,
      userPartnerId: PARTNER_A,
      orgPartnerId: PARTNER_B,
      expected: 'organization_inaccessible',
    },
  ])('denies partner fallback when $name', async ({
    membership,
    userPartnerId,
    orgPartnerId,
    expected,
  }) => {
    queueRows(
      [activeUser({ partnerId: userPartnerId })],
      [organization(ORG_A, orgPartnerId)],
      [],
      ...(userPartnerId === orgPartnerId
        ? [membership ? [membership] : []]
        : []),
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: expected });
  });

  it('denies partner fallback without exactly reports:<action>', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [{ roleId: ROLE_PARTNER, orgAccess: 'all', orgIds: null }],
      [permission('read', 'partner')],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'delete'))
      .resolves.toEqual({ ok: false, reason: 'permission_removed' });
    const renderedPermissionWhere = renderSql(
      liveDbState.whereConditions.at(-1) as SQL,
    );
    expect(renderedPermissionWhere.params).toContain('delete');
    expect(renderedPermissionWhere.params).not.toContain('read');
  });

  it('fails closed when duplicate partner memberships exist', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [
        { roleId: ROLE_PARTNER, orgAccess: 'all', orgIds: null },
        { roleId: ROLE_PARTNER, orgAccess: 'none', orgIds: null },
      ],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'unverifiable_scope' });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
  });

  it.each<ReportAction>(['read', 'write', 'export', 'delete'])(
    'checks the exact reports:%s grant',
    async (action) => {
      queueRows(
        [activeUser()],
        [organization()],
        [orgMembership(null)],
        [permission(action)],
      );

      const result = await resolveLiveReportAuthority(USER_ID, ORG_A, action);

      expect(result.ok).toBe(true);
      const renderedPermissionWhere = renderSql(
        liveDbState.whereConditions.at(-1) as SQL,
      );
      expect(renderedPermissionWhere.params).toContain('reports');
      expect(renderedPermissionWhere.params).toContain(action);
    },
  );

  // #2874: the report authority check must honor '*' wildcard grants the same
  // way the canonical resolver (services/permissions.ts hasPermission) does.
  // The seeded Partner Admin role carries a single `*|*` row and nothing else.
  it.each([
    { name: '*|* (Partner Admin shape)', resource: '*', action: '*' },
    { name: 'wildcard resource with exact action', resource: '*', action: 'read' },
    { name: 'exact resource with wildcard action', resource: 'reports', action: '*' },
  ])(
    'grants partner fallback authority via a $name grant',
    async ({ resource, action }) => {
      queueRows(
        [activeUser()],
        [organization()],
        [],
        [{ roleId: ROLE_PARTNER, orgAccess: 'all', orgIds: null }],
        [{
          resource,
          action,
          roleScope: 'partner',
          roleIsSystem: false,
          roleOrgId: null,
          rolePartnerId: PARTNER_A,
        }],
      );

      const result = await resolveLiveReportAuthority(USER_ID, ORG_A, 'read');

      expect(result).toMatchObject({
        ok: true,
        authority: { scope: unrestricted() },
      });
      // The SQL filter must let wildcard rows through — a JS-only match would
      // pass this mock but never see the row against a real database.
      const renderedPermissionWhere = renderSql(
        liveDbState.whereConditions.at(-1) as SQL,
      );
      expect(renderedPermissionWhere.params).toContain('reports');
      expect(renderedPermissionWhere.params).toContain('read');
      expect(
        renderedPermissionWhere.params.filter((param) => param === '*'),
      ).toHaveLength(2);
    },
  );

  it('a *|* grant does not widen a restricted organization membership beyond its sites', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership([SITE_A])],
      [{
        resource: '*',
        action: '*',
        roleScope: 'organization',
        roleIsSystem: false,
        roleOrgId: ORG_A,
        rolePartnerId: PARTNER_A,
      }],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'write'))
      .resolves.toMatchObject({
        ok: true,
        authority: { scope: restricted([SITE_A]) },
      });
  });

  it.each([
    { name: 'unrelated resource with wildcard action', resource: 'devices', action: '*' },
    { name: 'wildcard resource with a different action', resource: '*', action: 'write' },
  ])('still denies partner fallback for a $name grant', async ({ resource, action }) => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [{ roleId: ROLE_PARTNER, orgAccess: 'all', orgIds: null }],
      [{
        resource,
        action,
        roleScope: 'partner',
        roleIsSystem: false,
        roleOrgId: null,
        rolePartnerId: PARTNER_A,
      }],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'permission_removed' });
  });

  it('a wildcard grant on a role owned by another partner is still rejected', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [{ roleId: ROLE_PARTNER, orgAccess: 'all', orgIds: null }],
      [{
        resource: '*',
        action: '*',
        roleScope: 'partner',
        roleIsSystem: false,
        roleOrgId: null,
        rolePartnerId: PARTNER_B,
      }],
    );

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'permission_removed' });
  });

  it('returns unrestricted for current scheduled platform authority', async () => {
    queueRows(
      [activeUser({ isPlatformAdmin: true })],
      [organization()],
    );

    const result = await resolveLiveReportAuthority(USER_ID, ORG_A, 'read');

    expect(result).toMatchObject({
      ok: true,
      authority: { scope: unrestricted() },
    });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it('requires current platform-admin proof for a system request', async () => {
    queueRows(
      [activeUser({ isPlatformAdmin: false })],
      [organization()],
      [],
      [],
    );
    const auth = requestAuth({
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null,
      canAccessOrg: () => true,
      user: {
        id: USER_ID,
        email: 'security@example.com',
        name: 'Security User',
        isPlatformAdmin: true,
      },
    });

    await expect(resolveRequestReportAuthority(auth, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: 'membership_removed' });
  });

  it('returns unrestricted for a system request with current platform-admin proof', async () => {
    queueRows(
      [activeUser({ isPlatformAdmin: true })],
      [organization()],
    );
    const auth = requestAuth({
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthority(auth, ORG_A, 'read');

    expect(result).toMatchObject({
      ok: true,
      authority: { scope: unrestricted() },
    });
  });

  it('rejects an inaccessible request organization before the authorization callback', async () => {
    const auth = requestAuth({
      accessibleOrgIds: [],
      canAccessOrg: () => false,
    });

    await expect(resolveRequestReportAuthority(auth, ORG_B, 'read'))
      .resolves.toEqual({ ok: false, reason: 'organization_inaccessible' });
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'inactive user',
      rows: [[activeUser({ status: 'disabled' })]],
      expected: 'user_inactive',
    },
    {
      name: 'missing organization',
      rows: [[activeUser()], []],
      expected: 'organization_inaccessible',
    },
    {
      name: 'missing organization role',
      rows: [[activeUser()], [organization()], [orgMembership(null, null)]],
      expected: 'permission_removed',
    },
    {
      name: 'no organization or partner membership',
      rows: [[activeUser()], [organization()], [], []],
      expected: 'membership_removed',
    },
    {
      name: 'database inconsistency',
      rows: [new Error('database unavailable')],
      expected: 'unverifiable_scope',
    },
  ])('returns a bounded denial for $name', async ({ rows, expected }) => {
    queueRows(...(rows as Array<unknown[] | Error>));

    await expect(resolveLiveReportAuthority(USER_ID, ORG_A, 'read'))
      .resolves.toEqual({ ok: false, reason: expected });
  });

  it('selects site IDs only from organization membership, never from roles', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [orgMembership([SITE_A])],
      [permission('read')],
    );

    await resolveLiveReportAuthority(USER_ID, ORG_A, 'read');

    const projectionKeys = liveDbState.projections.flatMap((projection) =>
      projection && typeof projection === 'object'
        ? Object.keys(projection)
        : []
    );
    expect(projectionKeys).toContain('siteIds');
    expect(projectionKeys).not.toEqual(
      expect.arrayContaining(['roleSiteIds', 'allowedSiteIds'])
    );
  });

  it('batch-resolves each organization independently with membership precedence', async () => {
    queueRows(
      [activeUser()],
      [organization(ORG_A), organization(ORG_B)],
      [{ orgId: ORG_B, roleId: ROLE_ORG, siteIds: [SITE_B, SITE_B] }],
      [{
        roleId: ROLE_ORG,
        resource: 'reports',
        action: 'read',
        roleScope: 'organization',
        roleIsSystem: false,
        roleOrgId: ORG_B,
        rolePartnerId: PARTNER_A,
      }],
      [{
        partnerId: PARTNER_A,
        roleId: ROLE_PARTNER,
        orgAccess: 'all',
        orgIds: null,
      }],
      [{
        roleId: ROLE_PARTNER,
        resource: 'reports',
        action: 'read',
        roleScope: 'partner',
        roleIsSystem: false,
        roleOrgId: null,
        rolePartnerId: PARTNER_A,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_B, ORG_A, ORG_B],
      'read',
    );

    expect(result.get(ORG_A)).toMatchObject({
      ok: true,
      authority: { scope: unrestricted(ORG_A) },
    });
    expect(result.get(ORG_B)).toMatchObject({
      ok: true,
      authority: { scope: restricted([SITE_B], ORG_B) },
    });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(6);
  });

  it('keeps an empty organization membership denied in the batch and never falls through', async () => {
    queueRows(
      [activeUser()],
      [organization(ORG_A), organization(ORG_B)],
      [{ orgId: ORG_B, roleId: ROLE_ORG, siteIds: [] }],
      [{
        roleId: ROLE_ORG,
        resource: 'reports',
        action: 'read',
        roleScope: 'organization',
        roleIsSystem: false,
        roleOrgId: ORG_B,
        rolePartnerId: PARTNER_A,
      }],
      [{
        partnerId: PARTNER_A,
        roleId: ROLE_PARTNER,
        orgAccess: 'all',
        orgIds: null,
      }],
      [{
        roleId: ROLE_PARTNER,
        resource: 'reports',
        action: 'read',
        roleScope: 'partner',
        roleIsSystem: false,
        roleOrgId: null,
        rolePartnerId: PARTNER_A,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_A, ORG_B],
      'read',
    );

    expect(result.get(ORG_A)?.ok).toBe(true);
    expect(result.get(ORG_B)).toEqual({ ok: false, reason: 'empty_scope' });
  });

  it('fails a batched organization branch closed when its role belongs to another organization', async () => {
    queueRows(
      [activeUser()],
      [organization(ORG_B)],
      [{ orgId: ORG_B, roleId: ROLE_ORG, siteIds: [SITE_B] }],
      [{
        roleId: ROLE_ORG,
        resource: 'reports',
        action: 'read',
        roleScope: 'organization',
        roleIsSystem: false,
        roleOrgId: ORG_A,
        rolePartnerId: PARTNER_A,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_B],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_B],
      'read',
    );

    expect(result.get(ORG_B)).toEqual({
      ok: false,
      reason: 'permission_removed',
    });
  });

  it('fails only the affected batch branch closed on duplicate organization memberships', async () => {
    queueRows(
      [activeUser()],
      [organization(ORG_A), organization(ORG_B)],
      [
        { orgId: ORG_B, roleId: ROLE_ORG, siteIds: null },
        { orgId: ORG_B, roleId: ROLE_ORG, siteIds: [SITE_B] },
      ],
      [{
        partnerId: PARTNER_A,
        roleId: ROLE_PARTNER,
        orgAccess: 'all',
        orgIds: null,
      }],
      [{
        roleId: ROLE_PARTNER,
        resource: 'reports',
        action: 'read',
        roleScope: 'partner',
        roleIsSystem: false,
        roleOrgId: null,
        rolePartnerId: PARTNER_A,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_A, ORG_B],
      'read',
    );

    expect(result.get(ORG_A)?.ok).toBe(true);
    expect(result.get(ORG_B)).toEqual({
      ok: false,
      reason: 'unverifiable_scope',
    });
  });

  it('fails all affected batch branches closed on duplicate partner memberships', async () => {
    queueRows(
      [activeUser()],
      [organization(ORG_A), organization(ORG_B)],
      [],
      [
        {
          partnerId: PARTNER_A,
          roleId: ROLE_PARTNER,
          orgAccess: 'all',
          orgIds: null,
        },
        {
          partnerId: PARTNER_A,
          roleId: ROLE_PARTNER,
          orgAccess: 'selected',
          orgIds: [ORG_A],
        },
      ],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_A, ORG_B],
      'read',
    );

    expect(result.get(ORG_A)).toEqual({
      ok: false,
      reason: 'unverifiable_scope',
    });
    expect(result.get(ORG_B)).toEqual({
      ok: false,
      reason: 'unverifiable_scope',
    });
  });

  it('accepts a system-defined partner role in the batched fallback', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [{
        partnerId: PARTNER_A,
        roleId: ROLE_PARTNER,
        orgAccess: 'all',
        orgIds: null,
      }],
      [{
        roleId: ROLE_PARTNER,
        resource: 'reports',
        action: 'read',
        roleScope: 'partner',
        roleIsSystem: true,
        roleOrgId: null,
        rolePartnerId: null,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_A],
      'read',
    );

    expect(result.get(ORG_A)).toMatchObject({
      ok: true,
      authority: { scope: unrestricted() },
    });
  });

  // #2874: the batched resolver shares the wildcard semantics — on BOTH of
  // its branches. The org-membership branch runs a separate permission query
  // (its own SQL filter) from the partner fallback, so each needs its own
  // rendered-WHERE wildcard guard.
  it('honors a *|* grant on a batched organization membership', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [{ orgId: ORG_A, roleId: ROLE_ORG, siteIds: null }],
      [{
        roleId: ROLE_ORG,
        resource: '*',
        action: '*',
        roleScope: 'organization',
        roleIsSystem: false,
        roleOrgId: ORG_A,
        rolePartnerId: PARTNER_A,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_A],
      'read',
    );

    expect(result.get(ORG_A)).toMatchObject({
      ok: true,
      authority: { scope: unrestricted() },
    });
    // Every accessible org has a membership, so no partner fallback queries
    // run and the last captured WHERE is the org-branch permission query —
    // the one whose SQL filter must let the two '*' params through.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
    const renderedPermissionWhere = renderSql(
      liveDbState.whereConditions.at(-1) as SQL,
    );
    expect(renderedPermissionWhere.params).toContain('reports');
    expect(renderedPermissionWhere.params).toContain('read');
    expect(
      renderedPermissionWhere.params.filter((param) => param === '*'),
    ).toHaveLength(2);
  });

  it('honors a *|* grant in the batched partner fallback', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [{
        partnerId: PARTNER_A,
        roleId: ROLE_PARTNER,
        orgAccess: 'all',
        orgIds: null,
      }],
      [{
        roleId: ROLE_PARTNER,
        resource: '*',
        action: '*',
        roleScope: 'partner',
        roleIsSystem: false,
        roleOrgId: null,
        rolePartnerId: PARTNER_A,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_A],
      'read',
    );

    expect(result.get(ORG_A)).toMatchObject({
      ok: true,
      authority: { scope: unrestricted() },
    });
    const renderedPermissionWhere = renderSql(
      liveDbState.whereConditions.at(-1) as SQL,
    );
    expect(
      renderedPermissionWhere.params.filter((param) => param === '*'),
    ).toHaveLength(2);
  });

  it('still denies an unrelated wildcard-action grant in the batched fallback', async () => {
    queueRows(
      [activeUser()],
      [organization()],
      [],
      [{
        partnerId: PARTNER_A,
        roleId: ROLE_PARTNER,
        orgAccess: 'all',
        orgIds: null,
      }],
      [{
        roleId: ROLE_PARTNER,
        resource: 'devices',
        action: '*',
        roleScope: 'partner',
        roleIsSystem: false,
        roleOrgId: null,
        rolePartnerId: PARTNER_A,
      }],
    );
    const auth = requestAuth({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: () => true,
    });

    const result = await resolveRequestReportAuthorityMap(
      auth,
      [ORG_A],
      'read',
    );

    expect(result.get(ORG_A)).toEqual({
      ok: false,
      reason: 'permission_removed',
    });
  });
});
