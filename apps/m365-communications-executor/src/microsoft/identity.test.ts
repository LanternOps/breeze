import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyDelegatedUserIdentity } from './identity';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-2222222222ab';
const USER_ID = '33333333-3333-4333-8333-3333333333cd';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
const NONCE = 'one-time-nonce';
const NOW = new Date('2026-07-29T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let otherAlgorithmKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair('RS256'));
  ({ privateKey: otherPrivateKey } = await generateKeyPair('RS256'));
  ({ privateKey: otherAlgorithmKey } = await generateKeyPair('ES256'));
});

function baseClaims(): Record<string, unknown> {
  return {
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    aud: CLIENT_ID,
    sub: 'signed-subject',
    tid: TENANT_ID,
    oid: USER_ID,
    nonce: NONCE,
    exp: NOW_SECONDS + 300,
    nbf: NOW_SECONDS - 30,
  };
}

async function sign(
  overrides: Record<string, unknown> = {},
  key: CryptoKey = privateKey,
  algorithm = 'RS256',
): Promise<string> {
  const claims = { ...baseClaims(), ...overrides };
  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[name];
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm, kid: 'test-key' })
    .sign(key);
}

function verify(token: string, overrides: Partial<{
  clientId: string;
  nonce: string;
  expectedTenantId: string | null;
}> = {}) {
  return verifyDelegatedUserIdentity(token, {
    clientId: CLIENT_ID,
    nonce: NONCE,
    expectedTenantId: null,
    ...overrides,
  }, { verificationKey: publicKey, currentDate: NOW });
}

describe('verifyDelegatedUserIdentity', () => {
  it('accepts a valid first-consent token and returns the learned canonical tid/oid', async () => {
    const token = await sign({ tid: TENANT_ID.toUpperCase(), oid: USER_ID.toUpperCase() });

    await expect(verify(token)).resolves.toEqual({
      tenantId: TENANT_ID,
      userObjectId: USER_ID,
    });
  });

  it('verifies a token WITHOUT a wids claim — the delta from the admin gate', async () => {
    // A delegated user is not an administrator; the sibling gate requires
    // wids, this one must not.
    const token = await sign();
    await expect(verify(token)).resolves.toEqual({
      tenantId: TENANT_ID,
      userObjectId: USER_ID,
    });
  });

  it('passes a reconnect whose returned tenant matches the expected one', async () => {
    await expect(verify(await sign(), { expectedTenantId: TENANT_ID })).resolves.toEqual({
      tenantId: TENANT_ID,
      userObjectId: USER_ID,
    });
  });

  it('refuses a reconnect returning a different tenant with tenant_mismatch', async () => {
    const failure = await verify(await sign({
      tid: OTHER_TENANT,
      iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
    }), { expectedTenantId: TENANT_ID }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'tenant_mismatch', message: 'tenant_mismatch' });
    expect(failure).not.toHaveProperty('cause');
  });

  it.each([
    ['wrong signature', async () => sign({}, otherPrivateKey), {}],
    ['wrong algorithm', async () => sign({}, otherAlgorithmKey, 'ES256'), {}],
    ['iss not derived from tid', async () => sign({ iss: 'https://login.microsoftonline.com/common/v2.0' }), {}],
    [`iss for a different tenant than tid`, async () => sign({ iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }), {}],
    ['wrong audience', async () => sign({ aud: OTHER_TENANT }), {}],
    ['wrong nonce', async () => sign({ nonce: 'different' }), {}],
    ['expired token', async () => sign({ exp: NOW_SECONDS - 1 }), {}],
    ['not-yet-valid token', async () => sign({ nbf: NOW_SECONDS + 1 }), {}],
  ])('rejects %s with a stable sanitized error', async (_label, makeToken, expected) => {
    const failure = await verify(await makeToken()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'identity_token_invalid', message: 'identity_token_invalid', ...expected });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(USER_ID);
  });

  it.each([
    ['iss', undefined],
    ['aud', undefined],
    ['sub', undefined],
    ['tid', undefined],
    ['oid', undefined],
    ['nonce', undefined],
    ['exp', undefined],
    ['nbf', undefined],
    ['sub', ''],
    ['tid', 'not-a-guid'],
    ['oid', 'not-a-guid'],
    ['oid', []],
    ['nonce', 42],
    ['exp', 'never'],
    ['nbf', 'now'],
  ])('rejects missing or malformed %s claims', async (claim, value) => {
    await expect(verify(await sign({ [claim]: value }))).rejects.toMatchObject({
      code: 'identity_token_invalid',
      message: 'identity_token_invalid',
    });
  });

  it('requires a canonical expected client id and reconnect tenant', async () => {
    await expect(verify(await sign(), { clientId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }))
      .rejects.toMatchObject({ code: 'identity_token_invalid' });
    await expect(verify(await sign(), { expectedTenantId: TENANT_ID.toUpperCase() }))
      .rejects.toMatchObject({ code: 'identity_token_invalid' });
  });

  it('normalizes valid uppercase tid/oid GUID claims to lowercase', async () => {
    await expect(verify(await sign({ tid: TENANT_ID.toUpperCase(), oid: USER_ID.toUpperCase() })))
      .resolves.toEqual({ tenantId: TENANT_ID, userObjectId: USER_ID });
  });
});
