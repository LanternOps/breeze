/**
 * #9938: an authorization request oidc-provider must NOT send back to the
 * client (unknown/refused client_id, unregistered redirect_uri — RFC 6749
 * §4.1.2.1) used to land on the library's unbranded "oops! something went
 * wrong" page. It now goes to the web app's branded /oauth/consent/error page, which
 * names the problem from a fixed reason list and never echoes request params.
 *
 * The provider-level cases run a REAL oidc-provider (memory adapter, one static
 * client) so an upgrade that stops calling `renderError`, or starts calling it
 * for a redirectable valid-client error, fails here.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { Provider, errors } from 'oidc-provider';

vi.mock('../services/connectionHealth/oauthRetryCounter', () => ({ recordRefreshRetry: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: vi.fn(() => { throw new Error('unexpected db access'); }) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn(async () => {}),
  getActivePartner: vi.fn(async () => null),
  getActiveOrgTenant: vi.fn(async () => null),
}));
vi.mock('../services/redis', () => ({ getRedis: () => null }));

import { OAUTH_ERROR_PAGE_REASONS } from '@breeze/shared';
import { buildOauthErrorPageUrl, oauthErrorPageReason } from './errorPage';
import { buildOidcProviderConfiguration } from './provider';

const CONSENT_BASE = 'https://app.example';
const CLIENT_ID = 'known-client';
const REDIRECT_URI = 'http://127.0.0.1:3000/cb';

describe('oauthErrorPageReason', () => {
  it.each([
    [new errors.InvalidClient('client is invalid'), 'invalid_client'],
    [new errors.InvalidClient('client is not allowed'), 'invalid_client'],
    [new errors.InvalidRedirectUri(), 'invalid_redirect_uri'],
    [new errors.SessionNotFound('interaction session id cookie not found'), 'session_expired'],
    [new errors.InvalidRequest('missing required parameter'), 'invalid_request'],
    [new errors.InvalidScope('bad scope', 'nope'), 'invalid_request'],
    [new errors.InvalidTarget(), 'invalid_request'],
    [new errors.UnsupportedResponseType(), 'invalid_request'],
    [new errors.UnauthorizedClient(), 'invalid_request'],
    [new Error('boom'), 'server_error'],
  ] as const)('maps %s to %s', (err, reason) => {
    const out = { error: (err as { error?: string }).error ?? 'server_error' };
    expect(oauthErrorPageReason(out, err)).toBe(reason);
  });

  it('returns null for a code the page has no specific copy for', () => {
    expect(oauthErrorPageReason({ error: 'access_denied' }, new errors.AccessDenied())).toBeNull();
    expect(oauthErrorPageReason({}, undefined)).toBeNull();
  });

  it('only ever returns a reason the web page knows', () => {
    const known = new Set<string>(OAUTH_ERROR_PAGE_REASONS);
    for (const code of ['invalid_client', 'invalid_redirect_uri', 'invalid_request', 'server_error', 'temporarily_unavailable']) {
      const reason = oauthErrorPageReason({ error: code }, undefined);
      expect(reason === null || known.has(reason)).toBe(true);
    }
  });
});

describe('buildOauthErrorPageUrl', () => {
  it('points at the web app error page with only the reason', () => {
    expect(buildOauthErrorPageUrl(CONSENT_BASE, 'invalid_client')).toBe('https://app.example/oauth/consent/error?reason=invalid_client');
  });

  it('drops the query when there is no reason', () => {
    expect(buildOauthErrorPageUrl(CONSENT_BASE, null)).toBe('https://app.example/oauth/consent/error');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(buildOauthErrorPageUrl('https://app.example/', 'server_error')).toBe('https://app.example/oauth/consent/error?reason=server_error');
  });

  it('stays on the same origin when no base is configured', () => {
    expect(buildOauthErrorPageUrl('', 'invalid_client')).toBe('/oauth/consent/error?reason=invalid_client');
  });
});

describe('authorization endpoint errors against a real provider', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const jwk = { ...(await exportJWK(privateKey)), kid: 'test', alg: 'EdDSA', use: 'sig' };
    const { adapter: _breezeAdapter, ...config } = buildOidcProviderConfiguration({ keys: [jwk] } as never, {
      cimdEnabled: false,
      consentUrlBase: CONSENT_BASE,
    });
    const provider = new Provider('https://issuer.example', {
      ...config,
      clients: [{
        client_id: CLIENT_ID,
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }],
    });
    server = createServer(provider.callback());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function authorize(params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${origin}/oauth/auth?${qs}`, { redirect: 'manual', headers: { accept: 'text/html' } });
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  }

  it('an unknown client_id goes to the branded page, not the oidc-provider default', async () => {
    const res = await authorize({
      client_id: 'no-such-client',
      response_type: 'code',
      redirect_uri: 'https://attacker.example/cb',
      scope: 'openid',
      state: '<script>alert(1)</script>',
    });
    expect(res.status).toBe(303);
    expect(res.location).toBe(`${CONSENT_BASE}/oauth/consent/error?reason=invalid_client`);
    expect(res.body).not.toContain('oops! something went wrong');
    // Nothing from the request is reflected: not the client_id, the state or
    // the redirect_uri it asked for.
    for (const echoed of ['no-such-client', 'attacker.example', 'script']) {
      expect(res.location).not.toContain(echoed);
      expect(res.body).not.toContain(echoed);
    }
  });

  it('a known client with an unregistered redirect_uri is not sent to that uri', async () => {
    const res = await authorize({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: 'https://attacker.example/cb',
      scope: 'openid',
      state: 'abc',
    });
    expect(res.status).toBe(303);
    expect(res.location).toBe(`${CONSENT_BASE}/oauth/consent/error?reason=invalid_redirect_uri`);
  });

  it('a request with no client_id names the request as the problem', async () => {
    const res = await authorize({ response_type: 'code', scope: 'openid' });
    expect(res.status).toBe(303);
    expect(res.location).toBe(`${CONSENT_BASE}/oauth/consent/error?reason=invalid_request`);
  });

  it('a request for the error page itself that reaches the API does not redirect to itself', async () => {
    // A proxy that sends /oauth/consent/* to the API instead of web must not
    // loop (renderError -> 303 to the same path). oidc-provider answers an
    // unknown route with a plain 404 and never calls renderError for it.
    const res = await fetch(`${origin}/oauth/consent/error?reason=invalid_client`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('a redirectable error for a valid client still goes back to the client', async () => {
    // PKCE is required, so a request without code_challenge is refused — but
    // client and redirect_uri are valid, so the error belongs to the client.
    const res = await authorize({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'abc',
    });
    expect([302, 303]).toContain(res.status);
    const location = new URL(res.location ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('abc');
  });
});
