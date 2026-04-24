import { randomUUID } from 'crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadKeys = async () => import('./keys');

const clearOauthJwksEnv = () => {
  delete process.env.OAUTH_JWKS_PRIVATE_JWK;
};

const generatedPrivateJwk = async (kid = randomUUID()) => {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { ...(await exportJWK(privateKey)), kid, alg: 'EdDSA', use: 'sig' };
};

describe('oauth keys', () => {
  beforeEach(() => {
    clearOauthJwksEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearOauthJwksEnv();
  });

  it('throws when OAUTH_JWKS_PRIVATE_JWK is unset', async () => {
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).rejects.toThrow(/OAUTH_JWKS_PRIVATE_JWK/);
  });

  it('wraps a single private JWK object in a keys array', async () => {
    const jwk = await generatedPrivateJwk();
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify(jwk);
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).resolves.toEqual({ keys: [jwk] });
  });

  it('returns a JWKS keys array unchanged', async () => {
    const first = await generatedPrivateJwk();
    const second = await generatedPrivateJwk();
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify({ keys: [first, second] });
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).resolves.toEqual({ keys: [first, second] });
  });

  it('round-trips kid values through the loader', async () => {
    const kid = randomUUID();
    const jwk = await generatedPrivateJwk(kid);
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify(jwk);
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    const jwks = await loadJwks();

    expect(jwks.keys[0].kid).toBe(kid);
  });
});
