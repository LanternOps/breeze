import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadMfaCrypto(env: Record<string, string>) {
  vi.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    ...env,
  };
  return import('./mfaSecretCrypto');
}

describe('mfaSecretCrypto', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it('encrypts MFA secrets with an MFA-specific prefix', async () => {
    const { decryptMfaTotpSecret, encryptMfaTotpSecret, isMfaEncryptedSecret } = await loadMfaCrypto({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'app-key-a',
      MFA_ENCRYPTION_KEY: 'mfa-key-a',
    });

    const encrypted = encryptMfaTotpSecret('totp-seed');

    expect(encrypted).not.toBeNull();
    expect(encrypted).toMatch(/^mfa:v1:/);
    expect(isMfaEncryptedSecret(encrypted!)).toBe(true);
    expect(decryptMfaTotpSecret(encrypted)).toBe('totp-seed');
  });

  it('decrypts MFA secrets when only APP_ENCRYPTION_KEY changes', async () => {
    const first = await loadMfaCrypto({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'app-key-a',
      MFA_ENCRYPTION_KEY: 'mfa-key-a',
    });
    const encrypted = first.encryptMfaTotpSecret('totp-seed');

    const second = await loadMfaCrypto({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'app-key-b',
      MFA_ENCRYPTION_KEY: 'mfa-key-a',
    });

    expect(second.decryptMfaTotpSecret(encrypted)).toBe('totp-seed');
  });

  it('does not decrypt MFA-domain secrets with the wrong MFA_ENCRYPTION_KEY', async () => {
    const first = await loadMfaCrypto({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'app-key-a',
      MFA_ENCRYPTION_KEY: 'mfa-key-a',
    });
    const encrypted = first.encryptMfaTotpSecret('totp-seed');

    const second = await loadMfaCrypto({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'app-key-a',
      MFA_ENCRYPTION_KEY: 'mfa-key-b',
    });

    expect(() => second.decryptMfaTotpSecret(encrypted)).toThrow();
  });

  it('decrypts legacy app-domain MFA secrets and returns MFA-domain migration ciphertext', async () => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'legacy-app-key',
      MFA_ENCRYPTION_KEY: 'mfa-key-a',
    };
    const { encryptSecret } = await import('./secretCrypto');
    const { decryptMfaTotpSecretForMigration } = await import('./mfaSecretCrypto');

    const legacyEncrypted = encryptSecret('legacy-totp-seed');
    const result = decryptMfaTotpSecretForMigration(legacyEncrypted);

    expect(result.plaintext).toBe('legacy-totp-seed');
    expect(result.migratedSecret).toMatch(/^mfa:v1:/);
    expect(result.migratedSecret).not.toBe(legacyEncrypted);

    const migratedCiphertext = result.migratedSecret;
    const reloaded = await loadMfaCrypto({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'rotated-app-key',
      MFA_ENCRYPTION_KEY: 'mfa-key-a',
    });

    expect(reloaded.decryptMfaTotpSecret(migratedCiphertext)).toBe('legacy-totp-seed');
  });
});
