export const M365_CONNECTION_PROFILES = [
  'communications-delegated',
  'customer-graph-read',
  'customer-graph-actions',
  'customer-exchange-powershell',
] as const;

export type M365ConnectionProfile = (typeof M365_CONNECTION_PROFILES)[number];

export const M365_CREDENTIAL_DOMAINS = [
  'communications-delegated',
  'customer-graph-read',
  'customer-graph-actions',
  'customer-exchange-powershell',
] as const;

export type M365CredentialDomain = (typeof M365_CREDENTIAL_DOMAINS)[number];
export type M365AuthMode = 'delegated' | 'application-certificate';
export type M365ExecutorKind =
  | 'communications'
  | 'graph-read'
  | 'graph-actions'
  | 'exchange-powershell';

export interface M365ApplicationGrant {
  readonly resourceApplicationId: string;
  readonly appRoleId: string;
  readonly value: string;
}

export interface CanonicalAppRoleAssignment {
  readonly resourceApplicationId: string;
  readonly appRoleId: string;
  readonly value: string | null;
}

export interface M365PermissionProfileManifest {
  readonly id: M365ConnectionProfile;
  readonly version: number;
  readonly ownerAxis: 'user' | 'organization';
  readonly authMode: M365AuthMode;
  readonly credentialDomain: M365CredentialDomain;
  readonly executor: M365ExecutorKind;
  readonly delegatedPermissions: readonly string[];
  readonly applicationPermissions: readonly string[];
  readonly applicationPermissionAssignments?: readonly M365ApplicationGrant[];
}

export function canonicalGrantKey(
  grant: Pick<M365ApplicationGrant, 'resourceApplicationId' | 'appRoleId'>,
): string {
  return `${grant.resourceApplicationId}/${grant.appRoleId}`;
}

const MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID = '00000003-0000-0000-c000-000000000000';

export const M365_PERMISSION_PROFILES = {
  'communications-delegated': {
    id: 'communications-delegated',
    // v2 (2026-07-29): trimmed to mail-only. v1 also requested Chat.ReadWrite,
    // ChannelMessage.Read.All and ChannelMessage.Send for a Teams catalog that does not
    // exist and is not in the first cut. The actions runbook's own principle applies —
    // consenting scopes nothing exercises "only widens the mutation blast radius" — and
    // for a *delegated* profile the re-consent cost is one sign-in by one person, the
    // cheapest re-consent in the system. Teams scopes come back with the Teams catalog.
    version: 2,
    ownerAxis: 'user',
    authMode: 'delegated',
    credentialDomain: 'communications-delegated',
    executor: 'communications',
    delegatedPermissions: [
      'openid',
      'profile',
      // Load-bearing: without it Microsoft issues no refresh token, and every send would
      // need an interactive sign-in — which is exactly what the durable release path
      // cannot do.
      'offline_access',
      // Covers the consent-time identity probe, GET /me?$select=id,userPrincipalName,mail
      // (design §4.2). Note the probe deliberately does NOT read /me/mailboxSettings, so
      // MailboxSettings.Read is not required here.
      'User.Read',
      // Mail.Read would cover list/get, but draft.create needs write on the mailbox.
      'Mail.ReadWrite',
      'Mail.Send',
    ],
    applicationPermissions: [],
  },
  'customer-graph-read': {
    id: 'customer-graph-read',
    version: 2,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    executor: 'graph-read',
    delegatedPermissions: [],
    applicationPermissions: [
      'Application.Read.All',
      'AuditLog.Read.All',
      'Device.Read.All',
      'DeviceManagementConfiguration.Read.All',
      'DeviceManagementManagedDevices.Read.All',
      'Group.Read.All',
      'Organization.Read.All',
      'Sites.Read.All',
      'User.Read.All',
    ],
    applicationPermissionAssignments: [
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
    ],
  },
  'customer-graph-actions': {
    id: 'customer-graph-actions',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-actions',
    executor: 'graph-actions',
    delegatedPermissions: [],
    applicationPermissions: [
      'User.ReadWrite.All',
      'User-PasswordProfile.ReadWrite.All',
      // roadmap (each future action needs a manifest version bump + customer re-consent):
      //   'Group.ReadWrite.All',
      //   'DeviceManagementManagedDevices.PrivilegedOperations.All',
      //   'DeviceManagementConfiguration.ReadWrite.All',
      //   'Sites.ReadWrite.All',
    ],
    applicationPermissionAssignments: [
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4',
        value: 'User.ReadWrite.All',
      },
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '56760768-b641-451f-8906-e1b8ab31bca7',
        value: 'User-PasswordProfile.ReadWrite.All',
      },
    ],
  },
  'customer-exchange-powershell': {
    id: 'customer-exchange-powershell',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-exchange-powershell',
    executor: 'exchange-powershell',
    delegatedPermissions: [],
    applicationPermissions: ['Exchange.ManageAsApp'],
  },
} as const satisfies Record<M365ConnectionProfile, M365PermissionProfileManifest>;

export function getM365PermissionProfile(id: M365ConnectionProfile): M365PermissionProfileManifest {
  return M365_PERMISSION_PROFILES[id];
}

export function connectionNeedsConsentReconciliation(
  id: M365ConnectionProfile,
  storedVersion: number,
): boolean {
  return getM365PermissionProfile(id).version !== storedVersion;
}
