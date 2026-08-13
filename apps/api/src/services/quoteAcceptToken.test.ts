import { describe, it, expect, beforeAll } from 'vitest';
import { createQuoteAcceptToken, verifyQuoteAcceptToken, regenerateQuoteAcceptToken } from './quoteAcceptToken';

beforeAll(() => { process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-123'; });

describe('quote-accept token', () => {
  it('round-trips quoteId/orgId/partnerId/jti', async () => {
    const { token, jti } = await createQuoteAcceptToken({ quoteId: 'q1', orgId: 'o1', partnerId: 'p1' });
    const claims = await verifyQuoteAcceptToken(token);
    expect(claims).toEqual({ quoteId: 'q1', orgId: 'o1', partnerId: 'p1', jti });
  });
  it('rejects a garbage token', async () => {
    expect(await verifyQuoteAcceptToken('not.a.jwt')).toBeNull();
  });
  it('rejects a viewer-purpose token (wrong audience/purpose)', async () => {
    const { createViewerAccessToken } = await import('./jwt');
    const viewer = await createViewerAccessToken({ sub: 'u1', email: 'a@b.com', sessionId: 's1', mfaSatisfied: true });
    expect(await verifyQuoteAcceptToken(viewer)).toBeNull();
  });
  it('honors a future expiresAt (quote expiry_date in the future)', async () => {
    const { token } = await createQuoteAcceptToken({ quoteId: 'q1', orgId: 'o1', partnerId: 'p1', expiresAt: new Date(Date.now() + 3_600_000) });
    expect(await verifyQuoteAcceptToken(token)).not.toBeNull();
  });
  it('a past expiresAt falls back to the default TTL (never mints an already-expired token)', async () => {
    // The expiry derivation deliberately defaults to +30d when expiresAt is in
    // the past, so a stale quote.expiry_date can't produce a born-dead link.
    const { token } = await createQuoteAcceptToken({ quoteId: 'q1', orgId: 'o1', partnerId: 'p1', expiresAt: new Date(Date.now() - 60_000) });
    expect(await verifyQuoteAcceptToken(token)).not.toBeNull();
  });
});

describe('regenerateQuoteAcceptToken', () => {
  const input = { quoteId: 'q1', orgId: 'o1', partnerId: 'p1' };

  // THE contract behind the stable share link: a quote's link is reproduced from
  // persisted non-secret parts, never stored. If this breaks, every already-sent
  // quote's "copy link" silently starts handing out a DIFFERENT url than the one
  // the customer was emailed. Reordering the SignJWT setter calls in
  // signAcceptToken is the way that happens — hence a byte-equality assertion.
  it('reproduces the exact token byte-for-byte', async () => {
    const { token, identity } = await createQuoteAcceptToken(input);
    expect(await regenerateQuoteAcceptToken(input, identity)).toBe(token);
  });

  it('reproduces a token minted with an explicit expiry', async () => {
    const { token, identity } = await createQuoteAcceptToken({ ...input, expiresAt: new Date(Date.now() + 3_600_000) });
    expect(await regenerateQuoteAcceptToken(input, identity)).toBe(token);
  });

  it('the regenerated token verifies to the same claims', async () => {
    const { token, identity } = await createQuoteAcceptToken(input);
    const regenerated = await regenerateQuoteAcceptToken(input, identity);
    expect(await verifyQuoteAcceptToken(regenerated!)).toEqual(await verifyQuoteAcceptToken(token));
  });

  it('returns null with no persisted identity (a quote predating identity storage)', async () => {
    expect(await regenerateQuoteAcceptToken(input, null)).toBeNull();
  });

  // A rotated-out kid must FAIL to reproduce rather than silently sign with the
  // active key: that would emit a valid-but-different token while the caller
  // believes it handed back the customer's original link.
  it('returns null when the signing kid is no longer in the keyring', async () => {
    const { identity } = await createQuoteAcceptToken(input);
    expect(await regenerateQuoteAcceptToken(input, { ...identity, kid: 'retired-kid' })).toBeNull();
  });

  it('a different jti produces a different token (identity is what pins the link)', async () => {
    const { token, identity } = await createQuoteAcceptToken(input);
    const other = await regenerateQuoteAcceptToken(input, { ...identity, jti: 'a-different-jti' });
    expect(other).not.toBe(token);
    expect(await verifyQuoteAcceptToken(other!)).toMatchObject({ jti: 'a-different-jti' });
  });
});
