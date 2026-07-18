import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../config/env', () => ({ MCP_OAUTH_ENABLED: false }));
vi.mock('../middleware/auth', () => ({ authMiddleware: vi.fn() }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../db/schema', () => ({
  oauthClients: {},
  oauthClientPartnerGrants: {},
}));
vi.mock('../oauth/revocationService', () => ({ revokeClientFamilies: vi.fn() }));
vi.mock('../oauth/log', () => ({
  ERROR_IDS: {},
  logOauthError: vi.fn(),
}));

import { connectedAppsRoutes } from './connectedApps';

describe('connectedAppsRoutes when MCP OAuth is disabled', () => {
  it('does not mount routes', async () => {
    const app = new Hono().route('/api/v1/settings/connected-apps', connectedAppsRoutes);
    const res = await app.request('/api/v1/settings/connected-apps');

    expect(res.status).toBe(404);
  });
});
