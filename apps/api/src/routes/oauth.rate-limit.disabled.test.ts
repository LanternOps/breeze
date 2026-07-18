import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getRedis: vi.fn(() => null),
  rateLimiter: vi.fn(),
}));

vi.mock('../config/env', () => ({
  MCP_OAUTH_ENABLED: false,
  OAUTH_DCR_ENABLED: false,
  OAUTH_ISSUER: 'https://test.example',
  OAUTH_RESOURCE_URL: 'https://test.example/mcp/server',
}));
vi.mock('../oauth/provider', () => ({ getProvider: mocks.getProvider }));
vi.mock('../services/redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));

import { oauthRoutes } from './oauth';

describe('oauthRoutes rate limits when MCP OAuth is disabled', () => {
  it('does not mount the OAuth topology or call the rate limiter', async () => {
    const app = new Hono().route('/oauth', oauthRoutes);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.60' },
    });

    expect(res.status).toBe(404);
    expect(mocks.getRedis).not.toHaveBeenCalled();
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });
});
