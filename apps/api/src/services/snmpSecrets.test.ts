import { describe, expect, it } from 'vitest';
import {
  decryptSnmpCommunities,
  decryptSnmpCredentials,
  encryptSnmpCommunities,
  encryptSnmpCredentials,
  isMaskedSnmpSecret,
  maskSnmpCredentials,
  mergeEncryptSnmpCommunities,
  mergeEncryptSnmpCredentials,
} from './snmpSecrets';
import { isEncryptedSecret } from './secretCrypto';

describe('snmp secret helpers', () => {
  it('encrypts and decrypts community strings', () => {
    const encrypted = encryptSnmpCommunities(['public', 'private'])!;

    expect(encrypted).toHaveLength(2);
    expect(encrypted.every(isEncryptedSecret)).toBe(true);
    expect(encrypted).not.toContain('public');
    expect(decryptSnmpCommunities(encrypted)).toEqual(['public', 'private']);
  });

  it('encrypts, masks, and decrypts nested credential secrets', () => {
    const encrypted = encryptSnmpCredentials({
      version: 'v3',
      username: 'poller',
      authPassphrase: 'auth-secret',
      privacyPassphrase: 'priv-secret',
    }) as Record<string, string>;

    expect(isEncryptedSecret(encrypted.authPassphrase!)).toBe(true);
    expect(isEncryptedSecret(encrypted.privacyPassphrase!)).toBe(true);
    expect(maskSnmpCredentials(encrypted)).toMatchObject({
      username: 'poller',
      authPassphrase: '********',
      privacyPassphrase: '********',
    });
    expect(decryptSnmpCredentials(encrypted)).toMatchObject({
      authPassphrase: 'auth-secret',
      privacyPassphrase: 'priv-secret',
    });
  });

  it('preserves masked update values', () => {
    const existingCommunities = encryptSnmpCommunities(['private'])!;
    const mergedCommunities = mergeEncryptSnmpCommunities(['********'], existingCommunities)!;
    expect(mergedCommunities).toEqual(existingCommunities);

    const existingCredentials = encryptSnmpCredentials({ authPassword: 'old-secret' });
    const mergedCredentials = mergeEncryptSnmpCredentials({ authPassword: '********' }, existingCredentials);
    expect(mergedCredentials).toEqual(existingCredentials);
    expect(isMaskedSnmpSecret('********')).toBe(true);
  });
});
