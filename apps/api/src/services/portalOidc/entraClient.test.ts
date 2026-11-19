import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PORTAL_ENTRA_PROOF_SCOPE,
  PORTAL_ENTRA_SIGN_IN_SCOPE,
  PortalEntraTokenError,
  buildPortalAppAdminConsentUrl,
  buildPortalEntraAuthorizeUrl,
  exchangePortalEntraCode,
  verifyPortalEntraIdToken,
} from './entraClient';
import type { PortalEntraConfig } from '../../config/portalEntra';
import type { ClientAiEntraClaims } from '../clientAiEntraJwt';
import { entraIssuer } from '../portalUserIdentities';

const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER_TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const CLIENT_ID = '99999999-8888-4777-8666-555555555555';
const OBJECT_ID = '12345678-1234-4234-8234-123456789abc';
const NONCE = 'nonce-value-from-state';

const CFG: PortalEntraConfig = {
  clientId: CLIENT_ID,
  clientSecret: 'portal-client-secret-value',
  callbackUrl: 'https://breeze.example/api/v1/portal/auth/oidc/entra/callback',
  consentReturnUrl: 'https://breeze.example/api/v1/portal/auth/oidc/entra/consent-return',
};

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;

interface MintOptions {
  audience?: string;
  issuer?: string;
  tenant?: string;
  issuedAt?: number;
  expiresAt?: number;
  alg?: 'RS256' | 'HS256';
  omit?: string[];
}

async function mintToken(claims: Record<string, unknown> = {}, options: MintOptions = {}): Promise<string> {
  const tenant = options.tenant ?? TENANT;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    tid: tenant,
    oid: OBJECT_ID,
    nonce: NONCE,
    ver: '2.0',
    iss: options.issuer ?? `https://login.microsoftonline.com/${tenant}/v2.0`,
    aud: options.audience ?? CLIENT_ID,
    iat: options.issuedAt ?? nowSeconds,
    exp: options.expiresAt ?? nowSeconds + 3600,
    sub: 'pairwise-subject-not-oid',
    preferred_username: 'Alice@Contoso.example',
    name: 'Alice Example',
    ...claims,
  };
  for (const key of options.omit ?? []) delete payload[key];
  const alg = options.alg ?? 'RS256';
  const jwt = new SignJWT(payload).setProtectedHeader({ alg, kid: 'test-key' });
  return alg === 'HS256'
    ? jwt.sign(new TextEncoder().encode('a-shared-secret-at-least-32-bytes-long!!'))
    : jwt.sign(keys.privateKey);
}

