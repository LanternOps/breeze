import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  rateLimiter: vi.fn(),
  getRedis: vi.fn(() => null),
}));

vi.mock('../config/env', () => ({
  MCP_OAUTH_ENABLED: true,
  OAUTH_DCR_ENABLED: false,
  OAUTH_ISSUER: 'https://region.example',
  OAUTH_RESOURCE_URL: 'https://region.example/api/v1/mcp',
}));

vi.mock('../oauth/provider', () => ({ getProvider: mocks.getProvider }));
vi.mock('../services/redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));

import { oauthRoutes } from './oauth';

function loadApp() {
  return new Hono().route('/oauth', oauthRoutes);
}

beforeEach(() => {
  mocks.getProvider.mockReset();
  mocks.getProvider.mockRejectedValue(new Error('bridge sentinel'));
  mocks.rateLimiter.mockReset();
  mocks.rateLimiter.mockResolvedValue({
    allowed: true,
    remaining: 1,
    resetAt: new Date('2026-04-23T00:00:00.000Z'),
  });
});

describe('oauthRoutes', () => {
  it('mounts a catch-all when MCP_OAUTH_ENABLED is true (provider call deferred)', async () => {
    const app = loadApp();
    expect(mocks.getProvider).not.toHaveBeenCalled();

    const res = await app.request('/oauth/anything', { method: 'GET' });

    expect(res.status).toBe(500);
    expect(mocks.getProvider).toHaveBeenCalledTimes(1);
  });
});

describe('oauthRoutes — resource-indicator alias normalization (#2363)', () => {
  const RESOURCE = 'https://region.example/api/v1/mcp';

  /** Fake Node IncomingMessage: a real Readable plus headers/url. */
  const fakeIncoming = (opts: { body?: string; url?: string }) => {
    const stream = (opts.body !== undefined
      ? Readable.from([Buffer.from(opts.body, 'utf8')])
      : Readable.from([])) as unknown as NodeJS.ReadableStream & {
      headers: Record<string, string>;
      url?: string;
      rawBody?: Buffer;
      body?: Buffer;
    };
    stream.headers = opts.body !== undefined
      ? { 'content-length': String(Buffer.byteLength(opts.body, 'utf8')) }
      : {};
    if (opts.url !== undefined) stream.url = opts.url;
    return stream;
  };

  it('rewrites an /sse-alias resource in the token body to the canonical resource before the bridge', async () => {
    const app = loadApp();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-1',
      resource: `${RESOURCE}/sse`,
    }).toString();
    const incoming = fakeIncoming({ body });

    const res = await app.request(
      '/oauth/token',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { incoming },
    );

    // Bridge sentinel → 500; the pre-handler already ran and rewrote the
    // buffered body the bridge would replay.
    expect(res.status).toBe(500);
    expect(incoming.rawBody).toBeDefined();
    const replayed = new URLSearchParams(incoming.rawBody!.toString('utf8'));
    expect(replayed.get('resource')).toBe(RESOURCE);
    expect(replayed.get('refresh_token')).toBe('rt-1');
    expect(incoming.body!.toString('utf8')).toBe(incoming.rawBody!.toString('utf8'));
    expect(incoming.headers['content-length']).toBe(String(incoming.rawBody!.byteLength));
  });

  it('leaves an unrelated resource untouched in the token body (still fails invalid_target downstream)', async () => {
    const app = loadApp();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-1',
      resource: 'https://evil.example/api/v1/mcp',
    }).toString();
    const incoming = fakeIncoming({ body });

    await app.request(
      '/oauth/token',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { incoming },
    );

    expect(incoming.rawBody!.toString('utf8')).toBe(body);
    const replayed = new URLSearchParams(incoming.rawBody!.toString('utf8'));
    expect(replayed.get('resource')).toBe('https://evil.example/api/v1/mcp');
  });

  it('rewrites an alias resource in the authorization request query before the bridge reads incoming.url', async () => {
    const app = loadApp();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'client-1',
      scope: 'openid offline_access mcp:read',
      resource: `${RESOURCE}/sse`,
    }).toString();
    const incoming = fakeIncoming({ url: `/oauth/auth?${query}` });

    const res = await app.request(`/oauth/auth?${query}`, { method: 'GET' }, { incoming });

    expect(res.status).toBe(500); // bridge sentinel
    const rewritten = new URLSearchParams(incoming.url!.split('?')[1]);
    expect(rewritten.get('resource')).toBe(RESOURCE);
    expect(rewritten.get('scope')).toBe('openid offline_access mcp:read');
    expect(incoming.url!.startsWith('/oauth/auth?')).toBe(true);
  });

  it('does not touch the authorization URL when the resource is already canonical', async () => {
    const app = loadApp();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'client-1',
      resource: RESOURCE,
    }).toString();
    const url = `/oauth/auth?${query}`;
    const incoming = fakeIncoming({ url });

    await app.request(url, { method: 'GET' }, { incoming });

    expect(incoming.url).toBe(url);
  });
});
