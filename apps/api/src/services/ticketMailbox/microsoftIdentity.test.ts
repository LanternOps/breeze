import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  GLOBAL_ADMIN_ROLE_ID,
  PRIVILEGED_ROLE_ADMIN_ROLE_ID,
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftAuthorizationCode,
  hasMailboxConsentAdminRole,
  hasMailboxConsentAdminRoleViaGraph,
  verifyMicrosoftAdminIdToken,
} from './microsoftIdentity';

const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER_TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLIENT_ID = '99999999-8888-4777-8666-555555555555';
const OBJECT_ID = '12345678-1234-4234-8234-123456789abc';
const NONCE = 'nonce-value';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
type VerificationKey = Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let privateKey: SigningKey;
let publicKey: VerificationKey;

async function mintToken(
  claims: Record<string, unknown> = {},
  options: {
    audience?: string;
    issuer?: string;
    tenant?: string;
    expiresIn?: string;
    signingKey?: SigningKey;
  } = {},
): Promise<string> {
  const tenant = options.tenant ?? TENANT;
  return new SignJWT({
    tid: tenant,
    oid: OBJECT_ID,
    nonce: NONCE,
    wids: [GLOBAL_ADMIN_ROLE_ID],
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? `https://login.microsoftonline.com/${tenant}/v2.0`)
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject('microsoft-subject')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '10m')
    .sign(options.signingKey ?? privateKey);
}

async function verify(token: string, overrides: Partial<{ tenantHint: string; clientId: string; nonce: string }> = {}) {
  return verifyMicrosoftAdminIdToken(
    token,
    { tenantHint: TENANT, clientId: CLIENT_ID, nonce: NONCE, ...overrides },
    { verificationKey: publicKey },
  );
}

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 }));
});

describe('hasMailboxConsentAdminRole', () => {
  it('accepts Global Administrator', () => {
    expect(hasMailboxConsentAdminRole([GLOBAL_ADMIN_ROLE_ID])).toBe(true);
  });

  it('accepts Privileged Role Administrator', () => {
    expect(hasMailboxConsentAdminRole([PRIVILEGED_ROLE_ADMIN_ROLE_ID])).toBe(true);
  });

  it('rejects other directory roles', () => {
    expect(hasMailboxConsentAdminRole(['9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3'])).toBe(false);
  });

  it('rejects a missing role assignment', () => {
    expect(hasMailboxConsentAdminRole([])).toBe(false);
  });
});

describe('buildMicrosoftAuthorizationUrl', () => {
  it('builds the fixed tenant authorization endpoint with OIDC code and PKCE parameters', () => {
    const url = new URL(buildMicrosoftAuthorizationUrl({
      tenantHint: TENANT.toUpperCase(),
      clientId: CLIENT_ID,
      redirectUri: 'https://app.example.com/api/v1/tickets/mailbox/callback',
      state: 'state-value',
      nonce: NONCE,
      codeChallenge: 'challenge-value',
    }));

    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: 'https://app.example.com/api/v1/tickets/mailbox/callback',
      response_type: 'code',
      response_mode: 'query',
      scope: 'openid profile',
      state: 'state-value',
      nonce: NONCE,
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
    });
  });

  it('rejects tenant aliases and URL injection', () => {
    expect(() => buildMicrosoftAuthorizationUrl({
      tenantHint: 'common/../../organizations',
      clientId: CLIENT_ID,
      redirectUri: 'https://app.example.com/callback',
      state: 'state',
      nonce: NONCE,
      codeChallenge: 'challenge',
    })).toThrow('Invalid Microsoft tenant');
  });
});

describe('exchangeMicrosoftAuthorizationCode', () => {
  const input = {
    tenantHint: TENANT,
    clientId: CLIENT_ID,
    clientSecret: 'client-secret',
    redirectUri: 'https://app.example.com/api/v1/tickets/mailbox/callback',
    code: 'authorization-code',
    codeVerifier: 'verifier-value',
  };

  it('posts the code and PKCE verifier to the fixed tenant token endpoint', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => new Response(JSON.stringify({ id_token: 'id-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(exchangeMicrosoftAuthorizationCode(input, { fetch: fetchImpl })).resolves.toEqual({
      idToken: 'id-token',
      accessToken: null,
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(init).toBeDefined();
    expect(url.toString()).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(init!.redirect).toBe('error');
    expect(init!.method).toBe('POST');
    const body = new URLSearchParams(init!.body as string);
    expect(Object.fromEntries(body)).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: 'client-secret',
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
    });
  });

  it('rejects a non-2xx token response without exposing its body', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'sensitive provider detail',
    }), { status: 400 }));

    let error: unknown;
    try {
      await exchangeMicrosoftAuthorizationCode({ ...input, code: 'bad' }, { fetch: fetchImpl });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Microsoft identity verification failed');
    expect((error as Error).message).not.toContain('sensitive provider detail');
  });

  it('rejects a successful response without an id_token', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => new Response(JSON.stringify({ access_token: 'not-used' }), {
      status: 200,
    }));

    await expect(exchangeMicrosoftAuthorizationCode(input, { fetch: fetchImpl }))
      .rejects.toThrow('Microsoft identity verification failed');
  });

  it('extracts the delegated access_token alongside the id_token when present', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => new Response(JSON.stringify({
      id_token: 'id-token',
      access_token: 'delegated-access-token',
    }), { status: 200 }));

    await expect(exchangeMicrosoftAuthorizationCode(input, { fetch: fetchImpl })).resolves.toEqual({
      idToken: 'id-token',
      accessToken: 'delegated-access-token',
    });
  });
});

