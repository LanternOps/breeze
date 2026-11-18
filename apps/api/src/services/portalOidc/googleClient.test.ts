import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// No test here reaches Google: the id_token key is a local pair passed as
// `verificationKey`, and the token endpoint is an injected `fetch`.

import {
  PORTAL_GOOGLE_AUTHORIZE_URL,
  PORTAL_GOOGLE_JWKS_URL,
  PORTAL_GOOGLE_SIGN_IN_SCOPE,
  PORTAL_GOOGLE_TOKEN_URL,
  PortalGoogleTokenError,
  buildPortalGoogleAuthorizeUrl,
  exchangePortalGoogleCode,
  verifyPortalGoogleIdToken,
} from './googleClient';
import type { PortalGoogleConfig } from '../../config/portalGoogle';
import { PORTAL_GOOGLE_ISSUER } from '../portalUserIdentities';

const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const OTHER_CLIENT_ID = '999999999999-zyxwvutsrqponmlk.apps.googleusercontent.com';
const SUB = '109876543210987654321';
const NONCE = 'nonce-value-from-state';

const CFG: PortalGoogleConfig = {
  clientId: CLIENT_ID,
  clientSecret: 'portal-google-secret-value',
  callbackUrl: 'https://breeze.example.com/api/v1/portal/auth/oidc/google/callback',
};

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;

interface MintOptions {
  issuedAt?: number;
  expiresAt?: number;
  alg?: 'RS256' | 'HS256';
  omit?: string[];
}

async function mintToken(claims: Record<string, unknown> = {}, options: MintOptions = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: SUB,
    nonce: NONCE,
    iat: options.issuedAt ?? nowSeconds,
    exp: options.expiresAt ?? nowSeconds + 3600,
    email: 'Pat@Contoso.Example.com',
    email_verified: true,
    hd: 'Contoso.Example.com',
    name: 'Pat Example',
    ...claims,
  };
  for (const key of options.omit ?? []) delete payload[key];
  const alg = options.alg ?? 'RS256';
  const jwt = new SignJWT(payload).setProtectedHeader({ alg, kid: 'test-key' });
  return alg === 'HS256'
    ? jwt.sign(new TextEncoder().encode('a-shared-secret-at-least-32-bytes-long!!'))
    : jwt.sign(keys.privateKey);
}

