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
});
