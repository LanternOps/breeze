import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OpaqueIdentityToken } from './tokenClient';
import {
  GLOBAL_ADMIN_ROLE_ID,
  PRIVILEGED_ROLE_ADMIN_ROLE_ID,
  verifyMicrosoftAdminIdentity,
} from './identity';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-2222222222ab';
const ADMIN_ID = '33333333-3333-4333-8333-3333333333cd';
const NONCE = 'one-time-nonce';
const NOW = new Date('2026-07-14T12:00:00.000Z');
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
    oid: ADMIN_ID,
    nonce: NONCE,
    wids: [GLOBAL_ADMIN_ROLE_ID],
    exp: NOW_SECONDS + 300,
    nbf: NOW_SECONDS - 30,
  };
}

async function sign(
  overrides: Record<string, unknown> = {},
  key: CryptoKey = privateKey,
  algorithm = 'RS256',
): Promise<OpaqueIdentityToken> {
  const claims = { ...baseClaims(), ...overrides };
  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[name];
  }
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm, kid: 'test-key' })
    .sign(key) as OpaqueIdentityToken;
}

function verify(token: OpaqueIdentityToken, overrides: Partial<{
  expectedTenantId: string | null;
  clientId: string;
  nonce: string;
}> = {}) {
  return verifyMicrosoftAdminIdentity(token, {
    expectedTenantId: TENANT_ID,
    clientId: CLIENT_ID,
    nonce: NONCE,
    ...overrides,
  }, { verificationKey: publicKey, currentDate: NOW });
}

