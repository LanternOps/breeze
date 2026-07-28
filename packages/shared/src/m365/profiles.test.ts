import { describe, expect, it } from 'vitest';
import {
  M365_PERMISSION_PROFILES,
  canonicalGrantKey,
} from './profiles';

const MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID = '00000003-0000-0000-c000-000000000000';

const CUSTOMER_GRAPH_READ_ASSIGNMENTS = [
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30',
    value: 'Application.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: 'b0afded3-3588-46d8-8b3d-9842eff778da',
    value: 'AuditLog.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '7438b122-aefc-4978-80ed-43db9fcc7715',
    value: 'Device.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: 'dc377aa6-52d8-4e23-b271-2a7ae04cedf3',
    value: 'DeviceManagementConfiguration.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '2f51be20-0bb4-4fed-bf7b-db946066c75e',
    value: 'DeviceManagementManagedDevices.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '5b567255-7703-4780-807c-7be8301ae99b',
    value: 'Group.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '498476ce-e0fe-48b0-b801-37ba7e2685c6',
    value: 'Organization.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '332a536c-c7ef-4017-ab91-336970924f0d',
    value: 'Sites.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: 'df021288-bdef-4463-88db-98f22de89214',
    value: 'User.Read.All',
  },
] as const;

describe('shared M365 permission profiles', () => {
  it('defines the exact version 2 customer Graph read assignments', () => {
    const profile = M365_PERMISSION_PROFILES['customer-graph-read'];

    expect(profile.version).toBe(2);
    expect(profile.applicationPermissionAssignments).toEqual(CUSTOMER_GRAPH_READ_ASSIGNMENTS);
    expect(profile.applicationPermissions).toEqual(
      CUSTOMER_GRAPH_READ_ASSIGNMENTS.map(({ value }) => value),
    );
  });

  it('keeps future application profiles name-only at version 1', () => {
    for (const id of ['customer-exchange-powershell'] as const) {
      const profile = M365_PERMISSION_PROFILES[id];

      expect(profile.version).toBe(1);
      expect(profile.applicationPermissions.length).toBeGreaterThan(0);
      expect('applicationPermissionAssignments' in profile).toBe(false);
    }
  });

  it('canonicalizes grant identity without presentation metadata', () => {
    const grant = CUSTOMER_GRAPH_READ_ASSIGNMENTS[0];

    expect(canonicalGrantKey(grant)).toBe(
      `${MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID}/${grant.appRoleId}`,
    );
  });
});

describe('customer-graph-actions manifest (least privilege)', () => {
  const p = M365_PERMISSION_PROFILES['customer-graph-actions'];

  it('requests exactly the two in-use application scopes', () => {
    expect([...p.applicationPermissions].sort()).toEqual(
      ['User-PasswordProfile.ReadWrite.All', 'User.ReadWrite.All'],
    );
  });

  it('declares the matching app-role assignments with verified Graph GUIDs', () => {
    const byValue = Object.fromEntries(
      (p.applicationPermissionAssignments ?? []).map((g) => [g.value, g]),
    );
    expect(byValue['User.ReadWrite.All']?.appRoleId).toBe('204e0828-b5ca-4ad8-b9f3-f32a958e7cc4');
    expect(byValue['User-PasswordProfile.ReadWrite.All']?.appRoleId).toBe('56760768-b641-451f-8906-e1b8ab31bca7');
    for (const g of p.applicationPermissionAssignments ?? []) {
      expect(g.resourceApplicationId).toBe('00000003-0000-0000-c000-000000000000');
    }
  });

  it('assignment set equals the requested scope set', () => {
    const assignmentValues = (p.applicationPermissionAssignments ?? []).map((g) => g.value).sort();
    expect(assignmentValues).toEqual([...p.applicationPermissions].sort());
  });
});
