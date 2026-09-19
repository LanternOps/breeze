import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret, getSecretDerivedKeyMaterials } from './secretCrypto';
import {
  checkSsoProviderAuthority,
  openSsoExchangeCode,
  sealSsoExchangeCode,
} from './ssoBrowserTransition';

const payload = {
  accessToken: 'access-token-secret',
  refreshToken: 'refresh-token-secret',
  expiresInSeconds: 900,
};

const strictPrefix = 'sso-exchange:v1:';
const exchangeDomain = 'sso-token-exchange-grant.code:v1';

function sealWithSubstitutedAad(value: string, aad: string): string {
  const material = getSecretDerivedKeyMaterials(exchangeDomain).active;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', material.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${strictPrefix}${material.keyId ?? '~'}:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

describe('durable SSO exchange code envelope', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENCRYPTION_KEY = 'sso-exchange-test-key-material-at-least-32-bytes';
    process.env.APP_ENCRYPTION_KEY_ID = 'sso-current';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      'sso-current': 'sso-exchange-test-key-material-at-least-32-bytes',
    });
  });

  it('persists only a digest while the opaque code round-trips the token handoff', () => {
    const sealed = sealSsoExchangeCode(payload);

    expect(sealed.code).not.toContain(payload.accessToken);
    expect(sealed.code).not.toContain(payload.refreshToken);
    expect(sealed.codeDigest).toBe(
      createHash('sha256').update(sealed.code, 'utf8').digest('hex'),
    );
    expect(sealed.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(openSsoExchangeCode(sealed.code)).toEqual(payload);
  });

  it('uses randomized authenticated encryption and rejects alteration', () => {
    const first = sealSsoExchangeCode(payload);
    const second = sealSsoExchangeCode(payload);

    expect(first.code).not.toBe(second.code);
    const payloadStart = first.code.lastIndexOf(':') + 1;
    const mutationIndex = payloadStart + Math.floor((first.code.length - payloadStart) / 2);
    const replacement = first.code[mutationIndex] === 'A' ? 'B' : 'A';
    const altered = `${first.code.slice(0, mutationIndex)}${replacement}${first.code.slice(mutationIndex + 1)}`;
    expect(() => openSsoExchangeCode(altered)).toThrow();
  });

  it('uses the required AAD-bound envelope even without a configured key ID', () => {
    delete process.env.APP_ENCRYPTION_KEY_ID;
    delete process.env.APP_ENCRYPTION_KEYRING;

    const sealed = sealSsoExchangeCode(payload);

    expect(sealed.code).toMatch(/^sso-exchange:v1:~:/);
    expect(openSsoExchangeCode(sealed.code)).toEqual(payload);
  });

  it('rejects ciphertext sealed for a substituted authentication domain', () => {
    const sealed = sealSsoExchangeCode(payload);
    const substitutedDomain = sealed.code.replace(strictPrefix, 'other-domain:v1:');
    const substituted = sealWithSubstitutedAad(
      JSON.stringify(payload),
      'user_sso_identities.refresh_token',
    );

    expect(() => openSsoExchangeCode(substitutedDomain)).toThrow();
    expect(() => openSsoExchangeCode(substituted)).toThrow();
  });

  it('rejects legacy non-AAD v1 and v2 envelopes', () => {
    delete process.env.APP_ENCRYPTION_KEY_ID;
    delete process.env.APP_ENCRYPTION_KEYRING;
    const legacyV1 = encryptSecret(JSON.stringify(payload));
    if (!legacyV1) throw new Error('Missing v1 fixture');

    process.env.APP_ENCRYPTION_KEY_ID = 'sso-current';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      'sso-current': 'sso-exchange-test-key-material-at-least-32-bytes',
    });
    const legacyV2 = encryptSecret(JSON.stringify(payload));
    if (!legacyV2) throw new Error('Missing v2 fixture');

    expect(legacyV1).toMatch(/^enc:v1:/);
    expect(legacyV2).toMatch(/^enc:v2:/);
    expect(() => openSsoExchangeCode(legacyV1)).toThrow();
    expect(() => openSsoExchangeCode(legacyV2)).toThrow();
  });

  it('decrypts an AAD-bound envelope after its key becomes retained', () => {
    const oldKey = 'sso-exchange-old-key-material-at-least-32-bytes';
    const newKey = 'sso-exchange-new-key-material-at-least-32-bytes';
    process.env.APP_ENCRYPTION_KEY = oldKey;
    process.env.APP_ENCRYPTION_KEY_ID = 'sso-old';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ 'sso-old': oldKey });
    const sealed = sealSsoExchangeCode(payload);

    process.env.APP_ENCRYPTION_KEY = newKey;
    process.env.APP_ENCRYPTION_KEY_ID = 'sso-new';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      'sso-new': newKey,
      'sso-old': oldKey,
    });

    expect(sealed.code).toMatch(/^sso-exchange:v1:sso-old:/);
    expect(openSsoExchangeCode(sealed.code)).toEqual(payload);
  });
});

describe('SSO provider callback authority', () => {
  it('applies mode status and exact provider generation fail-closed', () => {
    expect(checkSsoProviderAuthority(
      { status: 'testing', configVersion: 4 },
      { providerVersion: 4, mode: 'login' },
    )).toEqual({ ok: false, reason: 'provider_not_usable' });
    expect(checkSsoProviderAuthority(
      { status: 'testing', configVersion: 4 },
      { providerVersion: 4, mode: 'link' },
    )).toEqual({ ok: true });
    expect(checkSsoProviderAuthority(
      { status: 'active', configVersion: 4 },
      { providerVersion: null, mode: 'login' },
    )).toEqual({ ok: false, reason: 'provider_version_missing' });
    expect(checkSsoProviderAuthority(
      { status: 'active', configVersion: 5 },
      { providerVersion: 4, mode: 'login' },
    )).toEqual({ ok: false, reason: 'provider_version_mismatch' });
  });
});
