import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
}));

vi.mock('../config/env', () => ({
  MCP_OAUTH_ENABLED: false,
  OAUTH_DCR_ENABLED: false,
  OAUTH_ISSUER: 'https://api.example',
  OAUTH_RESOURCE_URL: 'https://api.example/api/v1/mcp',
}));
vi.mock('../oauth/provider', () => ({ getProvider: mocks.getProvider }));
vi.mock('../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn() }));

import { oauthRoutes } from './oauth';

describe('oauthRoutes when MCP OAuth is disabled', () => {
  it('does not mount the catch-all or resolve the provider', async () => {
    const app = new Hono().route('/oauth', oauthRoutes);
    const res = await app.request('/oauth/anything', { method: 'GET' });

    expect(res.status).toBe(404);
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });
});
