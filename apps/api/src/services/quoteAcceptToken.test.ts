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
  // persisted non-secret parts, never stored. If the WIRE FORMAT changes, every
  // already-sent quote's "copy link" silently starts handing out a different url
  // than the customer was emailed.
  //
  // This golden vector is the only assertion that can catch that. The
  // mint-vs-regenerate check below CANNOT: both sides run through the same
  // signAcceptToken, so reordering its setters (or the payload keys) changes
  // them together and they stay equal — verified by mutation, all other tests
  // in this file stay green under such a reorder.
  //
  // If this fails, do not edit the expected strings to make it pass. A changed
  // wire format means every live quote link in production just broke; the
  // change that caused it has to be reverted, or shipped with a deliberate
  // re-issue migration.
  //
  // Only the header and payload segments are pinned, NOT the signature: those
  // two are a pure function of the claim content and its key order, so they
  // catch the reorder while staying independent of whatever JWT_SECRET this
  // process happens to carry. (Pinning the signature would force this test to
  // mutate process.env.JWT_SECRET, which leaks to every other test file sharing
  // the worker — it made the config suite fail intermittently when tried.)
  it('reproduces the pinned wire format (golden vector — setter + key order is a contract)', async () => {
    const token = await regenerateQuoteAcceptToken(input, {
      jti: 'fixed-jti', issuedAtSeconds: 1_760_000_000, expiresAtSeconds: 1_770_000_000, kid: null,
    });
    const [header, payload, signature] = token!.split('.');
    expect(header).toBe('eyJhbGciOiJIUzI1NiJ9');
    expect(payload).toBe(
      'eyJxdW90ZUlkIjoicTEiLCJvcmdJZCI6Im8xIiwicGFydG5lcklkIjoicDEiLCJwdXJwb3NlIjoicXVvdGUtYWNjZXB0IiwianRpIjoiZml4ZWQtanRpIiwiaWF0IjoxNzYwMDAwMDAwLCJleHAiOjE3NzAwMDAwMDAsImlzcyI6ImJyZWV6ZSIsImF1ZCI6ImJyZWV6ZS1xdW90ZS1hY2NlcHQifQ',
    );
    // Spelled out so a future reader can see what the opaque string above locks
    // down — the ORDER here is the contract, not just the values.
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      quoteId: 'q1', orgId: 'o1', partnerId: 'p1', purpose: 'quote-accept',
      jti: 'fixed-jti', iat: 1_760_000_000, exp: 1_770_000_000,
      iss: 'breeze', aud: 'breeze-quote-accept',
    });
    expect(signature).toBeTruthy();
  });

  // Complements the golden vector: proves mint and regenerate agree for a
  // freshly-minted identity (the vector alone would pass even if
  // createQuoteAcceptToken stopped routing through signAcceptToken).
  it('reproduces a freshly-minted token byte-for-byte', async () => {
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
