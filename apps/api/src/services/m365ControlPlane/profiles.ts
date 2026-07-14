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
export type M365ExecutorKind = 'communications' | 'graph-read' | 'graph-actions' | 'exchange-powershell';

export interface M365PermissionProfileManifest {
  readonly id: M365ConnectionProfile;
  readonly version: number;
  readonly ownerAxis: 'user' | 'organization';
  readonly authMode: M365AuthMode;
  readonly credentialDomain: M365CredentialDomain;
  readonly executor: M365ExecutorKind;
  readonly delegatedPermissions: readonly string[];
  readonly applicationPermissions: readonly string[];
}

export const M365_PERMISSION_PROFILES = {
  'communications-delegated': {
    id: 'communications-delegated',
    version: 1,
    ownerAxis: 'user',
    authMode: 'delegated',
    credentialDomain: 'communications-delegated',
    executor: 'communications',
    delegatedPermissions: [
      'openid',
      'profile',
      'offline_access',
      'User.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'Chat.ReadWrite',
      'ChannelMessage.Read.All',
      'ChannelMessage.Send',
    ],
    applicationPermissions: [],
  },
  'customer-graph-read': {
    id: 'customer-graph-read',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    executor: 'graph-read',
    delegatedPermissions: [],
    applicationPermissions: [
      'Organization.Read.All',
      'User.Read.All',
      'Device.Read.All',
      'Group.Read.All',
      'AuditLog.Read.All',
      'DeviceManagementManagedDevices.Read.All',
      'DeviceManagementConfiguration.Read.All',
      'Sites.Read.All',
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
      'Group.ReadWrite.All',
      'DeviceManagementManagedDevices.PrivilegedOperations.All',
      'DeviceManagementConfiguration.ReadWrite.All',
      'Sites.ReadWrite.All',
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
