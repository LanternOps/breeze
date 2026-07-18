import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createEdDsaInternalRequestAuthenticator } from './internalAuth';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

async function fixture(overrides: { iat?: number; exp?: number; audience?: string | string[] } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const publicJwk = { ...await exportJWK(publicKey), kid: 'api-key-1' };
  const body = new TextEncoder().encode(`{"correlationId":"${CORRELATION_ID}"}`);
  const digest = await crypto.subtle.digest('SHA-256', body);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    operation: 'complete-consent',
    correlationId: CORRELATION_ID,
    bodySha256: Buffer.from(digest).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'api-key-1' })
    .setIssuer('breeze-api')
    .setAudience(overrides.audience ?? 'm365-graph-read-executor')
    .setSubject('breeze-control-plane')
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 60)
    .setJti('22222222-2222-4222-8222-222222222222')
    .sign(privateKey);
  return {
    body,
    token,
    authenticator: await createEdDsaInternalRequestAuthenticator({ publicJwk, kid: 'api-key-1' }),
  };
}

describe('executor internal request authentication', () => {
  it('verifies an EdDSA request bound to the exact operation and body bytes', async () => {
    const { authenticator, body, token } = await fixture();

    await expect(authenticator.verify({
      authorization: `Bearer ${token}`,
      operation: 'complete-consent',
      rawBody: body,
    })).resolves.toEqual({ correlationId: CORRELATION_ID });
  });

  it('rejects body substitution and operation substitution with one stable failure', async () => {
    const { authenticator, token } = await fixture();
    const changedBody = new TextEncoder().encode(` {"correlationId":"${CORRELATION_ID}"}`);
    for (const input of [
      { operation: 'complete-consent' as const, rawBody: changedBody },
      { operation: 'retest' as const, rawBody: new TextEncoder().encode(`{"correlationId":"${CORRELATION_ID}"}`) },
    ]) {
      await expect(authenticator.verify({ authorization: `Bearer ${token}`, ...input }))
        .rejects.toMatchObject({ code: 'internal_request_unauthorized', message: 'internal_request_unauthorized' });
    }
  });

  it('rejects a token issued in the future even when its total lifetime is bounded', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { authenticator, body, token } = await fixture({ iat: now + 30, exp: now + 60 });
    await expect(authenticator.verify({
      authorization: `Bearer ${token}`,
      operation: 'complete-consent',
      rawBody: body,
    })).rejects.toMatchObject({ code: 'internal_request_unauthorized' });
  });

  it('rejects an audience array even when it contains the executor audience', async () => {
    const { authenticator, body, token } = await fixture({
      audience: ['m365-graph-read-executor', 'another-service'],
    });
    await expect(authenticator.verify({
      authorization: `Bearer ${token}`,
      operation: 'complete-consent',
      rawBody: body,
    })).rejects.toMatchObject({ code: 'internal_request_unauthorized' });
  });
});
