import { beforeAll, describe, expect, it } from 'vitest';

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-app-encryption-key-for-vitest';

import {
  encryptSensitivePayloadFields,
  decryptSensitivePayloadFields,
  decryptCommandForDelivery,
  decryptCommandsForDelivery,
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

describe('decryptCommandForDelivery', () => {
  it('decrypts sensitive fields and preserves id/type', () => {
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', { username: 'jane', password: 'hunter2', currentRecoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' });
    const out = decryptCommandForDelivery({ id: 'cmd-1', type: 'encryption_rotate_key', payload: encrypted });
    expect(out).not.toBeNull();
    expect(out!.id).toBe('cmd-1');
    expect(out!.type).toBe('encryption_rotate_key');
    const payload = out!.payload as Record<string, unknown>;
    expect(payload.password).toBe('hunter2');
    expect(payload.currentRecoveryKey).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
    expect(payload.username).toBe('jane');
  });

  it('passes a non-sensitive command through unchanged', () => {
    const out = decryptCommandForDelivery({ id: 'cmd-2', type: 'security_scan', payload: { scanType: 'quick' } });
    expect(out).toEqual({ id: 'cmd-2', type: 'security_scan', payload: { scanType: 'quick' } });
  });

  it('returns null (drop, do not throw) when a sensitive field cannot be decrypted', () => {
    // A well-formed-looking but undecryptable ciphertext (e.g. after an
    // APP_ENCRYPTION_KEY rotation) must not blow up the delivery path.
    const out = decryptCommandForDelivery({ id: 'cmd-3', type: 'encryption_rotate_key', payload: { password: 'enc:v3:deadbeef:not-real-ciphertext' } });
    expect(out).toBeNull();
  });
});

describe('decryptCommandsForDelivery', () => {
  it('delivers decryptable commands and drops only the undecryptable one — one bad payload never sinks the batch', () => {
    const good = encryptSensitivePayloadFields('encryption_rotate_key', { password: 'pw' });
    const batch = [
      { id: 'a', type: 'security_scan', payload: { scanType: 'quick' } },
      { id: 'b', type: 'encryption_rotate_key', payload: good },
      { id: 'c', type: 'encryption_rotate_key', payload: { password: 'enc:v3:deadbeef:garbage' } },
    ];
    const out = decryptCommandsForDelivery(batch);
    expect(out.map((cmd) => cmd.id)).toEqual(['a', 'b']);
    expect((out[1].payload as Record<string, unknown>).password).toBe('pw');
  });

  it('returns an empty array for an empty batch', () => {
    expect(decryptCommandsForDelivery([])).toEqual([]);
  });
});
