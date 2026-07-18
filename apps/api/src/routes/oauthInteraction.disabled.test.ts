import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return {
    ...actual,
    MCP_OAUTH_ENABLED: false,
    OAUTH_ISSUER: 'https://api.example',
    OAUTH_RESOURCE_URL: 'https://api.example/mcp/server',
    BILLING_URL: '',
  };
});

vi.mock('../oauth/provider', () => ({ getProvider: vi.fn() }));
vi.mock('../oauth/adapter', () => ({ setGrantBreezeMeta: vi.fn() }));
vi.mock('../oauth/effectiveScopes', () => ({ computeEffectiveMcpScopes: vi.fn() }));
vi.mock('../oauth/log', () => ({
  ERROR_IDS: {},
  logOauthError: vi.fn(),
  logOauthDebug: vi.fn(),
  logOAuthEvent: vi.fn(),
}));
vi.mock('../middleware/auth', () => ({ authMiddleware: vi.fn() }));
vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));
vi.mock('../db/schema', () => ({
  oauthClients: {},
  oauthClientPartnerGrants: {},
  partners: {},
  partnerUsers: {},
  users: {},
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { oauthInteractionRoutes } from './oauthInteraction';

describe('oauthInteractionRoutes when MCP OAuth is disabled', () => {
  it('does not mount interaction routes', async () => {
    const app = new Hono().route('/api/v1/oauth', oauthInteractionRoutes);
    const res = await app.request('/api/v1/oauth/interaction/uid-1');

    expect(res.status).toBe(404);
  });
});
