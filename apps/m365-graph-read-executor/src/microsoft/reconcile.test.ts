import { getM365PermissionProfile } from '@breeze/shared/m365';
import { describe, expect, it } from 'vitest';
import type { CanonicalAppRoleAssignment } from '@breeze/shared/m365';
import { reconcileCustomerGraphRead } from './reconcile';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';
const VERIFIED_AT = new Date('2026-07-14T12:00:00.000Z');
const PROOF = {
  tenantId: TENANT_ID,
  applicationId: APPLICATION_ID,
  organizationDisplayName: 'Contoso Ltd',
} as const;

const expected: CanonicalAppRoleAssignment[] = [
  ...getM365PermissionProfile('customer-graph-read').applicationPermissionAssignments!,
];

function reconcile(observedGrants: readonly CanonicalAppRoleAssignment[] | null) {
  return reconcileCustomerGraphRead({ ...PROOF, observedGrants }, { currentDate: VERIFIED_AT });
}

describe('reconcileCustomerGraphRead', () => {
  it('returns active for exact grants regardless of input order, duplicates, or display values', () => {
    const observed = [
      ...expected.slice().reverse().map((grant) => ({ ...grant, value: `metadata-${grant.value}` })),
      { ...expected[0]!, value: null },
    ];

    const result = reconcile(observed);

    expect(result.outcome).toBe('active');
    expect(result.grantReconciliation).toBe('complete');
    expect(result.missingGrants).toEqual([]);
    expect(result.unexpectedGrants).toEqual([]);
    expect(result.observedGrants).toHaveLength(expected.length);
    expect(result.observedGrants?.map((grant) => `${grant.resourceApplicationId}/${grant.appRoleId}`))
      .toEqual([...new Set(expected.map((grant) => `${grant.resourceApplicationId}/${grant.appRoleId}`))].sort());
  });

  it('returns missing with the shared manifest metadata', () => {
    const missing = expected[3]!;
    const result = reconcile(expected.filter((grant) => grant.appRoleId !== missing.appRoleId));

    expect(result.outcome).toBe('missing');
    expect(result.missingGrants).toEqual([missing]);
    expect(result.unexpectedGrants).toEqual([]);
  });

  it('returns unexpected and retains an unknown role GUID with null value', () => {
    const unknown: CanonicalAppRoleAssignment = {
      resourceApplicationId: '00000003-0000-0000-c000-000000000000',
      appRoleId: '99999999-9999-4999-8999-999999999999',
      value: null,
    };
    const result = reconcile([...expected, unknown]);

    expect(result.outcome).toBe('unexpected');
    expect(result.missingGrants).toEqual([]);
    expect(result.unexpectedGrants).toEqual([unknown]);
  });

  it('returns both missing and unexpected sets when both drift directions exist', () => {
    const unknownResource: CanonicalAppRoleAssignment = {
      resourceApplicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      appRoleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      value: null,
    };
    const result = reconcile([...expected.slice(1), unknownResource]);

    expect(result.outcome).toBe('missing_and_unexpected');
    expect(result.missingGrants).toEqual([expected[0]]);
    expect(result.unexpectedGrants).toEqual([unknownResource]);
  });

  it('compares resource application and role IDs rather than display metadata', () => {
    const sameDisplayWrongRole: CanonicalAppRoleAssignment = {
      resourceApplicationId: expected[0]!.resourceApplicationId,
      appRoleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      value: expected[0]!.value,
    };
    const result = reconcile([...expected.slice(1), sameDisplayWrongRole]);

    expect(result.outcome).toBe('missing_and_unexpected');
    expect(result.missingGrants).toEqual([expected[0]]);
    expect(result.unexpectedGrants).toEqual([sameDisplayWrongRole]);
  });

  it('returns verified-but-degraded proof with no partial set or grant timestamp when reconciliation is unavailable', () => {
    expect(reconcile(null)).toEqual({
      ...PROOF,
      manifestVersion: 2,
      verifiedAt: VERIFIED_AT.toISOString(),
      outcome: 'grant_reconciliation_unavailable',
      grantReconciliation: 'unavailable',
      errorCode: 'grant_reconciliation_unavailable',
      observedGrants: null,
      missingGrants: null,
      unexpectedGrants: null,
      grantsVerifiedAt: null,
    });
  });

  it('does not make reconciliation unavailable merely because display metadata is unknown', () => {
    const first = expected[0]!;
    const result = reconcile(expected.map((grant) => grant.appRoleId === first.appRoleId
      ? { ...grant, value: null }
      : grant));

    expect(result.grantReconciliation).toBe('complete');
    expect(result.outcome).toBe('active');
    expect(result.grantsVerifiedAt).toBe(VERIFIED_AT.toISOString());
  });

  it('returns deterministic sorted unique observed, missing, and unexpected sets', () => {
    const unexpected: CanonicalAppRoleAssignment[] = [
      {
        resourceApplicationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        appRoleId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        value: 'Zed',
      },
      {
        resourceApplicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        appRoleId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        value: null,
      },
    ];
    const result = reconcile([
      ...unexpected.reverse(),
      ...expected.slice(2).reverse(),
      unexpected[0]!,
    ]);

    for (const grants of [result.observedGrants, result.missingGrants, result.unexpectedGrants]) {
      const keys = grants!.map((grant) => `${grant.resourceApplicationId}/${grant.appRoleId}`);
      expect(keys).toEqual([...new Set(keys)].sort());
    }
  });
});
