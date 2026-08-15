import { describe, expect, it } from 'vitest';

// Set BEFORE importing: v3 (AAD-bound) encryption only happens when a key id
// and keyring are configured. Without them secretCrypto silently degrades to
// v1 and IGNORES the AAD entirely — the degradation this module must refuse.
process.env.APP_ENCRYPTION_KEY_ID = 'current';
process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: 'current-key-material' });

import { encryptSecret } from './secretCrypto';
import {
  buildSecretEnvAad,
  openSecretEnv,
  sealSecretEnv,
  MAX_SECRET_ENV_ENTRIES,
  SCRIPT_SECRET_ENV_SCHEMA_VERSION,
} from './scriptSecretEnvelope';
import { MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH } from '@breeze/shared';

const CTX = {
  commandId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const OTHER_DEVICE = { ...CTX, deviceId: '33333333-3333-4333-8333-333333333333' };
const OTHER_COMMAND = { ...CTX, commandId: '44444444-4444-4444-8444-444444444444' };

describe('sealSecretEnv / openSecretEnv', () => {
  it('round-trips a map under a matching context', () => {
    const sealed = sealSecretEnv({ api_token: 'super-secret-value' }, CTX);
    expect(sealed.startsWith('enc:v3:')).toBe(true);
    expect(sealed).not.toContain('super-secret-value');
    expect(sealed).not.toContain('api_token');
    expect(openSecretEnv(sealed, CTX)).toEqual({ api_token: 'super-secret-value' });
  });

  it('refuses to open under a different device (AAD binding)', () => {
    const sealed = sealSecretEnv({ api_token: 'super-secret-value' }, CTX);
    expect(() => openSecretEnv(sealed, OTHER_DEVICE)).toThrow();
  });

  it('refuses to open under a different command (AAD binding)', () => {
    const sealed = sealSecretEnv({ api_token: 'super-secret-value' }, CTX);
    expect(() => openSecretEnv(sealed, OTHER_COMMAND)).toThrow();
  });

  it('refuses to seal when no active key id is configured (v1 fallback ignores AAD)', () => {
    const saved = process.env.APP_ENCRYPTION_KEY_ID;
    delete process.env.APP_ENCRYPTION_KEY_ID;
    try {
      expect(() => sealSecretEnv({ api_token: 'super-secret-value' }, CTX)).toThrow(
        /AAD-bound/i,
      );
    } finally {
      process.env.APP_ENCRYPTION_KEY_ID = saved;
    }
  });

  it('requires both context components', () => {
    expect(() =>
      sealSecretEnv({ api_token: 'super-secret-value' }, { commandId: '', deviceId: CTX.deviceId }),
    ).toThrow(/commandId and deviceId/);
    expect(() =>
      sealSecretEnv({ api_token: 'super-secret-value' }, { commandId: CTX.commandId, deviceId: '' }),
    ).toThrow(/commandId and deviceId/);
  });

  it('rejects a value shorter than the redaction floor', () => {
    expect(() => sealSecretEnv({ api_token: 'ab' }, CTX)).toThrow(
      new RegExp(String(MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH)),
    );
  });

  it('rejects an empty value', () => {
    expect(() => sealSecretEnv({ api_token: '' }, CTX)).toThrow();
  });

  it('rejects an empty map', () => {
    expect(() => sealSecretEnv({}, CTX)).toThrow(/empty/);
  });

  it('rejects a key outside the tenant-variable grammar', () => {
    expect(() => sealSecretEnv({ 'BAD KEY': 'super-secret-value' }, CTX)).toThrow();
    expect(() => sealSecretEnv({ '9leading': 'super-secret-value' }, CTX)).toThrow();
  });

  it('rejects a non-string value', () => {
    expect(() =>
      sealSecretEnv({ api_token: 12345 as unknown as string }, CTX),
    ).toThrow(/not a string/);
  });

  it('rejects more than the entry cap', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_SECRET_ENV_ENTRIES + 1 }, (_, i) => [`k${i}`, 'value-value']),
    );
    expect(() => sealSecretEnv(tooMany, CTX)).toThrow(/max/);
  });

  it('never leaks a secret value in an error message', () => {
    expect(() => sealSecretEnv({ api_token: 'ab' }, CTX)).toThrow(/api_token/);
    try {
      sealSecretEnv({ api_token: 'ab' }, CTX);
      throw new Error('expected sealSecretEnv to throw');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/"ab"/);
    }
  });

  it('rejects a decrypted payload that is not a flat string map', () => {
    const bogus = encryptSecret(
      JSON.stringify({ v: SCRIPT_SECRET_ENV_SCHEMA_VERSION, env: { a: { nested: true } } }),
      { aad: buildSecretEnvAad(CTX) },
    )!;
    expect(() => openSecretEnv(bogus, CTX)).toThrow(/not a string/);
  });

  it('rejects an unsupported schema version', () => {
    const bogus = encryptSecret(JSON.stringify({ v: 99, env: { a_key: 'value-value' } }), {
      aad: buildSecretEnvAad(CTX),
    })!;
    expect(() => openSecretEnv(bogus, CTX)).toThrow(/schema version/);
  });

  it('rejects unexpected top-level properties', () => {
    const bogus = encryptSecret(
      JSON.stringify({ v: SCRIPT_SECRET_ENV_SCHEMA_VERSION, env: { a_key: 'value-value' }, x: 1 }),
      { aad: buildSecretEnvAad(CTX) },
    )!;
    expect(() => openSecretEnv(bogus, CTX)).toThrow(/unexpected properties/);
  });

  it('rejects ciphertext that is not AAD-bound', () => {
    expect(() => openSecretEnv('enc:v1:whatever', CTX)).toThrow(/not AAD-bound/);
    expect(() => openSecretEnv('plaintext', CTX)).toThrow(/not AAD-bound/);
  });

  it('serializes deterministically regardless of insertion order', () => {
    const a = sealSecretEnv({ b_key: 'value-one', a_key: 'value-two' }, CTX);
    const b = sealSecretEnv({ a_key: 'value-two', b_key: 'value-one' }, CTX);
    // Ciphertext differs (random IV); the decrypted canonical form must not.
    expect(openSecretEnv(a, CTX)).toEqual(openSecretEnv(b, CTX));
    expect(Object.keys(openSecretEnv(a, CTX))).toEqual(['a_key', 'b_key']);
  });
});
