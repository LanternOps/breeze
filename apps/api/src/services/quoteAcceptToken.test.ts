import { describe, it, expect, beforeAll } from 'vitest';
import { createQuoteAcceptToken, verifyQuoteAcceptToken } from './quoteAcceptToken';

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
    const viewer = await createViewerAccessToken({ sub: 'u1', email: 'a@b.com', sessionId: 's1' });
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
