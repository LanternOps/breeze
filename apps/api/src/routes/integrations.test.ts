import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
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
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
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

  it('never echoes Discord or Teams credentials from compatibility storage', async () => {
    const discordSecret = 'https://discord.example.test/api/webhooks/id/private-token';
    const discordSave = await app.request('/integrations/discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ enabled: true, webhookUrl: discordSecret })
    });
    expect(discordSave.status).toBe(200);
    const discordPayload = await discordSave.json();
    expect(JSON.stringify(discordPayload)).not.toContain(discordSecret);
    expect(discordPayload.data.discord.webhookUrl).toBe('********');

    const teamsSecret = 'teams-client-secret-value';
    const teamsSave = await app.request('/integrations/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ enabled: true, clientId: 'public-client-id', clientSecret: teamsSecret })
    });
    expect(teamsSave.status).toBe(200);

    const loaded = await app.request('/integrations/communication', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    const loadedText = await loaded.text();
    expect(loadedText).not.toContain(discordSecret);
    expect(loadedText).not.toContain(teamsSecret);
    const loadedPayload = JSON.parse(loadedText);
    expect(loadedPayload.data.discord.webhookUrl).toBe('********');
    expect(loadedPayload.data.teams.clientSecret).toBe('********');
    expect(loadedPayload.data.teams.clientId).toBe('public-client-id');
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

  it('never echoes monitoring provider credentials and preserves non-secret settings', async () => {
    const secrets = {
      grafana: 'grafana-private-api-key',
      pagerDuty: 'pagerduty-private-integration-key',
      opsGenie: 'opsgenie-private-api-key',
      webhook: 'https://hooks.example.test/services/private-token'
    };
    const save = await app.request('/integrations/monitoring', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        grafana: { enabled: true, url: 'https://grafana.example.test', apiKey: secrets.grafana },
        pagerDuty: { enabled: true, integrationKey: secrets.pagerDuty },
        opsGenie: { enabled: true, apiKey: secrets.opsGenie, team: 'platform' },
        webhooks: { endpoints: [{ id: 'one', name: 'relay', url: secrets.webhook, enabled: true }] }
      })
    });
    expect(save.status).toBe(200);
    const saveText = await save.text();
    for (const secret of Object.values(secrets)) expect(saveText).not.toContain(secret);

    const get = await app.request('/integrations/monitoring', {
      headers: { Authorization: 'Bearer token' }
    });
    const getText = await get.text();
    for (const secret of Object.values(secrets)) expect(getText).not.toContain(secret);
    const payload = JSON.parse(getText).data;
    expect(payload.grafana).toEqual({ enabled: true, url: 'https://grafana.example.test', apiKey: '********' });
    expect(payload.pagerDuty.integrationKey).toBe('********');
    expect(payload.opsGenie).toEqual({ enabled: true, apiKey: '********', team: 'platform' });
    expect(payload.webhooks.endpoints[0]).toEqual({ id: 'one', name: 'relay', url: '********', enabled: true });
  });

  it('assigns an id before an id-less webhook is returned and accepts its masked resave', async () => {
    const first = await app.request('/integrations/monitoring', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        webhooks: { endpoints: [{ name: 'legacy', url: 'https://hooks.example.test/legacy' }] }
      })
    });
    expect(first.status).toBe(200);
    const firstEndpoint = (await first.json()).data.webhooks.endpoints[0];
    expect(firstEndpoint).toMatchObject({ name: 'legacy', url: '********' });
    expect(firstEndpoint.id).toEqual(expect.any(String));

    const second = await app.request('/integrations/monitoring', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ webhooks: { endpoints: [firstEndpoint] } })
    });
    expect(second.status).toBe(200);
    expect((await second.json()).data.webhooks.endpoints[0]).toEqual(firstEndpoint);
  });

  it('masks credential-shaped siblings in ticketing compatibility blobs', async () => {
    const ticketPassword = 'ticketing-private-password';
    const ticket = await app.request('/integrations/ticketing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ provider: 'zendesk', credentials: { username: 'agent@example.test', password: ticketPassword } })
    });
    expect(ticket.status).toBe(200);
    const ticketText = await ticket.text();
    expect(ticketText).not.toContain(ticketPassword);
    expect(JSON.parse(ticketText).data.credentials.password).toBe('********');

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

  it('rejects oversized integration payload (>16KB) with 400', async () => {
    const huge = 'x'.repeat(20 * 1024);
    const res = await app.request('/integrations/slack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ workspaceName: 'Acme', blob: huge })
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-object JSON bodies with 400', async () => {
    const res = await app.request('/integrations/slack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(['not', 'an', 'object'])
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON body with 400', async () => {
    const res = await app.request('/integrations/slack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: '{not-json'
    });
    expect(res.status).toBe(400);
  });

  it('supports psa read/write/test compatibility', async () => {
    const psaSecret = 'psa-private-api-secret';
    const initial = await app.request('/integrations/psa', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(initial.status).toBe(404);

    const save = await app.request('/integrations/psa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        provider: 'connectwise',
        apiKey: 'public-id',
        apiSecret: psaSecret,
        settings: { baseUrl: 'https://example.com' }
      })
    });
    expect(save.status).toBe(200);
    const saveText = await save.text();
    expect(saveText).not.toContain(psaSecret);
    expect(JSON.parse(saveText).data.apiSecret).toBe('********');

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