function verify(token: string, overrides: Partial<{ clientId: string; nonce: string; now: Date }> = {}) {
  return verifyPortalGoogleIdToken(
    token,
    { clientId: CLIENT_ID, nonce: NONCE, ...overrides },
    { verificationKey: keys.publicKey },
  );
}

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { modulusLength: 2048 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Google endpoints and the authorize URL', () => {
  it('pins Google\'s endpoints and the sign-in scope as constants', () => {
    expect(PORTAL_GOOGLE_SIGN_IN_SCOPE).toBe('openid email profile');
    expect(PORTAL_GOOGLE_AUTHORIZE_URL).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(PORTAL_GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
    expect(PORTAL_GOOGLE_JWKS_URL).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('authorize URL: v2 auth endpoint, openid email profile, code, S256, prompt select_account, hd=*, the fixed redirect_uri', () => {
    const url = new URL(buildPortalGoogleAuthorizeUrl(CFG, { state: 'state-value', nonce: 'nonce-value', codeChallenge: 'challenge-value' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: CFG.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: 'state-value',
      nonce: 'nonce-value',
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
      prompt: 'select_account',
      hd: '*',
      access_type: 'online',
    });
    // Every parameter appears exactly once.
    expect([...url.searchParams.keys()].length).toBe(new Set(url.searchParams.keys()).size);
  });

  it('authorize URL refuses a redirect URI that is not the fixed callback path, and empty flow values', () => {
    expect(() => buildPortalGoogleAuthorizeUrl(
      { ...CFG, callbackUrl: 'https://breeze.example.com/api/v1/portal/auth/oidc/entra/callback' },
      { state: 's', nonce: 'n', codeChallenge: 'c' },
    )).toThrow();
    expect(() => buildPortalGoogleAuthorizeUrl(CFG, { state: '', nonce: 'n', codeChallenge: 'c' })).toThrow();
    expect(() => buildPortalGoogleAuthorizeUrl(CFG, { state: 's', nonce: '', codeChallenge: 'c' })).toThrow();
    expect(() => buildPortalGoogleAuthorizeUrl(CFG, { state: 's', nonce: 'n', codeChallenge: '' })).toThrow();
  });

  it('the authorize hd hint is never read back: verify ignores what the request sent', async () => {
    // inv. 2: the request always sends the wildcard hint; the org-deciding
    // domain is the token's own `hd`, and verify takes no hd input at all.
    const url = new URL(buildPortalGoogleAuthorizeUrl(CFG, { state: 's', nonce: NONCE, codeChallenge: 'c' }));
    expect(url.searchParams.get('hd')).toBe('*');

    const identity = await verify(await mintToken({ hd: 'contoso.example.com' }));
    expect(identity.googleHostedDomain).toBe('contoso.example.com');

    // A token echoing the request's wildcard is not a domain and is refused.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(verify(await mintToken({ hd: '*' }))).rejects.toMatchObject({ check: 'hd' });
  });
});

describe('verifyPortalGoogleIdToken', () => {
  it('verify accepts a well-formed Workspace token and returns issuer https://accounts.google.com, subject = sub, hd lowercased', async () => {
    const identity = await verify(await mintToken());
    expect(identity).toEqual({
      provider: 'google',
      issuer: PORTAL_GOOGLE_ISSUER,
      subject: SUB,
      entraTenantId: null,
      upn: null,
      emailClaim: 'pat@contoso.example.com',
      emailDomainOwnerVerified: true,
      name: 'Pat Example',
      googleHostedDomain: 'contoso.example.com',
    });
    expect(PORTAL_GOOGLE_ISSUER).toBe('https://accounts.google.com');
  });

  it('verify accepts iss "accounts.google.com" and stores the normalized issuer', async () => {
    const identity = await verify(await mintToken({ iss: 'accounts.google.com' }));
    expect(identity.issuer).toBe('https://accounts.google.com');
  });

  it('the 10-minute iat bound is exact: 9.5 minutes old is accepted, 10.5 minutes old is refused (injected clock)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await mintToken({}, { issuedAt, expiresAt: issuedAt + 3600 });
    await expect(verify(token, { now: new Date((issuedAt + 570) * 1000) })).resolves.toMatchObject({ subject: SUB });
    await expect(verify(token, { now: new Date((issuedAt + 600) * 1000) })).resolves.toMatchObject({ subject: SUB });
    await expect(verify(token, { now: new Date((issuedAt + 601) * 1000) })).rejects.toMatchObject({ check: 'iat' });
    await expect(verify(token, { now: new Date((issuedAt + 630) * 1000) })).rejects.toMatchObject({ check: 'iat' });
  });

  it('accepts a token without azp, without name, issued 9 minutes ago or 30 s in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    const noAzp = await verify(await mintToken({}, { omit: ['azp', 'name'] }));
    expect(noAzp).toMatchObject({ subject: SUB, name: null });
    await expect(verify(await mintToken({}, { issuedAt: now - 9 * 60 }))).resolves.toMatchObject({ subject: SUB });
    await expect(verify(await mintToken({}, { issuedAt: now + 30 }))).resolves.toMatchObject({ subject: SUB });
  });

  it('accepts an email on another domain than hd (the org comes from hd; D3)', async () => {
    const identity = await verify(await mintToken({ email: 'pat@subsidiary.example.com' }));
    expect(identity).toMatchObject({ emailClaim: 'pat@subsidiary.example.com', googleHostedDomain: 'contoso.example.com' });
  });

  const now = () => Math.floor(Date.now() / 1000);
  const refusals: Array<[string, string, () => Promise<string>]> = [
    ['no hd (personal Gmail)', 'id_token_jwt', () => mintToken({ email: 'pat.person@gmail.com' }, { omit: ['hd'] })],
    ['no hd (consumer account on a company address)', 'id_token_jwt', () => mintToken({ email: 'pat@contoso.example.com' }, { omit: ['hd'] })],
    ['hd empty', 'hd', () => mintToken({ hd: '' })],
    ['hd not a domain', 'hd', () => mintToken({ hd: 'contoso' })],
    ['email_verified false', 'email_verified', () => mintToken({ email_verified: false })],
    ['email_verified "true" (string)', 'email_verified', () => mintToken({ email_verified: 'true' })],
    ['no email', 'id_token_jwt', () => mintToken({}, { omit: ['email'] })],
    ['wrong audience', 'audience', () => mintToken({ aud: OTHER_CLIENT_ID })],
    ['aud is an array containing the client id', 'audience', () => mintToken({ aud: [CLIENT_ID, OTHER_CLIENT_ID] })],
    ['azp for another client', 'azp', () => mintToken({ azp: OTHER_CLIENT_ID })],
    ['issuer https://evil.example.com', 'issuer', () => mintToken({ iss: 'https://evil.example.com' })],
    ['nonce mismatch', 'nonce', () => mintToken({ nonce: 'some-other-nonce' })],
    ['iat older than 10 minutes', 'id_token_jwt', () => mintToken({}, { issuedAt: now() - 12 * 60 })],
    // jose widens maxTokenAge by the clock tolerance (to 660 s); D1's bound is 600 s.
    ['iat 10.5 minutes old (inside jose\'s tolerance, outside D1)', 'iat', () => mintToken({}, { issuedAt: now() - 630 })],
    ['iat more than 60 s in the future', 'id_token_jwt', () => mintToken({}, { issuedAt: now() + 120 })],
    ['iat as a string', 'id_token_jwt', () => mintToken({ iat: String(now()) })],
    ['expired', 'id_token_jwt', () => mintToken({}, { issuedAt: now() - 120, expiresAt: now() - 61 })],
    ['empty sub', 'sub', () => mintToken({ sub: '' })],
    ['sub longer than 255 characters', 'sub', () => mintToken({ sub: '1'.repeat(256) })],
    ['HS256 algorithm', 'id_token_jwt', () => mintToken({}, { alg: 'HS256' })],
  ];

  it.each(refusals)('verify refuses: %s', async (_label, check, token) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = await verify(await token()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalGoogleTokenError);
    expect((error as PortalGoogleTokenError).check).toBe(check);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ check }));
  });

  it.each([
    ['sub with a non-ASCII character', { sub: '1098765432é' }],
    ['sub with a control character', { sub: '10987\n65432' }],
    ['sub that is a number', { sub: 109876543210 }],
    ['hd with a trailing space', { hd: 'contoso.example.com ' }],
    ['hd as a URL', { hd: 'https://contoso.example.com' }],
    ['hd not a string', { hd: ['contoso.example.com'] }],
    ['email without @', { email: 'pat' }],
    ['email_verified 1', { email_verified: 1 }],
    ['azp empty', { azp: '' }],
    ['aud array with only the client id', { aud: [CLIENT_ID] }],
  ])('verify also refuses: %s', async (_label, claims) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(verify(await mintToken(claims))).rejects.toBeInstanceOf(PortalGoogleTokenError);
  });

  it('the refusals above are refusals of a token that is otherwise valid', async () => {
    // Guards every row against passing for an unrelated reason: the baseline mint verifies.
    await expect(verify(await mintToken())).resolves.toMatchObject({ subject: SUB });
  });

  it('sub is kept exactly as issued (case-sensitive, not assumed numeric)', async () => {
    const sub = 'AbC-xyz_09.~Q';
    const identity = await verify(await mintToken({ sub }));
    expect(identity.subject).toBe(sub);
    // The 255-character edge is accepted.
    await expect(verify(await mintToken({ sub: 'A'.repeat(255) }))).resolves.toMatchObject({ subject: 'A'.repeat(255) });
  });

  it('verify refuses a token signed by a key other than Google\'s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const attacker = await generateKeyPair('RS256', { modulusLength: 2048 });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: SUB, nonce: NONCE, iat: nowSeconds, exp: nowSeconds + 600,
      email: 'pat@contoso.example.com', email_verified: true, hd: 'contoso.example.com',
    }).setProtectedHeader({ alg: 'RS256' }).sign(attacker.privateKey);
    await expect(verify(forged)).rejects.toMatchObject({ check: 'id_token_jwt' });
  });

  it('checks freshness against the injected clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken();
    await expect(verify(token, { now: new Date(Date.now() + 11 * 60 * 1000 + 5_000) })).rejects.toBeInstanceOf(PortalGoogleTokenError);
  });

  it('refuses when the expected client id or nonce is empty (a caller bug fails closed)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken();
    await expect(verify(token, { nonce: '' })).rejects.toMatchObject({ check: 'nonce' });
    await expect(verify(token, { clientId: '' })).rejects.toBeInstanceOf(PortalGoogleTokenError);
  });

  it('a non-jose failure still fails closed as jwks_unavailable and logs its name and code, not its message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken();
    const thrown = await verifyPortalGoogleIdToken(token, { clientId: CLIENT_ID, nonce: NONCE }, { verificationKey: {} as CryptoKey })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(PortalGoogleTokenError);
    expect((thrown as PortalGoogleTokenError).check).toBe('jwks_unavailable');
    expect(warn.mock.calls.at(-1)![1]).toMatchObject({ check: 'jwks_unavailable', errorName: 'TypeError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  it('never puts token content in the error or the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await mintToken({ nonce: 'secret-nonce-leak', email: 'leak-address@contoso.example.com' });
    const error = await verify(token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalGoogleTokenError);
    expect((error as PortalGoogleTokenError).check).toBe('nonce');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret-nonce-leak');
    expect(logged).not.toContain('leak-address');
    expect(logged).not.toContain(token);
    expect((error as Error).message).not.toContain('secret-nonce-leak');
  });
});

