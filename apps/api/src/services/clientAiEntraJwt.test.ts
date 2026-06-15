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
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
  _resetClientAiEntraJwksCacheForTests,
  verifyEntraIdToken,
} from './clientAiEntraJwt';

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

const audience = '00000000-aaaa-bbbb-cccc-000000000001';
const tid = '6f4f4f4f-1111-4222-8333-444455556666';
const oid = '7a7a7a7a-2222-4333-8444-555566667777';
const issuer = `https://login.microsoftonline.com/${tid}/v2.0`;

let keypair: RsaKeypair;

async function mintEntraToken(
  claims: Record<string, unknown>,
  opts: {
    issuer?: string;
    audience?: string;
    ttlSeconds?: number;
    signerKey?: JWK;
    signerKid?: string;
  } = {}
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

describe('verifyEntraIdToken', () => {
  beforeAll(async () => {
    keypair = await generateRsaKeypair();
    jwksState.importedPublicKey = await importJWK(keypair.publicJwk, 'RS256');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetClientAiEntraJwksCacheForTests();
  });

  it('accepts a valid token and returns normalized claims', async () => {
    const token = await mintEntraToken({
      tid,
      oid,
      preferred_username: 'Finance.User@Contoso.com',
      name: 'Finance User',
    });

    const claims = await verifyEntraIdToken(token, { audience });

    expect(claims.tid).toBe(tid);
    expect(claims.oid).toBe(oid);
    expect(claims.email).toBe('finance.user@contoso.com');
    expect(claims.name).toBe('Finance User');
    expect(claims.iss).toBe(issuer);
    expect(typeof claims.exp).toBe('number');
  });

  it('falls back to the email claim when preferred_username is not an address', async () => {
    const token = await mintEntraToken({
      tid,
      oid,
      preferred_username: 'CONTOSO\\finance.user',
      email: 'Finance.User@Contoso.com',
    });

    const claims = await verifyEntraIdToken(token, { audience });
    expect(claims.email).toBe('finance.user@contoso.com');
  });

  it('returns null email when no usable address claim exists', async () => {
    const token = await mintEntraToken({ tid, oid });
    const claims = await verifyEntraIdToken(token, { audience });
    expect(claims.email).toBeNull();
  });

  it('rejects a token signed by a different key (forged signature)', async () => {
    const attacker = await generateRsaKeypair();
    const token = await mintEntraToken(
      { tid, oid },
      { signerKey: attacker.privateJwk, signerKid: attacker.kid }
    );

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await mintEntraToken({ tid, oid }, { audience: 'some-other-app' });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects an expired token', async () => {
    const token = await mintEntraToken({ tid, oid }, { ttlSeconds: -60 });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token whose issuer does not match its own tid (tenant spoof)', async () => {
    const otherTid = '9b9b9b9b-3333-4444-8555-666677778888';
    const token = await mintEntraToken(
      { tid, oid },
      { issuer: `https://login.microsoftonline.com/${otherTid}/v2.0` }
    );

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token missing the tid claim', async () => {
    const token = await mintEntraToken({ oid });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token with a malformed oid claim', async () => {
    const token = await mintEntraToken({ tid, oid: 'not-a-guid' });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('surfaces ClientAiEntraJwksUnavailableError when the JWKS fetch fails', async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(verifyEntraIdToken('any-token', { audience })).rejects.toBeInstanceOf(
      ClientAiEntraJwksUnavailableError
    );
  });
});
