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

    expect(jwks.keys[0]!.kid).toBe(kid);
  });

  it('rejects an empty JWKS', async () => {
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify({ keys: [] });
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).rejects.toThrow(/at least one private signing JWK/);
  });

  it('rejects private signing keys without a kid', async () => {
    const { kid: _kid, ...jwk } = await generatedPrivateJwk();
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify(jwk);
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).rejects.toThrow(/non-empty kid/);
  });

  it('rejects duplicate key IDs', async () => {
    const kid = randomUUID();
    const first = await generatedPrivateJwk(kid);
    const second = await generatedPrivateJwk(kid);
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify({ keys: [first, second] });
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).rejects.toThrow(/duplicate kid/);
  });

  it('rejects public-only keys for provider signing', async () => {
    const { d: _d, ...publicOnly } = await generatedPrivateJwk();
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify(publicOnly);
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).rejects.toThrow(/private signing material/);
  });

  it('rejects non-EdDSA signing metadata', async () => {
    const jwk = { ...(await generatedPrivateJwk()), alg: 'RS256' };
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify(jwk);
    vi.resetModules();
    const { loadJwks } = await loadKeys();

    await expect(loadJwks()).rejects.toThrow(/alg EdDSA/);
  });

  describe('loadPublicJwks', () => {
    it('strips private fields (d, p, q, dp, dq, qi, oth, k) from every key in a mixed JWKS', async () => {
      // Build two valid private JWKs, then add bogus extra private fields to
      // exercise the full PRIVATE_JWK_FIELDS allowlist. Both keys live in the
      // same JWKS so we also assert no kid duplication after stripping.
      const a = await generatedPrivateJwk();
      const b = await generatedPrivateJwk();
      const aPlus: Record<string, unknown> = {
        ...a,
        // RSA-style fields ignored at validation time but must be stripped
        // from the public projection. Non-empty so we'd notice if they leaked.
        p: 'p-bogus',
        q: 'q-bogus',
        dp: 'dp-bogus',
        dq: 'dq-bogus',
        qi: 'qi-bogus',
        // Symmetric-key field — must also be scrubbed.
        k: 'k-bogus',
        // Public-only metadata that should round-trip.
        extra: 'preserved',
      };
      process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify({ keys: [aPlus, b] });
      vi.resetModules();
      const { loadPublicJwks } = await loadKeys();

      const pub = await loadPublicJwks();
      expect(pub.keys).toHaveLength(2);

      const PRIVATE = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'r', 't', 'k'] as const;
      for (const key of pub.keys) {
        for (const field of PRIVATE) {
          expect(key).not.toHaveProperty(field);
        }
        // Required public fields must survive.
        expect(typeof key.kty).toBe('string');
        expect(typeof key.crv).toBe('string');
        expect(typeof key.x).toBe('string');
        expect(typeof key.kid).toBe('string');
      }

      // Kid uniqueness preserved post-strip (loadJwks already enforces this,
      // but we lock the post-strip invariant in too so future code can't
      // accidentally collapse keys when stripping rewrites kid values).
      const kids = pub.keys.map((k) => k.kid as string);
      expect(new Set(kids).size).toBe(kids.length);

      // Non-private extra fields preserved.
      expect((pub.keys[0] as Record<string, unknown>).extra).toBe('preserved');
    });

    it('inherits loadJwks rejection of public-only entries (missing d) before strip runs', async () => {
      // Defense-in-depth: if a key in OAUTH_JWKS_PRIVATE_JWK lacks `d`,
      // loadJwks should reject — loadPublicJwks must NOT silently produce a
      // public set from a partially-public input.
      const priv = await generatedPrivateJwk();
      const { d: _d, ...publicOnly } = await generatedPrivateJwk();
      process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify({ keys: [priv, publicOnly] });
      vi.resetModules();
      const { loadPublicJwks } = await loadKeys();

      await expect(loadPublicJwks()).rejects.toThrow(/private signing material/);
    });
  });
});
