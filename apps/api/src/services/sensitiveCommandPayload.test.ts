import { beforeAll, describe, expect, it } from 'vitest';

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-app-encryption-key-for-vitest';

import {
  encryptSensitivePayloadFields,
  decryptSensitivePayloadFields,
  hasSensitivePayload,
} from './sensitiveCommandPayload';

describe('sensitiveCommandPayload', () => {
  it('flags encryption_rotate_key as sensitive, others not', () => {
    expect(hasSensitivePayload('encryption_rotate_key')).toBe(true);
    expect(hasSensitivePayload('security_scan')).toBe(false);
  });

  it('round-trips password and currentRecoveryKey; leaves other fields alone', () => {
    const input = { username: 'jane', password: 'hunter2', currentRecoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', volumeMount: 'C:' };
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', input);
    expect(encrypted.username).toBe('jane');
    expect(encrypted.volumeMount).toBe('C:');
    expect(encrypted.password).not.toBe('hunter2');
    expect(String(encrypted.password)).toMatch(/^enc:/);
    expect(String(encrypted.currentRecoveryKey)).toMatch(/^enc:/);

    const decrypted = decryptSensitivePayloadFields('encryption_rotate_key', encrypted) as Record<string, unknown>;
    expect(decrypted.password).toBe('hunter2');
    expect(decrypted.currentRecoveryKey).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
  });

  it('is a passthrough for non-sensitive command types and non-object payloads', () => {
    const payload = { password: 'plaintext-untouched' };
    expect(encryptSensitivePayloadFields('security_scan', payload)).toBe(payload);
    expect(decryptSensitivePayloadFields('security_scan', payload)).toBe(payload);
    expect(decryptSensitivePayloadFields('encryption_rotate_key', null)).toBe(null);
    expect(decryptSensitivePayloadFields('encryption_rotate_key', 'str')).toBe('str');
  });

  it('skips absent/non-string sensitive fields', () => {
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', { volumeMount: 'C:' });
    expect(encrypted).toEqual({ volumeMount: 'C:' });
  });
});