function verify(
  token: string,
  overrides: Partial<{ clientId: string; nonce: string; expectedTenantId: string | null; allowGuest: boolean; now: Date }> = {},
) {
  return verifyPortalEntraIdToken(
    token,
    { clientId: CLIENT_ID, nonce: NONCE, expectedTenantId: null, ...overrides },
    { verificationKey: keys.publicKey },
  );
}

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { modulusLength: 2048 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authorize and admin-consent URLs', () => {
  it('authorize URL: organizations authority, openid profile email, S256, response_mode query, prompt select_account', () => {
    const url = new URL(buildPortalEntraAuthorizeUrl(CFG, {
      authority: 'organizations',
      scope: PORTAL_ENTRA_SIGN_IN_SCOPE,
      state: 'state-value',
      nonce: 'nonce-value',
      codeChallenge: 'challenge-value',
    }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: CFG.callbackUrl,
      response_mode: 'query',
      scope: 'openid profile email',
      state: 'state-value',
      nonce: 'nonce-value',
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  });

  it('proof-run authorize URL pins the tenant authority and asks for the proof scope', () => {
    expect(PORTAL_ENTRA_PROOF_SCOPE).toBe('openid profile Directory.Read.All');
    const url = new URL(buildPortalEntraAuthorizeUrl(CFG, {
      authority: TENANT, scope: PORTAL_ENTRA_PROOF_SCOPE, state: 's', nonce: 'n', codeChallenge: 'c',
    }));
    expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('scope')).toBe('openid profile Directory.Read.All');
  });

  it('authorize URL refuses common/consumers/domain authorities', () => {
    for (const authority of ['common', 'consumers', 'contoso.example']) {
      expect(() => buildPortalEntraAuthorizeUrl(CFG, { authority, scope: PORTAL_ENTRA_SIGN_IN_SCOPE, state: 's', nonce: 'n', codeChallenge: 'c' }))
        .toThrow();
    }
  });

  it('admin consent URL is v2 adminconsent for the tenant with scope openid profile email', () => {
    const url = new URL(buildPortalAppAdminConsentUrl(CFG, TENANT));
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0/adminconsent`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      scope: 'openid profile email',
      redirect_uri: CFG.consentReturnUrl,
    });
    expect(() => buildPortalAppAdminConsentUrl(CFG, 'organizations')).toThrow();
    expect(() => buildPortalAppAdminConsentUrl(CFG, 'contoso.example')).toThrow();
  });
});

describe('verifyPortalEntraIdToken', () => {
  it('verify accepts a well-formed token and returns issuer = entraIssuer(tid), subject = oid', async () => {
    const identity = await verify(await mintToken({ email: 'Alice@Mail.Contoso.example', xms_edov: true }));
    expect(identity).toEqual({
      provider: 'entra',
      issuer: entraIssuer(TENANT),
      subject: OBJECT_ID,
      entraTenantId: TENANT,
      upn: 'alice@contoso.example',
      emailClaim: 'alice@mail.contoso.example',
      emailDomainOwnerVerified: true,
      name: 'Alice Example',
    });
    // resolveLinkableEntraAddress reads exactly these ClientAiEntraClaims fields.
    const linkable: Pick<ClientAiEntraClaims, 'upn' | 'emailClaim' | 'emailDomainOwnerVerified' | 'name'> = identity;
    expect(linkable.upn).toBe('alice@contoso.example');
  });

  it('email claim is null when absent and xms_edov counts only as a real boolean true', async () => {
    const noEmail = await verify(await mintToken({ xms_edov: true }));
    expect(noEmail.emailClaim).toBeNull();
    const stringEdov = await verify(await mintToken({ email: 'a@contoso.example', xms_edov: 'true' }));
    expect(stringEdov.emailDomainOwnerVerified).toBe(false);
    const noUpn = await verify(await mintToken({}, { omit: ['preferred_username', 'name'] }));
    expect(noUpn.upn).toBeNull();
    expect(noUpn.name).toBeNull();
  });

  it('accepts a token Entra issued 9 minutes ago and one 30 s in the future (60 s tolerance)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(await mintToken({}, { issuedAt: now - 9 * 60 }))).resolves.toMatchObject({ subject: OBJECT_ID });
    await expect(verify(await mintToken({}, { issuedAt: now + 30 }))).resolves.toMatchObject({ subject: OBJECT_ID });
  });

  const refusals: Array<[string, string, () => Promise<string>]> = [
    ['wrong audience', 'id_token_jwt', () => mintToken({}, { audience: '00000000-0000-4000-8000-000000000000' })],
    ['issuer for another tenant', 'issuer', () => mintToken({}, { issuer: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` })],
    ['nonce mismatch', 'nonce', () => mintToken({ nonce: 'some-other-nonce' })],
    ['iat older than 10 minutes', 'id_token_jwt', () => mintToken({}, { issuedAt: Math.floor(Date.now() / 1000) - 12 * 60 })],
    ['tid is the consumer tenant', 'consumer_tenant', () => mintToken({}, { tenant: CONSUMER_TENANT })],
    ['idp is another tenant (guest)', 'guest_idp', () => mintToken({ idp: `https://sts.windows.net/${OTHER_TENANT}/` })],
    ['acct = 1', 'guest_acct', () => mintToken({ acct: 1 })],
    ['missing oid', 'id_token_jwt', () => mintToken({}, { omit: ['oid'] })],
    ['oid not a GUID', 'oid', () => mintToken({ oid: 'not-a-guid' })],
    ['ver 1.0', 'ver', () => mintToken({ ver: '1.0' })],
    ['HS256 algorithm', 'id_token_jwt', () => mintToken({}, { alg: 'HS256' })],
    ['missing nonce', 'id_token_jwt', () => mintToken({}, { omit: ['nonce'] })],
    ['missing iat', 'id_token_jwt', () => mintToken({}, { omit: ['iat'] })],
    ['expired', 'id_token_jwt', () => mintToken({}, { issuedAt: Math.floor(Date.now() / 1000) - 120, expiresAt: Math.floor(Date.now() / 1000) - 61 })],
    ['tid not a GUID', 'tid', () => mintToken({ tid: 'contoso.example' }, { issuer: 'https://login.microsoftonline.com/contoso.example/v2.0' })],
  ];

  it.each(refusals)('verify refuses: %s', async (_label, check, token) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = await verify(await token()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalEntraTokenError);
    expect((error as PortalEntraTokenError).check).toBe(check);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ check }));
  });

  it('the jose-level refusals are refusals of a token that is otherwise valid', async () => {
    // Guards the id_token_jwt rows above against passing for an unrelated
    // reason: the baseline mint verifies.
    await expect(verify(await mintToken())).resolves.toMatchObject({ subject: OBJECT_ID });
  });

  it('verify refuses a token signed by a key other than Microsoft\'s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const attacker = await generateKeyPair('RS256', { modulusLength: 2048 });
    const forged = await new SignJWT({ tid: TENANT, oid: OBJECT_ID, nonce: NONCE, ver: '2.0' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(entraIssuer(TENANT))
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(attacker.privateKey);
    await expect(verify(forged)).rejects.toBeInstanceOf(PortalEntraTokenError);
  });

  it('verify refuses a tid different from expectedTenantId when one is pinned', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken();
    await expect(verify(token, { expectedTenantId: OTHER_TENANT })).rejects.toMatchObject({ check: 'tenant_mismatch' });
    await expect(verify(token, { expectedTenantId: TENANT.toUpperCase() })).resolves.toMatchObject({ entraTenantId: TENANT });
  });

  it('verify accepts a token with no acct and no idp claim (structural guest rule; documented)', async () => {
    // User sign-in uses the `organizations` authority, so Microsoft issues the
    // token in the user's HOME tenant: a B2B guest token cannot be minted for
    // it. `acct`/`idp` are defence in depth, and their absence is not a refusal.
    await expect(verify(await mintToken({}, { omit: ['acct', 'idp'] }))).resolves.toMatchObject({ subject: OBJECT_ID });
    // A member's idp, when present, equals the issuer or the v1 STS issuer of its own tenant.
    await expect(verify(await mintToken({ idp: entraIssuer(TENANT), acct: 0 }))).resolves.toMatchObject({ subject: OBJECT_ID });
    await expect(verify(await mintToken({ idp: `https://sts.windows.net/${TENANT}/` }))).resolves.toMatchObject({ subject: OBJECT_ID });
  });

  describe('guests in a tenant-proof run (allowGuest, plan Global Constraints "Proof run", D6)', () => {
    // A B2B guest signing in through the PINNED tenant authority: Microsoft
    // issues the token in the resource (customer) tenant, so `tid`/`iss` are
    // the customer's and `idp`/`acct` mark the guest.
    const guestClaims = { idp: `https://sts.windows.net/${OTHER_TENANT}/`, acct: 1 };

    it('accepts a guest of the pinned tenant when allowGuest is set: identity is the resource tenant\'s tid/oid', async () => {
      const identity = await verify(await mintToken(guestClaims), { expectedTenantId: TENANT, allowGuest: true });
      expect(identity).toMatchObject({ issuer: entraIssuer(TENANT), subject: OBJECT_ID, entraTenantId: TENANT });
      // Each guest marker on its own, and the string form of acct.
      await expect(verify(await mintToken({ acct: '1' }), { expectedTenantId: TENANT, allowGuest: true }))
        .resolves.toMatchObject({ entraTenantId: TENANT });
      await expect(verify(await mintToken({ idp: 'https://login.live.com' }), { expectedTenantId: TENANT, allowGuest: true }))
        .resolves.toMatchObject({ entraTenantId: TENANT });
    });

    it('without allowGuest a guest is refused even when the tenant is pinned', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(verify(await mintToken(guestClaims), { expectedTenantId: TENANT })).rejects.toMatchObject({ check: 'guest_idp' });
      await expect(verify(await mintToken({ acct: 1 }), { expectedTenantId: TENANT, allowGuest: false }))
        .rejects.toMatchObject({ check: 'guest_acct' });
    });

    it('allowGuest without a pinned tenant is refused, guest or not (fail closed)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const claims of [guestClaims, {}]) {
        const error = await verify(await mintToken(claims), { expectedTenantId: null, allowGuest: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PortalEntraTokenError);
        expect((error as PortalEntraTokenError).check).toBe('guest_unpinned');
      }
      // A pin that is not a tenant GUID is no pin.
      await expect(verify(await mintToken(guestClaims), { expectedTenantId: 'contoso.example', allowGuest: true }))
        .rejects.toMatchObject({ check: 'guest_unpinned' });
    });

    it('allowGuest skips only the guest checks: a guest token for another tenant than the pin is refused', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const otherTenantGuest = await mintToken(guestClaims, { tenant: OTHER_TENANT });
      await expect(verify(otherTenantGuest, { expectedTenantId: TENANT, allowGuest: true })).rejects.toMatchObject({ check: 'tenant_mismatch' });
    });

    it.each(refusals.filter(([label]) => !['idp is another tenant (guest)', 'acct = 1'].includes(label)))(
      'allowGuest keeps every other check: %s',
      async (_label, check, token) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = await verify(await token(), { expectedTenantId: TENANT, allowGuest: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PortalEntraTokenError);
        expect((error as PortalEntraTokenError).check).toBe(check);
      },
    );
  });

  it('checks freshness against the injected clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken();
    const elevenMinutesLater = new Date(Date.now() + 11 * 60 * 1000 + 5_000);
    await expect(verify(token, { now: elevenMinutesLater })).rejects.toBeInstanceOf(PortalEntraTokenError);
  });

  it('a non-jose failure still fails closed as jwks_unavailable and logs its name and code, not its message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken();
    const thrown = await verifyPortalEntraIdToken(
      token,
      { clientId: CLIENT_ID, nonce: NONCE, expectedTenantId: null },
      { verificationKey: {} as CryptoKey },
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(PortalEntraTokenError);
    expect((thrown as PortalEntraTokenError).check).toBe('jwks_unavailable');
    expect(warn.mock.calls.at(-1)![1]).toMatchObject({ check: 'jwks_unavailable', errorName: 'TypeError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  it('never puts token content in the error or the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken({ nonce: 'secret-nonce-leak' });
    const error = await verify(token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalEntraTokenError);
    expect((error as PortalEntraTokenError).check).toBe('nonce');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret-nonce-leak');
    expect(logged).not.toContain(token);
    expect((error as Error).message).not.toContain('secret-nonce-leak');
  });
});

