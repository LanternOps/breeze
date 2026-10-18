import { describe, expect, it } from 'vitest';
import {
  M365_PERMISSION_PROFILES,
  canonicalGrantKey,
  connectionNeedsConsentReconciliation,
  getM365PermissionProfile,
} from './profiles';
import { M365_WRITE_ACTION_REQUIRED_ROLES } from './writeActions';

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
    appRoleId: '5e1e9171-754d-478c-812c-f1755a9a4c2d',
    value: 'AuditLogsQuery.Read.All',
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
    appRoleId: '246dd0d5-5bd0-4def-940b-0421030a5b68',
    value: 'Policy.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '483bed4a-2ad3-4361-a73b-c83ccdbdc53c',
    value: 'RoleManagement.Read.Directory',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: 'bf394140-e372-4bf9-a898-299cfc7564e5',
    value: 'SecurityEvents.Read.All',
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
  it('defines the exact version 3 customer Graph read assignments', () => {
    const profile = M365_PERMISSION_PROFILES['customer-graph-read'];

    expect(profile.version).toBe(3);
    expect(profile.applicationPermissionAssignments).toEqual(CUSTOMER_GRAPH_READ_ASSIGNMENTS);
    expect(profile.applicationPermissions).toEqual(
      CUSTOMER_GRAPH_READ_ASSIGNMENTS.map(({ value }) => value),
    );
  });

  it('adds exactly the four tenant-sync scopes on top of the v2 set', () => {
    // Asserted as an exact delta rather than with toContain, so ADDING a fifth
    // scope fails too: every application permission on this profile is granted
    // tenant-wide by a customer's Global Administrator, and the whole point of
    // one manifest bump is that the set is deliberate (spec §2.1).
    const v2 = [
      'Application.Read.All', 'AuditLog.Read.All', 'Device.Read.All',
      'DeviceManagementConfiguration.Read.All', 'DeviceManagementManagedDevices.Read.All',
      'Group.Read.All', 'Organization.Read.All', 'Sites.Read.All', 'User.Read.All',
    ];
    const profile = M365_PERMISSION_PROFILES['customer-graph-read'];
    const added = profile.applicationPermissions.filter((value) => !v2.includes(value));
    expect([...added].sort()).toEqual([
      'AuditLogsQuery.Read.All',
      'Policy.Read.All',
      'RoleManagement.Read.Directory',
      'SecurityEvents.Read.All',
    ]);
    expect(profile.applicationPermissions).toHaveLength(13);
  });

  it('flags every stored v2 row for consent reconciliation', () => {
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 2)).toBe(true);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 3)).toBe(false);
  });

  it('gives every assignment a real GUID on the Microsoft Graph resource app', () => {
    // A typo'd appRoleId produces a permanent grant_missing that no customer
    // administrator can ever clear, because the role they approve is not the
    // role Breeze reconciles against.
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const profile = M365_PERMISSION_PROFILES['customer-graph-read'];
    const ids = new Set<string>();
    for (const grant of profile.applicationPermissionAssignments ?? []) {
      expect(grant.resourceApplicationId).toBe('00000003-0000-0000-c000-000000000000');
      expect(grant.appRoleId).toMatch(guid);
      ids.add(grant.appRoleId);
    }
    expect(ids.size).toBe(13);
  });

  describe('communications-delegated is mail-only at version 2', () => {
    const profile = M365_PERMISSION_PROFILES['communications-delegated'];

    it('requests exactly this scope set and no more', () => {
      // Asserted as an exact set rather than with `toContain`, so ADDING a scope fails too.
      // A delegated grant is a live credential for a named person's mailbox; every extra
      // scope widens what a compromised executor could do with it.
      expect([...profile.delegatedPermissions]).toEqual([
        'openid',
        'profile',
        'offline_access',
        'User.Read',
        'Mail.ReadWrite',
        'Mail.Send',
      ]);
    });

    it('is at version 2', () => {
      expect(profile.version).toBe(2);
    });

    it('drops the unexercised Teams scopes', () => {
      for (const scope of ['Chat.ReadWrite', 'ChannelMessage.Read.All', 'ChannelMessage.Send']) {
        expect(profile.delegatedPermissions).not.toContain(scope);
      }
    });

    it('retains offline_access', () => {
      // Without it there is no refresh token, so no send can ever run headless — the
      // single most consequential scope in the set, and the easiest to drop while
      // "trimming to mail-only".
      expect(profile.delegatedPermissions).toContain('offline_access');
    });

    it('grants no application permissions at all', () => {
      // The whole point of the user axis: this profile acts as a person, never as the app.
      expect(profile.applicationPermissions).toEqual([]);
      expect('applicationPermissionAssignments' in profile).toBe(false);
    });

    it('flags every stored v1 row for consent reconciliation', () => {
      // Existing connections consented under the v1 scope set must be re-consented rather
      // than silently treated as current.
      expect(connectionNeedsConsentReconciliation('communications-delegated', 1)).toBe(true);
      expect(connectionNeedsConsentReconciliation('communications-delegated', 2)).toBe(false);
      expect(connectionNeedsConsentReconciliation('communications-delegated', 3)).toBe(true);
    });
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

  it('requests exactly the M1 identity-catalog application roles', () => {
    expect([...p.applicationPermissions].sort()).toEqual([
      'DeviceManagementManagedDevices.PrivilegedOperations.All',
      'GroupMember.ReadWrite.All',
      'MailboxSettings.ReadWrite',
      'Organization.Read.All',
      'User-PasswordProfile.ReadWrite.All',
      'User.ReadWrite.All',
      'User.RevokeSessions.All',
    ]);
  });

  it('declares the matching app-role assignments with verified Graph GUIDs', () => {
    const byValue = Object.fromEntries(
      (p.applicationPermissionAssignments ?? []).map((g) => [g.value, g]),
    );
    // APPLICATION role IDs (appRoleAssignments), not the delegated oauth2PermissionScope IDs (#8648).
    // Each verified against https://learn.microsoft.com/en-us/graph/permissions-reference (Application column).
    expect(byValue['User.ReadWrite.All']?.appRoleId).toBe('741f803b-c850-494e-b5df-cde7c675a1ca');
    expect(byValue['User-PasswordProfile.ReadWrite.All']?.appRoleId).toBe('cc117bb9-00cf-4eb8-b580-ea2a878fe8f7');
    expect(byValue['User.RevokeSessions.All']?.appRoleId).toBe('77f3a031-c388-4f99-b373-dc68676a979e');
    // NOT 62a82d76-… — that is Group.ReadWrite.All, which this profile must never request.
    expect(byValue['GroupMember.ReadWrite.All']?.appRoleId).toBe('dbaae8cf-10b5-4b86-a4a1-f871c94c6695');
    expect(byValue['DeviceManagementManagedDevices.PrivilegedOperations.All']?.appRoleId)
      .toBe('5b07b0dd-2377-4e44-a38d-703f09a0dc3c');
    expect(byValue['MailboxSettings.ReadWrite']?.appRoleId).toBe('6931bccd-447a-43d1-b442-00a195474933');
    expect(byValue['Organization.Read.All']?.appRoleId).toBe('498476ce-e0fe-48b0-b801-37ba7e2685c6');
    for (const g of p.applicationPermissionAssignments ?? []) {
      expect(g.resourceApplicationId).toBe('00000003-0000-0000-c000-000000000000');
    }
    const ids = (p.applicationPermissionAssignments ?? []).map((g) => g.appRoleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is manifest version 3: one bump for the whole M1 identity catalog', () => {
    expect(p.version).toBe(3);
    expect(connectionNeedsConsentReconciliation('customer-graph-actions', 2)).toBe(true);
    expect(connectionNeedsConsentReconciliation('customer-graph-actions', 3)).toBe(false);
  });

  it('never requests Group.ReadWrite.All (least privilege, spec §7.1)', () => {
    expect(p.applicationPermissions).not.toContain('Group.ReadWrite.All');
    expect((p.applicationPermissionAssignments ?? []).map((g) => g.appRoleId))
      .not.toContain('62a82d76-70ea-41e2-9197-370581804d09');
  });

  it('holds every role M365_WRITE_ACTION_REQUIRED_ROLES names', () => {
    const held = new Set(getM365PermissionProfile('customer-graph-actions').applicationPermissions);
    for (const roles of Object.values(M365_WRITE_ACTION_REQUIRED_ROLES)) {
      for (const role of roles) expect(held.has(role)).toBe(true);
    }
  });

  it('assignment set equals the requested scope set', () => {
    const assignmentValues = (p.applicationPermissionAssignments ?? []).map((g) => g.value).sort();
    expect(assignmentValues).toEqual([...p.applicationPermissions].sort());
  });
});
