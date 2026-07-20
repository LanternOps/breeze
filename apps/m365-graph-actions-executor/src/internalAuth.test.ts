import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createEdDsaInternalRequestAuthenticator } from './internalAuth';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

async function fixture(overrides: {
  iat?: number;
  exp?: number;
  audience?: string | string[];
  operation?: string;
} = {}) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const publicJwk = { ...await exportJWK(publicKey), kid: 'api-key-1' };
  const body = new TextEncoder().encode(`{"correlationId":"${CORRELATION_ID}"}`);
  const digest = await crypto.subtle.digest('SHA-256', body);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    operation: overrides.operation ?? 'execute-action',
    correlationId: CORRELATION_ID,
    bodySha256: Buffer.from(digest).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'api-key-1' })
    .setIssuer('breeze-api')
    .setAudience(overrides.audience ?? 'm365-graph-actions-executor')
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
      operation: 'execute-action',
      rawBody: body,
    })).resolves.toEqual({ correlationId: CORRELATION_ID });
  });

  it('rejects a body substitution with one stable failure', async () => {
    const { authenticator, token } = await fixture();
    const changedBody = new TextEncoder().encode(` {"correlationId":"${CORRELATION_ID}"}`);

    await expect(authenticator.verify({
      authorization: `Bearer ${token}`,
      operation: 'execute-action',
      rawBody: changedBody,
    })).rejects.toMatchObject({ code: 'internal_request_unauthorized', message: 'internal_request_unauthorized' });
  });

  it('rejects a token minted for a different operation with one stable failure', async () => {
    const { authenticator, body, token } = await fixture({ operation: 'another-operation' });

    await expect(authenticator.verify({
      authorization: `Bearer ${token}`,
      operation: 'execute-action',
      rawBody: body,
    })).rejects.toMatchObject({ code: 'internal_request_unauthorized' });
  });

  it('rejects a token issued in the future even when its total lifetime is bounded', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { authenticator, body, token } = await fixture({ iat: now + 30, exp: now + 60 });
    await expect(authenticator.verify({
      authorization: `Bearer ${token}`,
      operation: 'execute-action',
      rawBody: body,
    })).rejects.toMatchObject({ code: 'internal_request_unauthorized' });
  });

  it('rejects an audience array even when it contains the executor audience', async () => {
    const { authenticator, body, token } = await fixture({
      audience: ['m365-graph-actions-executor', 'another-service'],
    });
    await expect(authenticator.verify({
      authorization: `Bearer ${token}`,
      operation: 'execute-action',
      rawBody: body,
    })).rejects.toMatchObject({ code: 'internal_request_unauthorized' });
  });
});
