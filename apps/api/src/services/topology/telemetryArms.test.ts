import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withDbTransaction: vi.fn(), withSystemDbAccessContext: vi.fn() }));

import { resolvePollCredential } from './telemetryArms';
import { topologyCredentialDigest } from './telemetryArmFence';

describe('resolvePollCredential', () => {
  it('prefers a v3 user with normalized protocols and keeps passphrases as the secret fields', () => {
    const credential = resolvePollCredential(['public'], { version: 'v3', username: 'mon', authProtocol: 'SHA-256', authPassword: 'a-secret', privacyProtocol: 'AES128', privacyPassphrase: 'p-secret' });
    expect(credential).toEqual({
      snmp: { version: 'v3', username: 'mon', authProtocol: 'sha256', privProtocol: 'aes', timeoutMs: 2000, retries: 1 },
      secrets: { snmpAuthPassphrase: 'a-secret', snmpPrivPassphrase: 'p-secret' },
    });
  });

  it('refuses an unsupported protocol instead of silently downgrading', () => {
    expect(resolvePollCredential(['public'], { version: 'v3', username: 'mon', authProtocol: 'rot13' })).toBeNull();
    expect(resolvePollCredential([], { version: 'v3', username: 'mon', privProtocol: 'aes' })).toBeNull();
  });

  it('falls back to a v2c community and to the profile communities', () => {
    expect(resolvePollCredential([], [{ version: 'v1', community: 'c1' }])?.secrets).toEqual({ snmpCommunity: 'c1' });
    expect(resolvePollCredential(['', 'c2'], null)).toMatchObject({ snmp: { version: 'v2c' }, secrets: { snmpCommunity: 'c2' } });
    expect(resolvePollCredential([], null)).toBeNull();
  });
});

describe('topologyCredentialDigest', () => {
  const profile = { id: '11111111-1111-4111-8111-111111111111', enabled: true, methods: ['snmp'], snmpCommunities: ['enc:a'], snmpCredentials: null };
  it('changes with the credential material, enabled state or SNMP method — never with plaintext', () => {
    const digest = topologyCredentialDigest(profile);
    expect(topologyCredentialDigest({ ...profile })).toBe(digest);
    expect(topologyCredentialDigest({ ...profile, snmpCommunities: ['enc:b'] })).not.toBe(digest);
    expect(topologyCredentialDigest({ ...profile, enabled: false })).not.toBe(digest);
    expect(topologyCredentialDigest({ ...profile, methods: ['icmp'] })).not.toBe(digest);
  });
});
