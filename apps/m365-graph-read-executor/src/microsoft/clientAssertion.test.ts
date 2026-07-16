import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeJwt, decodeProtectedHeader, importX509, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { createClientAssertion } from './clientAssertion';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-2222222222ab';
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const certificatePem = readFileSync(
  new URL('../test/fixtures/client-cert.pem', import.meta.url),
  'utf8',
);
const privateKeyPem = readFileSync(
  new URL('../test/fixtures/client-key.pem', import.meta.url),
  'utf8',
);

describe('createClientAssertion', () => {
  it('signs an RS256 assertion for the exact tenant token endpoint', async () => {
    const now = new Date('2026-07-14T12:00:00.000Z');

    const assertion = await createClientAssertion({
      clientId: CLIENT_ID,
      tenantId: TENANT_ID,
      certificatePem,
      privateKeyPem,
      now,
    });

    const header = decodeProtectedHeader(assertion);
    const claims = decodeJwt(assertion);
    expect(header.alg).toBe('RS256');
    expect(claims).toMatchObject({
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: TOKEN_ENDPOINT,
      iat: now.getTime() / 1_000,
    });
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(300);
    expect(claims.exp! - claims.iat!).toBeGreaterThan(0);

    const publicKey = await importX509(certificatePem, 'RS256');
    await expect(jwtVerify(assertion, publicKey, {
      issuer: CLIENT_ID,
      subject: CLIENT_ID,
      audience: TOKEN_ENDPOINT,
      algorithms: ['RS256'],
      currentDate: now,
    })).resolves.toBeDefined();
  });

  it('derives Microsoft x5t directly from the parsed certificate DER', async () => {
    const assertion = await createClientAssertion({
      clientId: CLIENT_ID,
      tenantId: TENANT_ID,
      certificatePem,
      privateKeyPem,
    });
    const expected = createHash('sha1')
      .update(new X509Certificate(certificatePem).raw)
      .digest('base64url');

    expect(decodeProtectedHeader(assertion).x5t).toBe(expected);
    expect(expected).not.toContain('=');
  });

  it('uses a fresh jti for every assertion', async () => {
    const input = {
      clientId: CLIENT_ID,
      tenantId: TENANT_ID,
      certificatePem,
      privateKeyPem,
      now: new Date('2026-07-14T12:00:00.000Z'),
    };

    const first = decodeJwt(await createClientAssertion(input));
    const second = decodeJwt(await createClientAssertion(input));

    expect(first.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.jti).not.toBe(first.jti);
  });

  it.each([
    ['non-canonical tenant ID', 'organizations'],
    ['upper-case tenant ID', TENANT_ID.toUpperCase()],
    ['non-canonical client ID', 'client-id'],
  ])('rejects a %s before signing', async (_label, value) => {
    await expect(createClientAssertion({
      clientId: _label.includes('client') ? value : CLIENT_ID,
      tenantId: _label.includes('tenant') ? value : TENANT_ID,
      certificatePem,
      privateKeyPem,
    })).rejects.toMatchObject({ code: 'client_assertion_failed' });
  });

  it('replaces certificate and key failures with a stable secret-free code', async () => {
    const sentinel = 'SENTINEL-PRIVATE-KEY-MATERIAL';
    const failure = await createClientAssertion({
      clientId: CLIENT_ID,
      tenantId: TENANT_ID,
      certificatePem,
      privateKeyPem: sentinel,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'client_assertion_failed',
      message: 'client_assertion_failed',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(sentinel);
  });
});