describe('exchangePortalEntraCode', () => {
  function tokenEndpoint(response: Response) {
    return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);
  }

  it('posts the code, verifier, secret and fixed redirect URI to the authority token endpoint', async () => {
    const fetch = tokenEndpoint(new Response(JSON.stringify({ id_token: 'id.jwt.here', access_token: 'access-token' }), { status: 200 }));
    const result = await exchangePortalEntraCode(CFG, { authority: TENANT, code: 'auth-code', codeVerifier: 'verifier' }, { fetch });
    expect(result).toEqual({ idToken: 'id.jwt.here', accessToken: 'access-token' });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      client_id: CLIENT_ID,
      client_secret: CFG.clientSecret,
      redirect_uri: CFG.callbackUrl,
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: 'verifier',
    });
  });

  it('uses the organizations authority and treats a missing access token as null', async () => {
    const fetch = tokenEndpoint(new Response(JSON.stringify({ id_token: 'id.jwt.here' }), { status: 200 }));
    const result = await exchangePortalEntraCode(CFG, { authority: 'organizations', code: 'c', codeVerifier: 'v' }, { fetch });
    expect(result).toEqual({ idToken: 'id.jwt.here', accessToken: null });
    expect(String(fetch.mock.calls[0]![0])).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
  });

  it('token endpoint 400 throws PortalEntraTokenError without logging the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70008 leaked-body-detail auth-code' });
    const fetch = tokenEndpoint(new Response(body, { status: 400 }));

    const thrown = await exchangePortalEntraCode(CFG, { authority: TENANT, code: 'auth-code', codeVerifier: 'v' }, { fetch })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(PortalEntraTokenError);
    expect((thrown as PortalEntraTokenError).check).toBe('token_endpoint');

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('400');
    expect(logged).not.toContain('leaked-body-detail');
    expect(logged).not.toContain('auth-code');
    expect(logged).not.toContain(CFG.clientSecret);
  });

  it.each([
    ['a non-JSON body', new Response('<html>oops</html>', { status: 200 })],
    ['a body without id_token', new Response(JSON.stringify({ access_token: 'a' }), { status: 200 })],
    ['an empty id_token', new Response(JSON.stringify({ id_token: '' }), { status: 200 })],
    ['a JSON array', new Response('[]', { status: 200 })],
    ['a 500', new Response('{}', { status: 500 })],
  ])('throws token_endpoint on %s', async (_label, response) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(exchangePortalEntraCode(CFG, { authority: TENANT, code: 'c', codeVerifier: 'v' }, { fetch: tokenEndpoint(response) }))
      .rejects.toMatchObject({ check: 'token_endpoint' });
  });

  it('logs the underlying error name and code when the request fails or the body will not parse, never the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = vi.fn(async () => { throw Object.assign(new TypeError('secret-message-detail'), { code: 'ECONNRESET' }); });
    await expect(exchangePortalEntraCode(CFG, { authority: TENANT, code: 'c', codeVerifier: 'v' }, { fetch: failing }))
      .rejects.toMatchObject({ check: 'token_endpoint' });
    expect(warn.mock.calls.at(-1)![1]).toMatchObject({ check: 'token_endpoint', errorName: 'TypeError', errorCode: 'ECONNRESET' });

    await expect(exchangePortalEntraCode(CFG, { authority: TENANT, code: 'c', codeVerifier: 'v' }, { fetch: tokenEndpoint(new Response('<html>', { status: 200 })) }))
      .rejects.toMatchObject({ check: 'token_endpoint' });
    expect(warn.mock.calls.at(-1)![1]).toMatchObject({ check: 'token_endpoint', status: 200, errorName: 'SyntaxError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-message-detail');
  });

  it('throws token_endpoint when the request itself fails, and refuses a bad authority before any request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = vi.fn(async () => { throw new TypeError('network down'); });
    await expect(exchangePortalEntraCode(CFG, { authority: TENANT, code: 'c', codeVerifier: 'v' }, { fetch: failing }))
      .rejects.toMatchObject({ check: 'token_endpoint' });

    const unused = vi.fn();
    await expect(exchangePortalEntraCode(CFG, { authority: 'common', code: 'c', codeVerifier: 'v' }, { fetch: unused }))
      .rejects.toBeInstanceOf(PortalEntraTokenError);
    expect(unused).not.toHaveBeenCalled();
  });
});
