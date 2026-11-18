import { describe, expect, it } from 'vitest';

import { encryptionMethodLabel, encryptionStatusLabel } from './encryptionLabels';

const t = (key: string) =>
  ({
    'securityEncryptionPage.bitlocker': 'BitLocker',
    'securityEncryptionPage.filevault': 'FileVault',
    'securityEncryptionPage.luks': 'LUKS',
    'securityEncryptionPage.none': 'None',
    'securityEncryptionPage.unknown': 'Unknown',
    'securityEncryptionPage.fullyEncrypted': 'Fully Encrypted',
    'securityEncryptionPage.encrypted': 'Encrypted',
  })[key] ?? key;

describe('encryption labels', () => {
  it('maps methods to proper-noun display labels', () => {
    expect(encryptionMethodLabel('bitlocker', t)).toBe('BitLocker');
    expect(encryptionMethodLabel('filevault', t)).toBe('FileVault');
    expect(encryptionMethodLabel('luks', t)).toBe('LUKS');
    expect(encryptionMethodLabel('dm-crypt', t)).toBe('dm-crypt');
    expect(encryptionMethodLabel('none', t)).toBe('None');
    expect(encryptionMethodLabel(null, t)).toBe('Unknown');
  });

  it('humanizes status enums', () => {
    expect(encryptionStatusLabel('fully_encrypted', t)).toBe('Fully Encrypted');
    expect(encryptionStatusLabel('encrypted', t)).toBe('Encrypted');
    expect(encryptionStatusLabel('encryption_in_progress', t)).toBe('Encryption in progress');
    expect(encryptionStatusLabel(null, t)).toBe('-');
  });
});
