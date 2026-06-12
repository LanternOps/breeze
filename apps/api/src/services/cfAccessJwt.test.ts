import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const jwksState = vi.hoisted(() => ({
  importedPublicKey: undefined as unknown,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    jwtVerify: vi.fn(actual.jwtVerify),
    createRemoteJWKSet: vi.fn(
      () => async () => jwksState.importedPublicKey as Awaited<ReturnType<typeof actual.importJWK>>
    ),
  };
});

import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from 'jose';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  _resetCfAccessJwksCacheForTests,
  verifyCfAccessJwt,
} from './cfAccessJwt';

interface RsaKeypair {
  privateJwk: JWK;
  publicJwk: JWK;
  kid: string;
}

async function generateRsaKeypair(): Promise<RsaKeypair> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  const kid = randomUUID();
  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg: 'RS256', use: 'sig' },
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
    kid,
  };
}

const teamDomain = 'your-team.cloudflareaccess.com';
const issuer = `https://${teamDomain}`;
const audience = 'aud-app-1234567890abcdef';
const wrongAudience = 'aud-different-app';
const wrongIssuer = 'https://attacker.cloudflareaccess.com';

let keypair: RsaKeypair;

async function mintCfAccessJwt(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; ttlSeconds?: number; signerKey?: JWK; signerKid?: string } = {}
): Promise<string> {
  const signerJwk = opts.signerKey ?? keypair.privateJwk;
  const signerKid = opts.signerKid ?? keypair.kid;
  const key = await importJWK(signerJwk, 'RS256');

  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: signerKid })
    .setIssuer(opts.issuer ?? issuer)
    .setAudience(opts.audience ?? audience)
    .setIssuedAt();

  if (opts.ttlSeconds !== 0) {
    builder.setExpirationTime(`${opts.ttlSeconds ?? 600}s`);
  }

  return builder.sign(key);
}

describe('verifyCfAccessJwt', () => {
  beforeAll(async () => {
    keypair = await generateRsaKeypair();
    jwksState.importedPublicKey = await importJWK(keypair.publicJwk, 'RS256');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetCfAccessJwksCacheForTests();
  });

  it('accepts a valid token and returns its claims', async () => {
    const sub = 'cf-user-' + randomUUID();
    const token = await mintCfAccessJwt({
      email: 'user@example.com',
      sub,
      type: 'app',
      identity_nonce: 'nonce-abc',
      country: 'US',
    });

    const claims = await verifyCfAccessJwt(token, { teamDomain, audience });

    expect(claims.email).toBe('user@example.com');
    expect(claims.sub).toBe(sub);
    expect(claims.aud).toBe(audience);
    expect(claims.iss).toBe(issuer);
    expect(claims.type).toBe('app');
    expect(claims.identity_nonce).toBe('nonce-abc');
    expect(claims.country).toBe('US');
    expect(typeof claims.exp).toBe('number');
    expect(typeof claims.iat).toBe('number');
  });

  it('rejects a token signed by a different key', async () => {
    const attacker = await generateRsaKeypair();
    const token = await mintCfAccessJwt(
      { email: 'attacker@evil.com', sub: 'sub-x' },
      { signerKey: attacker.privateJwk, signerKid: attacker.kid }
    );

    await expect(verifyCfAccessJwt(token, { teamDomain, audience })).rejects.toBeInstanceOf(
      CfAccessInvalidTokenError
    );
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await mintCfAccessJwt(
      { email: 'user@example.com', sub: 'sub-1' },
      { audience: wrongAudience }
    );

    await expect(verifyCfAccessJwt(token, { teamDomain, audience })).rejects.toBeInstanceOf(
      CfAccessInvalidTokenError
    );
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await mintCfAccessJwt(
      { email: 'user@example.com', sub: 'sub-1' },
      { issuer: wrongIssuer }
    );

    await expect(verifyCfAccessJwt(token, { teamDomain, audience })).rejects.toBeInstanceOf(
      CfAccessInvalidTokenError
    );
  });

  it('rejects an expired token', async () => {
    const token = await mintCfAccessJwt(
      { email: 'user@example.com', sub: 'sub-1' },
      { ttlSeconds: -60 }
    );

    await expect(verifyCfAccessJwt(token, { teamDomain, audience })).rejects.toBeInstanceOf(
      CfAccessInvalidTokenError
    );
  });

  it('rejects a token missing the email claim', async () => {
    const token = await mintCfAccessJwt({ sub: 'sub-no-email' });

    await expect(verifyCfAccessJwt(token, { teamDomain, audience })).rejects.toBeInstanceOf(
      CfAccessInvalidTokenError
    );
  });

  it('rejects a token using a disallowed algorithm', async () => {
    const { generateKeyPair: gkp, exportJWK: exp, importJWK: imp } = await import('jose');
    const { privateKey } = await gkp('EdDSA', { crv: 'Ed25519', extractable: true });
    const otherKid = randomUUID();
    const privateJwk = { ...(await exp(privateKey)), kid: otherKid, alg: 'EdDSA', use: 'sig' };
    const key = await imp(privateJwk, 'EdDSA');

    const token = await new SignJWT({ email: 'user@example.com', sub: 'sub-1' })
      .setProtectedHeader({ alg: 'EdDSA', kid: otherKid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('600s')
      .sign(key);

    await expect(verifyCfAccessJwt(token, { teamDomain, audience })).rejects.toBeInstanceOf(
      CfAccessInvalidTokenError
    );
  });

  it('surfaces a CfAccessJwksUnavailableError when JWKS fetch fails', async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(
      verifyCfAccessJwt('any-token', { teamDomain, audience })
    ).rejects.toBeInstanceOf(CfAccessJwksUnavailableError);
  });

  it('accepts when the configured audience is a one-element set containing the token aud', async () => {
    const token = await mintCfAccessJwt({ email: 'user@example.com', sub: 'sub-set' });

    const claims = await verifyCfAccessJwt(token, { teamDomain, audience: [audience] });
    expect(claims.aud).toBe(audience);
  });

  it('rejects when the configured audience set does not include the token aud', async () => {
    const token = await mintCfAccessJwt({ email: 'user@example.com', sub: 'sub-set' });

    await expect(
      verifyCfAccessJwt(token, { teamDomain, audience: ['some-other-aud'] })
    ).rejects.toBeInstanceOf(CfAccessInvalidTokenError);
  });
});
