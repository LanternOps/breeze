import { describe, expect, it } from 'vitest';
import {
  M365_PERMISSION_PROFILES as SHARED_M365_PERMISSION_PROFILES,
} from '@breeze/shared/m365';
import {
  M365_PERMISSION_PROFILES,
  connectionNeedsConsentReconciliation,
  getM365PermissionProfile,
} from './profiles';

const PROFILE_CONTRACTS = [
  {
    id: 'communications-delegated',
    version: 1,
    ownerAxis: 'user',
    authMode: 'delegated',
    credentialDomain: 'communications-delegated',
    executor: 'communications',
    grantClass: 'delegated',
  },
  {
    id: 'customer-graph-read',
    version: 2,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    executor: 'graph-read',
    grantClass: 'application',
  },
  {
    id: 'customer-graph-actions',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-actions',
    executor: 'graph-actions',
    grantClass: 'application',
  },
  {
    id: 'customer-exchange-powershell',
    version: 1,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-exchange-powershell',
    executor: 'exchange-powershell',
    grantClass: 'application',
  },
] as const;

describe('M365 permission profiles', () => {
  it('keeps the API import seam backed by the shared registry', () => {
    expect(M365_PERMISSION_PROFILES).toBe(SHARED_M365_PERMISSION_PROFILES);
  });

  it('defines only the four production profiles', () => {
    expect(Object.keys(M365_PERMISSION_PROFILES).sort()).toEqual(
      PROFILE_CONTRACTS.map(({ id }) => id).sort(),
    );
  });

  it.each(PROFILE_CONTRACTS)('defines the exact contract for $id', (expected) => {
    const profile = M365_PERMISSION_PROFILES[expected.id];

    expect({
      ...profile,
      delegatedPermissionsEmpty: profile.delegatedPermissions.length === 0,
      applicationPermissionsEmpty: profile.applicationPermissions.length === 0,
    }).toMatchObject({
      id: expected.id,
      version: expected.version,
      ownerAxis: expected.ownerAxis,
      authMode: expected.authMode,
      credentialDomain: expected.credentialDomain,
      executor: expected.executor,
      delegatedPermissionsEmpty: expected.grantClass === 'application',
      applicationPermissionsEmpty: expected.grantClass === 'delegated',
    });
  });

  it('keeps read and mutation Graph grants separate', () => {
    const read = getM365PermissionProfile('customer-graph-read');
    const actions = getM365PermissionProfile('customer-graph-actions');
    expect(read.applicationPermissions).toContain('User.Read.All');
    expect(read.applicationPermissions).not.toContain('User.ReadWrite.All');
    expect(actions.applicationPermissions).toContain('User.ReadWrite.All');
    expect(actions.applicationPermissions).not.toContain('User.Read.All');
  });

  it('uses delegated auth only for communications and app certificates elsewhere', () => {
    expect(getM365PermissionProfile('communications-delegated').authMode).toBe('delegated');
    for (const id of ['customer-graph-read', 'customer-graph-actions', 'customer-exchange-powershell'] as const) {
      expect(getM365PermissionProfile(id).authMode).toBe('application-certificate');
    }
  });

  it('requires reconciliation whenever stored manifest version differs', () => {
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 2)).toBe(false);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 1)).toBe(true);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 3)).toBe(true);
  });
});
