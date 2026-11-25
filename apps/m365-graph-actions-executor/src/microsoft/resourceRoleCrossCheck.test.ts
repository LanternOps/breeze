import { describe, expect, it } from 'vitest';
import { getM365PermissionProfile, MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID } from '@breeze/shared/m365';
import { crossCheckManifestRolesAgainstToken } from './resourceRoleCrossCheck';

const RESOURCE = '44444444-4444-4444-8444-444444444444';
const OTHER_RESOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const required = getM365PermissionProfile('customer-graph-actions').applicationPermissionAssignments!;

describe('crossCheckManifestRolesAgainstToken (#12085)', () => {
  it('maps every manifest Graph role id to its value and returns them sorted by id', () => {
    const result = crossCheckManifestRolesAgainstToken(
      [...required].reverse().map((grant) => ({ resourceId: RESOURCE, appRoleId: grant.appRoleId })),
      required.map((grant) => grant.value),
    );
    expect(result).toEqual({
      grants: [...required]
        .map((grant) => ({
          resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
          appRoleId: grant.appRoleId,
          value: grant.value,
        }))
        .sort((left, right) => left.appRoleId.localeCompare(right.appRoleId)),
    });
  });

  it('collapses a duplicated assignment and still requires set equality with the token', () => {
    const grant = required[0]!;
    const assignments = [
      { resourceId: RESOURCE, appRoleId: grant.appRoleId },
      { resourceId: RESOURCE, appRoleId: grant.appRoleId },
    ];
    expect(crossCheckManifestRolesAgainstToken(assignments, [grant.value, grant.value])).toEqual({
      grants: [{ resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID, appRoleId: grant.appRoleId, value: grant.value }],
    });
    expect(crossCheckManifestRolesAgainstToken(assignments, [grant.value, required[1]!.value]))
      .toEqual({ failure: 'graph_token_roles_mismatch' });
  });

  it('rejects an empty inventory (no resource to establish)', () => {
    expect(crossCheckManifestRolesAgainstToken([], [])).toEqual({ failure: 'grant_resource_unresolved' });
  });

  it('rejects two resources before looking at role ids or the token', () => {
    expect(crossCheckManifestRolesAgainstToken(
      [
        { resourceId: RESOURCE, appRoleId: required[0]!.appRoleId },
        { resourceId: OTHER_RESOURCE, appRoleId: required[1]!.appRoleId },
      ],
      [required[0]!.value, required[1]!.value],
    )).toEqual({ failure: 'grant_resource_unresolved' });
  });

  it('compares role values exactly (case-sensitive)', () => {
    const grant = required[0]!;
    expect(crossCheckManifestRolesAgainstToken(
      [{ resourceId: RESOURCE, appRoleId: grant.appRoleId }],
      [grant.value.toLowerCase()],
    )).toEqual({ failure: 'graph_token_roles_mismatch' });
  });
});