describe('verifyMicrosoftAdminIdentity', () => {
  it.each([GLOBAL_ADMIN_ROLE_ID, PRIVILEGED_ROLE_ADMIN_ROLE_ID])(
    'accepts an eligible signed administrator role and returns only canonical identity (%s)',
    async (role) => {
      const token = await sign({
        tid: TENANT_ID.toUpperCase(),
        oid: ADMIN_ID.toUpperCase(),
        wids: [role.toUpperCase()],
      });

      await expect(verify(token)).resolves.toEqual({
        tenantId: TENANT_ID,
        administratorObjectId: ADMIN_ID,
        administratorUsername: null,
      });
    },
  );

  it.each([
    ['wrong signature', async () => sign({}, otherPrivateKey), {}],
    ['wrong algorithm', async () => sign({}, otherAlgorithmKey, 'ES256'), {}],
    ['wrong issuer', async () => sign({ iss: 'https://login.microsoftonline.com/common/v2.0' }), {}],
    ['wrong audience', async () => sign({ aud: '44444444-4444-4444-8444-444444444444' }), {}],
    ['wrong nonce', async () => sign({ nonce: 'different' }), {}],
    ['expired token', async () => sign({ exp: NOW_SECONDS - 1 }), {}],
    ['not-yet-valid token', async () => sign({ nbf: NOW_SECONDS + 1 }), {}],
  ])('rejects %s with a stable sanitized error', async (_label, makeToken, expected) => {
    const failure = await verify(await makeToken()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'identity_token_invalid', message: 'identity_token_invalid', ...expected });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(ADMIN_ID);
  });

  it('rejects a signed tenant that differs from the exact tenant hint', async () => {
    const otherTenant = '44444444-4444-4444-8444-444444444444';
    const failure = await verify(await sign({
      tid: otherTenant,
      iss: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
    })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'tenant_mismatch', message: 'tenant_mismatch' });
    expect(failure).not.toHaveProperty('cause');
  });

  it.each([
    ['tenant hint', {}, { expectedTenantId: TENANT_ID.toUpperCase() }],
    ['client audience', {}, { clientId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }],
  ])('requires a canonical expected %s', async (_label, claims, expected) => {
    await expect(verify(await sign(claims), expected)).rejects.toMatchObject({
      code: 'identity_token_invalid',
    });
  });

  it.each([
    ['tid', { tid: TENANT_ID.toUpperCase() }],
    ['oid', { oid: ADMIN_ID.toUpperCase() }],
  ])('normalizes a valid %s GUID claim to lowercase', async (_label, claims) => {
    await expect(verify(await sign(claims))).resolves.toEqual({
      tenantId: TENANT_ID,
      administratorObjectId: ADMIN_ID,
      administratorUsername: null,
    });
  });

  it.each([
    ['iss', undefined],
    ['aud', undefined],
    ['sub', undefined],
    ['tid', undefined],
    ['oid', undefined],
    ['nonce', undefined],
    ['wids', undefined],
    ['exp', undefined],
    ['nbf', undefined],
    ['sub', ''],
    ['iss', 42],
    ['aud', 42],
    ['sub', 42],
    ['tid', 42],
    ['oid', []],
    ['tid', 'not-a-guid'],
    ['oid', 'not-a-guid'],
    ['nonce', 42],
    ['wids', GLOBAL_ADMIN_ROLE_ID],
    ['wids', [GLOBAL_ADMIN_ROLE_ID, 42]],
    ['exp', 'never'],
    ['nbf', 'now'],
  ])('rejects missing or malformed %s claims', async (claim, value) => {
    await expect(verify(await sign({ [claim]: value }))).rejects.toMatchObject({
      code: 'identity_token_invalid',
      message: 'identity_token_invalid',
    });
  });

  it.each([
    { wids: [] },
    { wids: ['00000000-0000-4000-8000-000000000000'] },
    { wids: [`${GLOBAL_ADMIN_ROLE_ID}x`] },
  ])('rejects ineligible role claims ($wids)', async ({ wids }) => {
    await expect(verify(await sign({ wids }))).rejects.toMatchObject({
      code: 'admin_role_required',
      message: 'admin_role_required',
    });
  });

  describe('without an expected tenant (organizations sign-in)', () => {
    const OTHER_TENANT = '44444444-4444-4444-8444-4444444444ef';
    const otherIssuer = `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`;

    it('accepts any verified tenant and returns it', async () => {
      await expect(verify(await sign({ tid: OTHER_TENANT, iss: otherIssuer }), { expectedTenantId: null }))
        .resolves.toEqual({ tenantId: OTHER_TENANT, administratorObjectId: ADMIN_ID, administratorUsername: null });
    });

    it('still rejects a different tenant when one is expected (reconnect / upgrade)', async () => {
      await expect(verify(await sign({ tid: OTHER_TENANT, iss: otherIssuer }), { expectedTenantId: TENANT_ID }))
        .rejects.toMatchObject({ code: 'tenant_mismatch' });
    });

    it('derives the issuer from tid: a token for one tenant cannot claim another', async () => {
      await expect(verify(await sign({ tid: OTHER_TENANT }), { expectedTenantId: null }))
        .rejects.toMatchObject({ code: 'identity_token_invalid' });
    });

    it.each([
      ['wrong signature', async () => sign({}, otherPrivateKey)],
      ['wrong algorithm', async () => sign({}, otherAlgorithmKey, 'ES256')],
      ['wrong audience', async () => sign({ aud: '99999999-9999-4999-8999-999999999999' })],
      ['wrong nonce', async () => sign({ nonce: 'replayed' })],
      ['missing oid', async () => sign({ oid: undefined })],
      ['missing tid', async () => sign({ tid: undefined })],
      ['missing wids', async () => sign({ wids: undefined })],
      ['expired', async () => sign({ exp: NOW_SECONDS - 1 })],
      ['not yet valid', async () => sign({ nbf: NOW_SECONDS + 1 })],
      ['common issuer', async () => sign({ iss: 'https://login.microsoftonline.com/common/v2.0' })],
      ['organizations issuer', async () => sign({ iss: 'https://login.microsoftonline.com/organizations/v2.0' })],
      ['v1 issuer', async () => sign({ iss: `https://sts.windows.net/${TENANT_ID}/` })],
    ])('rejects %s', async (_label, makeToken) => {
      await expect(verify(await makeToken(), { expectedTenantId: null }))
        .rejects.toMatchObject({ code: 'identity_token_invalid', message: 'identity_token_invalid' });
    });

    it('rejects an ineligible role set', async () => {
      // User Administrator is not an accepted consent role
      await expect(verify(await sign({ wids: ['fe930be7-5e62-47db-91af-98c3a49a38b1'] }), { expectedTenantId: null }))
        .rejects.toMatchObject({ code: 'admin_role_required' });
      await expect(verify(await sign({ wids: [] }), { expectedTenantId: null }))
        .rejects.toMatchObject({ code: 'admin_role_required' });
    });

    it('accepts a Privileged Role Administrator', async () => {
      await expect(verify(await sign({ wids: [PRIVILEGED_ROLE_ADMIN_ROLE_ID] }), { expectedTenantId: null }))
        .resolves.toMatchObject({ tenantId: TENANT_ID });
    });
  });

  it('returns preferred_username only when it is a bounded printable string', async () => {
    expect((await verify(await sign({ preferred_username: 'admin@tenant.example' }), { expectedTenantId: null }))
      .administratorUsername).toBe('admin@tenant.example');
    expect((await verify(await sign({ preferred_username: 'x'.repeat(256) }), { expectedTenantId: null }))
      .administratorUsername).toBe('x'.repeat(256));
    for (const preferred_username of ['x'.repeat(257), '', 42, null, ['a@b.example'], 'admin\n@tenant.example', 'a\u007f@b.example']) {
      expect((await verify(await sign({ preferred_username }), { expectedTenantId: null })).administratorUsername)
        .toBeNull();
    }
  });

  it.each(['organizations', 'common', TENANT_ID.toUpperCase(), ''])(
    'rejects a non-canonical expected tenant %j before verifying the token',
    async (expectedTenantId) => {
      await expect(verify(await sign(), { expectedTenantId })).rejects.toMatchObject({ code: 'identity_token_invalid' });
    },
  );
});
