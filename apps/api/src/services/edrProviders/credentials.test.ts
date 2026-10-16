import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

// v1 ciphertext ignores AAD, so APP_ENCRYPTION_KEY_ID must be set for the
// wrong-row assertion to fail for the right reason.
const original = {
  key: process.env.APP_ENCRYPTION_KEY,
  keyId: process.env.APP_ENCRYPTION_KEY_ID,
  keyring: process.env.APP_ENCRYPTION_KEYRING,
};
process.env.APP_ENCRYPTION_KEY = 'edr-provider-credentials-unit-test-key-material';
process.env.APP_ENCRYPTION_KEY_ID = 'edr-provider-credentials-test';
delete process.env.APP_ENCRYPTION_KEYRING;

afterAll(() => {
  for (const [k, v] of [
    ['APP_ENCRYPTION_KEY', original.key],
    ['APP_ENCRYPTION_KEY_ID', original.keyId],
    ['APP_ENCRYPTION_KEYRING', original.keyring],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

import { credentialFingerprint, decryptEdrSecret, encryptEdrSecret } from './credentials';

describe('edr credential crypto', () => {
  const creds = { apiKey: 'fake-unit-test-key-0000' };

  it('round-trips under the same row id', () => {
    const id = randomUUID();
    const sealed = encryptEdrSecret('connection_credentials', id, creds);
    expect(sealed).not.toContain('fake-unit-test-key');
    expect(decryptEdrSecret('connection_credentials', id, sealed)).toEqual(creds);
  });

  it('refuses to decrypt under a different row id (row-bound AAD)', () => {
    const sealed = encryptEdrSecret('connection_credentials', randomUUID(), creds);
    expect(() => decryptEdrSecret('connection_credentials', randomUUID(), sealed)).toThrow();
  });

  it('refuses to decrypt under a different column spec', () => {
    const id = randomUUID();
    const sealed = encryptEdrSecret('connection_credentials', id, creds);
    expect(() => decryptEdrSecret('connection_webhook_secret', id, sealed)).toThrow();
  });

  it('requires a row id and rejects an unknown spec loudly', () => {
    expect(() => encryptEdrSecret('connection_credentials', '', creds)).toThrow(/row id is required/);
    expect(() => encryptEdrSecret('nope' as never, randomUUID(), creds)).toThrow(/Unknown EDR secret spec/);
  });

  it('fingerprints deterministically without exposing the secret', () => {
    const a = credentialFingerprint('bitdefender', 'root1', creds);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(credentialFingerprint('bitdefender', 'root1', { ...creds }));
    expect(a).not.toBe(credentialFingerprint('bitdefender', 'root2', creds));
    expect(a).not.toContain('fake-unit-test-key');
  });
});
