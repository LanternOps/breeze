import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

import { integrationRoutes } from './integrations';

describe('integration compatibility routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/integrations', integrationRoutes);
  });

  it('stores and returns communication settings via slack endpoint', async () => {
    const initial = await app.request('/integrations/communication', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(initial.status).toBe(404);

    const save = await app.request('/integrations/slack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ enabled: true, workspaceName: 'Acme' })
    });
    expect(save.status).toBe(200);

    const loaded = await app.request('/integrations/communication', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(loaded.status).toBe(200);
    const payload = await loaded.json();
    expect(payload.data.slack.enabled).toBe(true);
  });

  it('supports monitoring settings read/write and test', async () => {
    const save = await app.request('/integrations/monitoring', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ metrics: { enabled: true } })
    });
    expect(save.status).toBe(200);

    const get = await app.request('/integrations/monitoring', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(get.status).toBe(200);
    const loaded = await get.json();
    expect(loaded.data.metrics.enabled).toBe(true);

    const test = await app.request('/integrations/monitoring/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ provider: 'grafana' })
    });
    expect(test.status).toBe(200);
  });

  it('supports ticketing read/write and test', async () => {
    const initial = await app.request('/integrations/ticketing', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(initial.status).toBe(200);

    const save = await app.request('/integrations/ticketing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ provider: 'zendesk' })
    });
    expect(save.status).toBe(200);

    const test = await app.request('/integrations/ticketing/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ provider: 'zendesk', test: true })
    });
    expect(test.status).toBe(200);
  });

  it('supports psa read/write/test compatibility', async () => {
    const initial = await app.request('/integrations/psa', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(initial.status).toBe(404);

    const save = await app.request('/integrations/psa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ provider: 'connectwise', settings: { baseUrl: 'https://example.com' } })
    });
    expect(save.status).toBe(200);

    const get = await app.request('/integrations/psa', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(get.status).toBe(200);

    const test = await app.request('/integrations/psa/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ provider: 'connectwise' })
    });
    expect(test.status).toBe(200);
  });
});
