/**
 * Sign-in calls to the identity provider end 30 s after they start, in total.
 *
 * The provider answers with headers at once and then trickles the body, one
 * byte every 20 ms, so the 10 s inactivity timeout never fires. Without an
 * explicit deadline such a call ran until safeFetch's default body allowance
 * (60 s plus the transfer time, from the headers). The token, userinfo and
 * discovery calls now pass `deadlineMs: OIDC_FETCH_DEADLINE_MS`.
 *
 * The JWKS fetch is bounded by jose itself: it passes `AbortSignal.timeout(5000)`
 * to the injected fetch, which safeFetch honours for the whole call. That
 * timer is not a global timer, so that test runs in real time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverOIDCConfig,
  exchangeCodeForTokens,
  getUserInfo,
  refreshAccessToken,
  verifyIdTokenSignature,
  _resetIdTokenJwksCacheForTests,
  OIDC_FETCH_DEADLINE_MS,
  type OIDCConfig,
} from './sso';
import { ResponseDeadlineError, __setLookupForTests } from './urlSafety';
import {
  dialLocally,
  expectSettlesAt,
  resolveTo,
  slowPeer,
  track,
  until,
  useFakeClock,
  type SlowPeer,
} from '../__tests__/helpers/slowHttpPeer';

const T = 30_000; // per-test budget: the fake clock does the timing

let peer: SlowPeer | undefined;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // A self-hosted IdP on a private address over http: the policy allows it, and
  // the dial is redirected to the local peer.
  resolveTo('10.0.0.5');
});

afterEach(() => {
  vi.useRealTimers();
  __setLookupForTests(null);
  vi.restoreAllMocks();
  peer?.close();
  peer = undefined;
  _resetIdTokenJwksCacheForTests();
});

function configFor(port: number): OIDCConfig {
  const base = `http://idp.internal.test:${port}`;
  return {
    issuer: base,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    authorizationUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    userInfoUrl: `${base}/userinfo`,
    jwksUrl: `${base}/jwks`,
    scopes: 'openid profile email',
    allowPrivateNetwork: true,
  };
}

const CALLS: Array<{ name: string; run: (port: number) => Promise<unknown> }> = [
  {
    name: 'token exchange',
    run: (port) => exchangeCodeForTokens({ config: configFor(port), code: 'code', redirectUri: 'https://app.test/cb' }),
  },
  { name: 'userinfo', run: (port) => getUserInfo(configFor(port), 'access-token') },
  { name: 'token refresh', run: (port) => refreshAccessToken(configFor(port), 'refresh-token') },
  {
    name: 'discovery',
    run: (port) => discoverOIDCConfig(`http://idp.internal.test:${port}`, { allowPrivateNetwork: true }),
  },
];

describe('sign-in provider calls end at the 30 s total deadline', () => {
  it('the deadline is 30 s', () => {
    expect(OIDC_FETCH_DEADLINE_MS).toBe(30_000);
  });

  it.each(CALLS)('$name: a body that keeps trickling ends at 30 s with ResponseDeadlineError', async ({ run }) => {
    peer = await slowPeer();
    const client = dialLocally();
    const { clockTo } = useFakeClock();
    const t = track(run(peer.port));
    await until(() => client.headers() === 1, 'the response headers');

    await expectSettlesAt(clockTo, t, 30_000);
    expect(t.value).toBeUndefined();
    expect(t.error).toBeInstanceOf(ResponseDeadlineError);
    expect((t.error as Error).message).toBe('request did not complete within 30000ms');
  }, T);
});

describe('sign-in provider calls that answer normally are unaffected', () => {
  const discoveryDoc = (port: number) => {
    const base = `http://idp.internal.test:${port}`;
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      userinfo_endpoint: `${base}/userinfo`,
      jwks_uri: `${base}/jwks`,
    };
  };

  it('token exchange returns the tokens', async () => {
    peer = await slowPeer({ body: { access_token: 'a', token_type: 'Bearer', expires_in: 3600, id_token: 'h.p.s' } });
    dialLocally();
    await expect(
      exchangeCodeForTokens({ config: configFor(peer.port), code: 'code', redirectUri: 'https://app.test/cb' }),
    ).resolves.toMatchObject({ access_token: 'a', id_token: 'h.p.s' });
  }, T);

  it('userinfo returns the claims', async () => {
    peer = await slowPeer({ body: { sub: 'user-1', email: 'u@example.test' } });
    dialLocally();
    await expect(getUserInfo(configFor(peer.port), 'access-token')).resolves.toEqual({
      sub: 'user-1',
      email: 'u@example.test',
    });
  }, T);

  it('token refresh returns the tokens', async () => {
    peer = await slowPeer({ body: { access_token: 'b', token_type: 'Bearer', expires_in: 3600 } });
    dialLocally();
    await expect(refreshAccessToken(configFor(peer.port), 'refresh-token')).resolves.toMatchObject({
      access_token: 'b',
    });
  }, T);

  it('discovery returns the document', async () => {
    peer = await slowPeer({ body: discoveryDoc });
    dialLocally();
    await expect(
      discoverOIDCConfig(`http://idp.internal.test:${peer.port}`, { allowPrivateNetwork: true }),
    ).resolves.toMatchObject({ token_endpoint: `http://idp.internal.test:${peer.port}/token` });
  }, T);
});

describe('the JWKS fetch is bounded by jose at 5 s', () => {
  it('a JWKS body that keeps trickling fails the verification after about 5 s (real time)', async () => {
    peer = await slowPeer();
    const client = dialLocally();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const idToken = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ sub: 'user-1' })}.c2ln`;

    const started = performance.now();
    const t = track(verifyIdTokenSignature(idToken, configFor(peer.port), 'nonce'));
    await until(() => client.headers() === 1, 'the JWKS response headers');
    await until(() => t.settled, 'the verification to fail', 25_000);
    const elapsed = performance.now() - started;

    expect(t.value).toBeUndefined();
    expect((t.error as { failureKind?: string }).failureKind).toBe('jwks');
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(15_000);
  }, T);
});
