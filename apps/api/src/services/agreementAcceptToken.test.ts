import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { SignJWT } from 'jose';

// Redis is mocked with a mutable holder so the revoke round-trip and the
// fail-closed branch are both observable (#9075 W2a, spec §3.5 "Token").
const redis = vi.hoisted(() => ({
  client: null as null | { store: Map<string, { value: string; ttl: number }>; set: any; get: any },
}));
vi.mock('./redis', () => ({ getRedis: () => redis.client }));

import {
  createAgreementAcceptToken,
  regenerateAgreementAcceptToken,
  verifyAgreementAcceptToken,
  revokeAgreementAcceptJti,
  isAgreementAcceptJtiRevoked,
} from './agreementAcceptToken';
import { createQuoteAcceptToken, verifyQuoteAcceptToken } from './quoteAcceptToken';
import { getSignKey, buildHeader } from './jwt';

beforeAll(() => { process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-123'; });

function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => { store.set(key, { value, ttl }); return 'OK'; }),
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
  };
}

const input = { requestId: 'r1', orgId: 'o1', partnerId: 'p1' };
const inAnHour = () => new Date(Date.now() + 3_600_000);

describe('agreement-accept token', () => {
  it('round-trips requestId/orgId/partnerId/jti', async () => {
    const { token, jti } = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    expect(await verifyAgreementAcceptToken(token)).toEqual({ requestId: 'r1', orgId: 'o1', partnerId: 'p1', jti });
  });

  it('exp is the request expires_at instant (whole seconds), not a 30-day default', async () => {
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000 + 999);
    const { identity } = await createAgreementAcceptToken({ ...input, expiresAt });
    expect(identity.expiresAtSeconds).toBe(Math.floor(expiresAt.getTime() / 1000));
  });

  it('refuses to mint for an expires_at that is not in the future (never a born-dead or default-TTL link)', async () => {
    await expect(createAgreementAcceptToken({ ...input, expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(/expires_at/);
  });

  it('jti is a random UUID per mint', async () => {
    const a = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    const b = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    expect(a.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.jti).not.toBe(b.jti);
  });

  it('rejects garbage', async () => {
    expect(await verifyAgreementAcceptToken('not.a.jwt')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await regenerateAgreementAcceptToken(input, {
      jti: 'j', issuedAtSeconds: 1_000_000_000, expiresAtSeconds: 1_000_000_100, kid: null,
    });
    expect(await verifyAgreementAcceptToken(token!)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { token } = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    const [h, p, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    claims.requestId = 'r2';
    const forged = [h, Buffer.from(JSON.stringify(claims)).toString('base64url'), s].join('.');
    expect(await verifyAgreementAcceptToken(forged)).toBeNull();
  });

  it('rejects an unknown kid', async () => {
    const { token } = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    const [, p, s] = token.split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'retired-kid' })).toString('base64url');
    expect(await verifyAgreementAcceptToken([header, p, s].join('.'))).toBeNull();
  });

  it('requires kind: agreement_request (same audience, missing kind → rejected)', async () => {
    const signKey = getSignKey();
    const noKind = await new SignJWT({ requestId: 'r1', orgId: 'o1', partnerId: 'p1' })
      .setProtectedHeader(buildHeader(signKey.kid))
      .setJti('j1').setIssuedAt().setExpirationTime('1h')
      .setIssuer('breeze').setAudience('breeze-agreement-accept')
      .sign(signKey.key);
    expect(await verifyAgreementAcceptToken(noKind)).toBeNull();
  });

  async function signWith(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; jti?: string } = {}) {
    const signKey = getSignKey();
    return new SignJWT(claims)
      .setProtectedHeader(buildHeader(signKey.kid))
      .setJti(opts.jti ?? 'j1').setIssuedAt().setExpirationTime('1h')
      .setIssuer(opts.iss ?? 'breeze').setAudience(opts.aud ?? 'breeze-agreement-accept')
      .sign(signKey.key);
  }

  it('rejects another kind value under the same audience', async () => {
    expect(await verifyAgreementAcceptToken(await signWith({ kind: 'quote', requestId: 'r1', orgId: 'o1', partnerId: 'p1' }))).toBeNull();
  });

  it('rejects a wrong issuer', async () => {
    expect(await verifyAgreementAcceptToken(await signWith({ kind: 'agreement_request', requestId: 'r1', orgId: 'o1', partnerId: 'p1' }, { iss: 'someone-else' }))).toBeNull();
  });

  it('rejects an empty jti and non-string identity claims', async () => {
    expect(await verifyAgreementAcceptToken(await signWith({ kind: 'agreement_request', requestId: 'r1', orgId: 'o1', partnerId: 'p1' }, { jti: '' }))).toBeNull();
    expect(await verifyAgreementAcceptToken(await signWith({ kind: 'agreement_request', requestId: 1, orgId: 'o1', partnerId: 'p1' }))).toBeNull();
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'none' })}.${enc({ kind: 'agreement_request', requestId: 'r1', orgId: 'o1', partnerId: 'p1', jti: 'j', iat: now, exp: now + 3600, iss: 'breeze', aud: 'breeze-agreement-accept' })}.`;
    expect(await verifyAgreementAcceptToken(unsigned)).toBeNull();
  });

  // Cross-kind confusion, both directions (spec §3.5: each verifier rejects
  // the other's tokens).
  it('a quote accept token is rejected by the agreement verifier', async () => {
    const { token } = await createQuoteAcceptToken({ quoteId: 'r1', orgId: 'o1', partnerId: 'p1' });
    expect(await verifyQuoteAcceptToken(token)).not.toBeNull();
    expect(await verifyAgreementAcceptToken(token)).toBeNull();
  });

  it('an agreement accept token is rejected by the quote verifier', async () => {
    const { token } = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    expect(await verifyAgreementAcceptToken(token)).not.toBeNull();
    expect(await verifyQuoteAcceptToken(token)).toBeNull();
  });

  it('rejects a viewer-purpose token', async () => {
    const { createViewerAccessToken } = await import('./jwt');
    const viewer = await createViewerAccessToken({ sub: 'u1', email: 'a@b.com', sessionId: 's1', mfaSatisfied: true });
    expect(await verifyAgreementAcceptToken(viewer)).toBeNull();
  });
});

describe('regenerateAgreementAcceptToken', () => {
  // THE contract behind the stable link (resend / copy-link hand out the SAME
  // url): the wire format is a pure function of claim content AND insertion
  // order. Only header + payload are pinned (independent of JWT_SECRET), as in
  // quoteAcceptToken.test.ts. If this fails, do not edit the strings: every
  // live agreement link just changed.
  it('reproduces the pinned wire format (golden vector — setter + key order is a contract)', async () => {
    const token = await regenerateAgreementAcceptToken(input, {
      jti: 'fixed-jti', issuedAtSeconds: 1_760_000_000, expiresAtSeconds: 1_770_000_000, kid: null,
    });
    const [header, payload, signature] = token!.split('.');
    expect(header).toBe('eyJhbGciOiJIUzI1NiJ9');
    expect(payload).toBe(
      'eyJraW5kIjoiYWdyZWVtZW50X3JlcXVlc3QiLCJyZXF1ZXN0SWQiOiJyMSIsIm9yZ0lkIjoibzEiLCJwYXJ0bmVySWQiOiJwMSIsImp0aSI6ImZpeGVkLWp0aSIsImlhdCI6MTc2MDAwMDAwMCwiZXhwIjoxNzcwMDAwMDAwLCJpc3MiOiJicmVlemUiLCJhdWQiOiJicmVlemUtYWdyZWVtZW50LWFjY2VwdCJ9',
    );
    // Spelled out: the ORDER here is the contract, not just the values.
    expect(Object.keys(JSON.parse(Buffer.from(payload!, 'base64url').toString()))).toEqual([
      'kind', 'requestId', 'orgId', 'partnerId', 'jti', 'iat', 'exp', 'iss', 'aud',
    ]);
    expect(signature).toBeTruthy();
  });

  it('reproduces a freshly-minted token byte-for-byte', async () => {
    const { token, identity } = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    expect(await regenerateAgreementAcceptToken(input, identity)).toBe(token);
  });

  it('returns null with no persisted identity', async () => {
    expect(await regenerateAgreementAcceptToken(input, null)).toBeNull();
  });

  it('returns null when the signing kid is no longer in the keyring (never silently re-signs)', async () => {
    const { identity } = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    expect(await regenerateAgreementAcceptToken(input, { ...identity, kid: 'retired-kid' })).toBeNull();
  });

  it('a different identity produces a different token', async () => {
    const { token, identity } = await createAgreementAcceptToken({ ...input, expiresAt: inAnHour() });
    const other = await regenerateAgreementAcceptToken(input, { ...identity, jti: 'another' });
    expect(other).not.toBe(token);
    expect(await verifyAgreementAcceptToken(other!)).toMatchObject({ jti: 'another' });
  });
});

describe('agreement-accept jti revocation (Redis hot path)', () => {
  beforeEach(() => { redis.client = fakeRedis(); });

  it('round-trips: not revoked → revoke → revoked', async () => {
    expect(await isAgreementAcceptJtiRevoked('j1')).toBe(false);
    await revokeAgreementAcceptJti('j1', inAnHour());
    expect(await isAgreementAcceptJtiRevoked('j1')).toBe(true);
    expect(await isAgreementAcceptJtiRevoked('j2')).toBe(false);
  });

  it('uses its own key namespace (never the quote one)', async () => {
    await revokeAgreementAcceptJti('j1', inAnHour());
    const keys = [...redis.client!.store.keys()];
    expect(keys).toEqual(['agreement-accept-jti-revoked:j1']);
  });

  it('the marker outlives the token: TTL covers a far expires_at, floor 30 days', async () => {
    const far = new Date(Date.now() + 200 * 24 * 3600 * 1000);
    await revokeAgreementAcceptJti('far', far);
    expect(redis.client!.store.get('agreement-accept-jti-revoked:far')!.ttl).toBeGreaterThanOrEqual(200 * 24 * 3600);
    await revokeAgreementAcceptJti('near', new Date(Date.now() + 60_000));
    expect(redis.client!.store.get('agreement-accept-jti-revoked:near')!.ttl).toBe(30 * 24 * 3600);
  });

  it('fails CLOSED when Redis is down: every jti reads as revoked', async () => {
    redis.client = null;
    expect(await isAgreementAcceptJtiRevoked('anything')).toBe(true);
  });

  it('revoke with Redis down does not throw (the DB columns are the durable authority)', async () => {
    redis.client = null;
    await expect(revokeAgreementAcceptJti('j1', inAnHour())).resolves.toBeUndefined();
  });
});