describe('verifyMicrosoftAdminIdToken', () => {
  it('returns normalized verified identity claims', async () => {
    const token = await mintToken({
      tid: TENANT.toUpperCase(),
      oid: OBJECT_ID.toUpperCase(),
      wids: [PRIVILEGED_ROLE_ADMIN_ROLE_ID],
    });

    await expect(verify(token)).resolves.toEqual({
      tid: TENANT,
      oid: OBJECT_ID,
      sub: 'microsoft-subject',
      wids: [PRIVILEGED_ROLE_ADMIN_ROLE_ID],
    });
  });

  it('rejects an invalid signature', async () => {
    const attacker = await generateKeyPair('RS256', { modulusLength: 2048 });
    await expect(verify(await mintToken({}, { signingKey: attacker.privateKey })))
      .rejects.toThrow('Microsoft identity verification failed');
  });

  it('rejects an invalid issuer', async () => {
    await expect(verify(await mintToken({}, { issuer: 'https://issuer.example.com' })))
      .rejects.toThrow('Microsoft identity verification failed');
  });

  it('rejects an invalid audience', async () => {
    await expect(verify(await mintToken({}, { audience: 'another-client' })))
      .rejects.toThrow('Microsoft identity verification failed');
  });

  it('rejects an expired token', async () => {
    await expect(verify(await mintToken({}, { expiresIn: '-1m' })))
      .rejects.toThrow('Microsoft identity verification failed');
  });

  it('rejects a nonce mismatch', async () => {
    await expect(verify(await mintToken({ nonce: 'wrong-nonce' })))
      .rejects.toThrow('Microsoft identity verification failed');
  });

  it('rejects a token from another tenant with a stable mismatch error', async () => {
    await expect(verify(await mintToken({}, { tenant: OTHER_TENANT })))
      .rejects.toThrow('Microsoft tenant mismatch');
  });

  it.each([
    ['missing tid', { tid: undefined }],
    ['malformed tid', { tid: 'not-a-guid' }],
    ['missing oid', { oid: undefined }],
    ['malformed oid', { oid: 'not-a-guid' }],
  ])('rejects %s', async (_name, claims) => {
    await expect(verify(await mintToken(claims)))
      .rejects.toThrow('Microsoft identity verification failed');
  });

  // verifyMicrosoftAdminIdToken no longer rejects on missing/unaccepted wids.
  // Some tenants never populate wids in the ID token even with
  // optionalClaims.idToken correctly configured — reproduced against a
  // from-scratch app registration and confirmed with Microsoft's own jwt.ms
  // token inspector. The admin-role decision now happens one level up
  // (hasMailboxConsentAdminRole / hasMailboxConsentAdminRoleViaGraph), so
  // this function's job is only to hand back whatever wids it found, valid
  // or empty, and let the caller decide.
  it('resolves with an empty wids array when the claim is missing, deferring the role decision to the caller', async () => {
    await expect(verify(await mintToken({ wids: undefined })))
      .resolves.toMatchObject({ wids: [] });
  });

  it('resolves with an empty wids array when the claim is malformed', async () => {
    await expect(verify(await mintToken({ wids: GLOBAL_ADMIN_ROLE_ID })))
      .resolves.toMatchObject({ wids: [] });
  });

  it('resolves with the presented wids even when none are accepted admin roles', async () => {
    await expect(verify(await mintToken({
      wids: ['9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3'],
    }))).resolves.toMatchObject({ wids: ['9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3'] });
  });
});

describe('hasMailboxConsentAdminRoleViaGraph', () => {
  it('returns false without a delegated access token', async () => {
    await expect(hasMailboxConsentAdminRoleViaGraph(null)).resolves.toBe(false);
  });

  it('accepts a Global Administrator returned by the live directory-role lookup', async () => {
    const fetchImpl = vi.fn<TestFetch>(async (input, init) => {
      expect(input.toString()).toBe(
        'https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.directoryRole?$select=roleTemplateId',
      );
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer delegated-token');
      return new Response(JSON.stringify({
        value: [{ roleTemplateId: GLOBAL_ADMIN_ROLE_ID }],
      }), { status: 200 });
    });

    await expect(hasMailboxConsentAdminRoleViaGraph('delegated-token', { fetch: fetchImpl })).resolves.toBe(true);
  });

  it('rejects a signed-in user with no accepted directory role', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => new Response(JSON.stringify({
      value: [{ roleTemplateId: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3' }],
    }), { status: 200 }));

    await expect(hasMailboxConsentAdminRoleViaGraph('delegated-token', { fetch: fetchImpl })).resolves.toBe(false);
  });

  it('treats a non-2xx Graph response (e.g. missing Directory.Read.All consent) as not-an-admin rather than throwing', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => new Response(JSON.stringify({
      error: { code: 'Authorization_RequestDenied' },
    }), { status: 403 }));

    await expect(hasMailboxConsentAdminRoleViaGraph('delegated-token', { fetch: fetchImpl })).resolves.toBe(false);
  });

  it('treats a network failure as not-an-admin rather than throwing', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => {
      throw new Error('network unreachable');
    });

    await expect(hasMailboxConsentAdminRoleViaGraph('delegated-token', { fetch: fetchImpl })).resolves.toBe(false);
  });
});
