import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeSiteScope,
  intersectSiteScopes,
  isSiteScopeSubset,
  normalizeSiteIds,
  persistedSiteScopeValues,
  siteScopeFingerprint,
  siteScopeFromPermissions,
  type PersistedSiteScopeColumns,
  type ReportExecutionAuthority,
  type SiteScopeV1,
} from './siteScope';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CAPTURED_AT = new Date('2026-07-25T12:34:56.000Z');

const unrestricted = (orgId = ORG_A): SiteScopeV1 => ({
  version: 1,
  kind: 'unrestricted',
  orgId,
});

const restricted = (
  siteIds: string[],
  orgId = ORG_A,
): SiteScopeV1 => ({
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