describe('exchangePortalGoogleCode', () => {
  function tokenEndpoint(response: Response) {
    return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);
  }

  it('posts the code, verifier, secret and fixed redirect URI to Google\'s token endpoint, form-encoded', async () => {
    const fetch = tokenEndpoint(new Response(JSON.stringify({ id_token: 'id.jwt.here', access_token: 'unused' }), { status: 200 }));
    const result = await exchangePortalGoogleCode(CFG, { code: 'auth-code', codeVerifier: 'verifier' }, { fetch });
    expect(result).toEqual({ idToken: 'id.jwt.here' });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      client_id: CLIENT_ID,
      client_secret: CFG.clientSecret,
      redirect_uri: CFG.callbackUrl,
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: 'verifier',
    });
  });

  it('token endpoint 400 throws PortalGoogleTokenError without logging the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'leaked-body-detail auth-code' });
    const fetch = tokenEndpoint(new Response(body, { status: 400 }));

    const thrown = await exchangePortalGoogleCode(CFG, { code: 'auth-code', codeVerifier: 'v' }, { fetch }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(PortalGoogleTokenError);
    expect((thrown as PortalGoogleTokenError).check).toBe('token_endpoint');

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('400');
    expect(logged).not.toContain('leaked-body-detail');
    expect(logged).not.toContain('auth-code');
    expect(logged).not.toContain(CFG.clientSecret);
  });

  it('a non-2xx token response has its unread body cancelled, so the connection is released', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() { /* never yields: only a cancel ends it */ }, cancel });
    const fetch = tokenEndpoint(new Response(stream, { status: 502 }));
    await expect(exchangePortalGoogleCode(CFG, { code: 'c', codeVerifier: 'v' }, { fetch }))
      .rejects.toMatchObject({ check: 'token_endpoint' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a token response without id_token throws PortalGoogleTokenError', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = tokenEndpoint(new Response(JSON.stringify({ access_token: 'a', token_type: 'Bearer' }), { status: 200 }));
    const thrown = await exchangePortalGoogleCode(CFG, { code: 'c', codeVerifier: 'v' }, { fetch }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(PortalGoogleTokenError);
    expect((thrown as PortalGoogleTokenError).check).toBe('token_endpoint');
  });

  it.each([
    ['a non-JSON body', new Response('<html>oops</html>', { status: 200 })],
    ['an empty id_token', new Response(JSON.stringify({ id_token: '' }), { status: 200 })],
    ['a non-string id_token', new Response(JSON.stringify({ id_token: 42 }), { status: 200 })],
    ['a JSON array', new Response('[]', { status: 200 })],
    ['a 500', new Response('{}', { status: 500 })],
  ])('throws token_endpoint on %s', async (_label, response) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(exchangePortalGoogleCode(CFG, { code: 'c', codeVerifier: 'v' }, { fetch: tokenEndpoint(response) }))
      .rejects.toMatchObject({ check: 'token_endpoint' });
  });

  it('logs the underlying error name and code when the request fails, never the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = vi.fn(async () => { throw Object.assign(new TypeError('secret-message-detail'), { code: 'ECONNRESET' }); });
    await expect(exchangePortalGoogleCode(CFG, { code: 'c', codeVerifier: 'v' }, { fetch: failing }))
      .rejects.toMatchObject({ check: 'token_endpoint' });
    expect(warn.mock.calls.at(-1)![1]).toMatchObject({ check: 'token_endpoint', errorName: 'TypeError', errorCode: 'ECONNRESET' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-message-detail');
  });

  it('refuses an empty code or verifier before any request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unused = vi.fn();
    await expect(exchangePortalGoogleCode(CFG, { code: '', codeVerifier: 'v' }, { fetch: unused })).rejects.toBeInstanceOf(PortalGoogleTokenError);
    await expect(exchangePortalGoogleCode(CFG, { code: 'c', codeVerifier: '' }, { fetch: unused })).rejects.toBeInstanceOf(PortalGoogleTokenError);
    expect(unused).not.toHaveBeenCalled();
  });
});
