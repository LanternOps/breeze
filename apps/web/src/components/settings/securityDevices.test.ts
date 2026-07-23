import { describe, expect, it } from 'vitest';
import { mergeSecurityDevices } from './securityDevices';

describe('mergeSecurityDevices', () => {
  it('joins a passkey and approver device sharing a credentialId into one row', () => {
    const rows = mergeSecurityDevices(
      [{ id: 'pk1', name: 'Laptop', credentialId: 'cred-1', lastUsedAt: null }],
      [{ id: 'ad1', label: 'Laptop', kind: 'webauthn_platform', credentialId: 'cred-1', isPlatformBound: true, createdAt: 'x', lastUsedAt: null }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].passkey?.id).toBe('pk1');
    expect(rows[0].approver?.id).toBe('ad1');
  });

  it('keeps unmatched credentials and mobile keys as their own rows', () => {
    const rows = mergeSecurityDevices(
      [{ id: 'pk1', name: 'Laptop', credentialId: 'cred-1', lastUsedAt: null }],
      [{ id: 'ad2', label: 'Phone', kind: 'mobile_hw_key', credentialId: null, isPlatformBound: true, createdAt: 'x', lastUsedAt: null }],
    );
    expect(rows).toHaveLength(2);
  });

  it('never merges on a null/absent credentialId', () => {
    const rows = mergeSecurityDevices(
      [{ id: 'pk1', name: 'A', credentialId: null, lastUsedAt: null }],
      [{ id: 'ad1', label: 'B', kind: 'webauthn_platform', credentialId: null, isPlatformBound: false, createdAt: 'x', lastUsedAt: null }],
    );
    expect(rows).toHaveLength(2);
  });
});
