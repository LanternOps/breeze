import { describe, expect, it } from 'vitest';
import {
  M365_PERMISSION_PROFILES,
  connectionNeedsConsentReconciliation,
  getM365PermissionProfile,
} from './profiles';

describe('M365 permission profiles', () => {
  it('defines the four production profiles with isolated credential domains', () => {
    expect(Object.keys(M365_PERMISSION_PROFILES).sort()).toEqual([
      'communications-delegated',
      'customer-exchange-powershell',
      'customer-graph-actions',
      'customer-graph-read',
    ]);
    expect(new Set(Object.values(M365_PERMISSION_PROFILES).map((p) => p.credentialDomain)).size).toBe(4);
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
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 1)).toBe(false);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 0)).toBe(true);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 2)).toBe(true);
  });
});
