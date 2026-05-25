import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = [
  'APP_ENCRYPTION_KEY',
  'SSO_ENCRYPTION_KEY',
  'SECRET_ENCRYPTION_KEY',
  'APP_ENCRYPTION_KEY_ID',
  'SECRET_ENCRYPTION_KEY_ID',
  'APP_ENCRYPTION_KEYRING',
  'SECRET_ENCRYPTION_KEYRING',
  'JWT_SECRET',
  'SESSION_SECRET'
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function loadSecretCrypto(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return import('./secretCrypto');
}

describe('secretCrypto', () => {
  // In test environment (NODE_ENV=test), the module falls back to
  // 'test-only-secret-encryption-key' so we can test encrypt/decrypt.

  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('encrypts and decrypts a value', async () => {
    const { encryptSecret, decryptSecret, isEncryptedSecret } = await loadSecretCrypto();

    const original = 'my-secret-value';
    const encrypted = encryptSecret(original);

    expect(encrypted).not.toBeNull();
    expect(isEncryptedSecret(encrypted!)).toBe(true);
    expect(encrypted!.startsWith('enc:v1:')).toBe(true);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it('returns null for null/undefined input', async () => {
    const { encryptSecret, decryptSecret } = await loadSecretCrypto();

    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeNull();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeNull();
  });

  it('does not double-encrypt already encrypted values', async () => {
    const { encryptSecret } = await loadSecretCrypto();

    const encrypted = encryptSecret('hello');
    const doubleEncrypted = encryptSecret(encrypted);
    expect(doubleEncrypted).toBe(encrypted);
  });

  it('does not double-encrypt v2 values', async () => {
    const { encryptSecret } = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'current-key-material',
      APP_ENCRYPTION_KEY_ID: 'current'
    });

    const encrypted = encryptSecret('hello');
    expect(encrypted).toMatch(/^enc:v2:current:/);
    expect(encryptSecret(encrypted)).toBe(encrypted);
  });

  it('passes through unencrypted values in decryptSecret', async () => {
    const { decryptSecret } = await loadSecretCrypto();

    expect(decryptSecret('plain-text-value')).toBe('plain-text-value');
  });

  it('detects encrypted prefix correctly', async () => {
    const { isEncryptedSecret } = await loadSecretCrypto();

    expect(isEncryptedSecret('enc:v1:something')).toBe(true);
    expect(isEncryptedSecret('enc:v2:key-id:something')).toBe(true);
    expect(isEncryptedSecret('plain-text')).toBe(false);
    expect(isEncryptedSecret('')).toBe(false);
  });

  it('throws on malformed encrypted data', async () => {
    const { decryptSecret } = await loadSecretCrypto();

    expect(() => decryptSecret('enc:v1:bad-data')).toThrow('Malformed encrypted secret');
    expect(() => decryptSecret('enc:v2:bad-data')).toThrow('Malformed encrypted secret');
  });

  it('produces unique ciphertext for the same input', async () => {
    const { encryptSecret } = await loadSecretCrypto();

    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b); // Random IV ensures unique ciphertext
  });

  it('encrypts v2 when an active key id is configured', async () => {
    const { encryptSecret, decryptSecret, isEncryptedSecret } = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'current-key-material',
      APP_ENCRYPTION_KEY_ID: 'current'
    });

    const encrypted = encryptSecret('rotatable-secret');

    expect(encrypted).toMatch(/^enc:v2:current:/);
    expect(isEncryptedSecret(encrypted!)).toBe(true);
    expect(decryptSecret(encrypted)).toBe('rotatable-secret');
  });

  it('can encrypt v2 using the active key from the keyring', async () => {
    const { encryptSecret, decryptSecret } = await loadSecretCrypto({
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ current: 'current-key-material' })
    });

    const encrypted = encryptSecret('keyring-secret');

    expect(encrypted).toMatch(/^enc:v2:current:/);
    expect(decryptSecret(encrypted)).toBe('keyring-secret');
  });

  it('decrypts v2 ciphertext by key id from the keyring', async () => {
    const oldCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'old-key-material',
      APP_ENCRYPTION_KEY_ID: 'old'
    });
    const oldCiphertext = oldCrypto.encryptSecret('old-secret');

    const currentCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'current-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ old: 'old-key-material' })
    });

    expect(oldCiphertext).toMatch(/^enc:v2:old:/);
    expect(currentCrypto.decryptSecret(oldCiphertext)).toBe('old-secret');
  });

  it('keeps decrypting legacy v1 ciphertexts with the legacy active key', async () => {
    const legacyCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'legacy-key-material'
    });
    const legacyCiphertext = legacyCrypto.encryptSecret('legacy-secret');

    const currentCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'legacy-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ current: 'current-key-material' })
    });

    expect(legacyCiphertext).toMatch(/^enc:v1:/);
    expect(currentCrypto.decryptSecret(legacyCiphertext)).toBe('legacy-secret');
  });

  it('fails closed for unknown v2 key ids', async () => {
    const oldCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'old-key-material',
      APP_ENCRYPTION_KEY_ID: 'old'
    });
    const oldCiphertext = oldCrypto.encryptSecret('old-secret');

    const currentCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'current-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ current: 'current-key-material' })
    });

    expect(() => currentCrypto.decryptSecret(oldCiphertext)).toThrow('Unknown encrypted secret key ID');
  });

  it('rejects malformed keyring configuration when needed', async () => {
    const { encryptSecret } = await loadSecretCrypto({
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: '[]'
    });

    expect(() => encryptSecret('secret')).toThrow('Malformed APP_ENCRYPTION_KEYRING');
  });

  it('reports whether a value needs re-encryption to the active v2 key id', async () => {
    const oldCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'old-key-material',
      APP_ENCRYPTION_KEY_ID: 'old'
    });
    const oldCiphertext = oldCrypto.encryptSecret('secret');

    const currentCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'current-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ old: 'old-key-material' })
    });
    const currentCiphertext = currentCrypto.encryptSecret('secret');

    expect(currentCrypto.shouldReencryptSecret(oldCiphertext)).toBe(true);
    expect(currentCrypto.shouldReencryptSecret('plaintext-secret')).toBe(true);
    expect(currentCrypto.shouldReencryptSecret(currentCiphertext)).toBe(false);
    expect(currentCrypto.getEncryptedSecretKeyId(currentCiphertext!)).toBe('current');
  });

  it('re-encrypts legacy and old-key values to the active v2 key id', async () => {
    const legacyCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'legacy-key-material'
    });
    const legacyCiphertext = legacyCrypto.encryptSecret('legacy-secret');

    const currentCrypto = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'legacy-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ current: 'current-key-material' })
    });

    const rotated = currentCrypto.reencryptSecret(legacyCiphertext);
    expect(rotated).toMatch(/^enc:v2:current:/);
    expect(currentCrypto.decryptSecret(rotated)).toBe('legacy-secret');
  });

  it('requires an active key id for explicit re-encryption', async () => {
    const { reencryptSecret } = await loadSecretCrypto({
      APP_ENCRYPTION_KEY: 'current-key-material'
    });

    expect(() => reencryptSecret('plaintext-secret')).toThrow('APP_ENCRYPTION_KEY_ID');
  });

  describe('AAD binding (v3)', () => {
    it('encrypts with v3 prefix when aad is provided', async () => {
      const { encryptSecret, isEncryptedSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello', { aad: 'webhooks.secret' });
      expect(encrypted).toMatch(/^enc:v3:current:/);
      expect(isEncryptedSecret(encrypted!)).toBe(true);
    });

    it('round-trips with matching aad', async () => {
      const { encryptSecret, decryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello', { aad: 'webhooks.secret' });
      expect(decryptSecret(encrypted, { aad: 'webhooks.secret' })).toBe('hello');
    });

    it('refuses to decrypt with a different aad', async () => {
      const { encryptSecret, decryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello', { aad: 'sso_providers.client_secret' });
      expect(() => decryptSecret(encrypted, { aad: 'webhooks.secret' })).toThrow();
    });

    it('refuses to decrypt v3 without aad', async () => {
      const { encryptSecret, decryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello', { aad: 'webhooks.secret' });
      expect(() => decryptSecret(encrypted)).toThrow();
    });

    it('continues to decrypt v2 (no aad) without breaking', async () => {
      const { encryptSecret, decryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const v2 = encryptSecret('hello');
      expect(v2).toMatch(/^enc:v2:/);
      expect(decryptSecret(v2)).toBe('hello');
      // v2 also decrypts when callers pass aad (ignored for v2).
      expect(decryptSecret(v2, { aad: 'whatever' })).toBe('hello');
    });

    it('encryptSecret without opts.aad still produces v2 even when key id is configured', async () => {
      const { encryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello');
      expect(encrypted).toMatch(/^enc:v2:current:/);
    });

    it('detects v3 prefix via isEncryptedSecret', async () => {
      const { isEncryptedSecret } = await loadSecretCrypto();

      expect(isEncryptedSecret('enc:v3:current:something')).toBe(true);
    });

    it('returns key id for v3 ciphertext', async () => {
      const { encryptSecret, getEncryptedSecretKeyId } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello', { aad: 'webhooks.secret' });
      expect(getEncryptedSecretKeyId(encrypted!)).toBe('current');
    });

    it('does not double-encrypt v3 values', async () => {
      const { encryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello', { aad: 'webhooks.secret' });
      expect(encryptSecret(encrypted, { aad: 'webhooks.secret' })).toBe(encrypted);
    });

    it('reencryptSecret preserves aad binding when decrypting v3', async () => {
      const { encryptSecret, decryptSecret, reencryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const encrypted = encryptSecret('hello', { aad: 'webhooks.secret' });
      const rotated = reencryptSecret(encrypted, { aad: 'webhooks.secret' });
      expect(rotated).toMatch(/^enc:v3:current:/);
      expect(decryptSecret(rotated, { aad: 'webhooks.secret' })).toBe('hello');
    });

    it('throws on malformed v3 encrypted data', async () => {
      const { decryptSecret } = await loadSecretCrypto({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      expect(() => decryptSecret('enc:v3:bad-data', { aad: 'x' })).toThrow('Malformed encrypted secret');
    });
  });
});
