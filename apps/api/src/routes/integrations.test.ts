import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const safeFetchMock = vi.fn();
vi.mock('../services/urlSafety', () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
}));

import { integrationRoutes } from './integrations';
import { writeRouteAudit } from '../services/auditEvents';

// These routes seal provider credentials with AAD-bound enc:v3 ciphertext and
// fail closed (503) when no active key id is configured — which is what the
// shared test setup leaves behind. Production is required to set this (see the
// APP_ENCRYPTION_KEY_ID rule in config/validate.ts); mirror that here so the
// suite exercises the configured path, and restore the ambient env afterwards.
const priorEncryptionKey = process.env.APP_ENCRYPTION_KEY;
const priorEncryptionKeyId = process.env.APP_ENCRYPTION_KEY_ID;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'integration-routes-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'integration-routes-test';
});

afterAll(() => {
  if (priorEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = priorEncryptionKey;
  if (priorEncryptionKeyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
  else process.env.APP_ENCRYPTION_KEY_ID = priorEncryptionKeyId;
});

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

    // A test with no Grafana URL configured is a config problem, not a success.
    const test = await app.request('/integrations/monitoring/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ provider: 'grafana', config: {} })
    });
    expect(test.status).toBe(400);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  describe('POST /monitoring/test performs a real provider check (#5427)', () => {
    const testCall = (body: Record<string, unknown>) => app.request('/integrations/monitoring/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(body),
    });

    beforeEach(() => {
      safeFetchMock.mockReset();
    });

    it('rejects an unknown provider with 400 and no outbound call', async () => {
      const res = await testCall({ provider: 'nagios', config: {} });
      expect(res.status).toBe(400);
      expect(safeFetchMock).not.toHaveBeenCalled();
    });

    it('reports a rejected Grafana API key as 502 with success:false', async () => {
      safeFetchMock.mockResolvedValue(new Response(null, { status: 401 }));
      const res = await testCall({
        provider: 'grafana',
        config: { url: 'https://grafana.example.test', apiKey: 'typed-plaintext-key' },
      });
      expect(res.status).toBe(502);
      const payload = await res.json();
      expect(payload.success).toBe(false);
      expect(payload.error).toMatch(/rejected/i);
      expect(JSON.stringify(payload)).not.toContain('typed-plaintext-key');
      expect(safeFetchMock).toHaveBeenCalledWith(
        'https://grafana.example.test/api/org',
        expect.objectContaining({ headers: { Authorization: 'Bearer typed-plaintext-key' }, timeoutMs: 10_000 }),
      );
    });

    it('reports an unreachable host as 502 without echoing the credential', async () => {
      safeFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await testCall({
        provider: 'opsGenie',
        config: { apiKey: 'ops-private-key' },
      });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain('api.opsgenie.com');
      expect(text).not.toContain('ops-private-key');
    });

    it('substitutes the stored sealed credential for a masked one and reports success', async () => {
      const save = await app.request('/integrations/monitoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ grafana: { enabled: true, url: 'https://grafana.example.test', apiKey: 'stored-secret-key' } }),
      });
      expect(save.status).toBe(200);
      safeFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

      const res = await testCall({
        provider: 'grafana',
        config: { enabled: true, url: 'https://grafana.example.test', apiKey: '********' },
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(safeFetchMock).toHaveBeenCalledWith(
        'https://grafana.example.test/api/org',
        expect.objectContaining({ headers: { Authorization: 'Bearer stored-secret-key' } }),
      );
    });

    // Same origin-binding contract as credentialOriginBinding.ts:
    // a masked credential must not be decrypted and forwarded to a
    // destination this same request just changed.
    it('refuses to resolve a masked credential when the URL origin changed from the stored value', async () => {
      const save = await app.request('/integrations/monitoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ grafana: { enabled: true, url: 'https://grafana.example.test', apiKey: 'stored-secret-key' } }),
      });
      expect(save.status).toBe(200);
      safeFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

      const res = await testCall({
        provider: 'grafana',
        config: { enabled: true, url: 'https://other-origin.example', apiKey: '********' },
      });
      expect(res.status).toBe(400);
      expect(safeFetchMock).not.toHaveBeenCalled();
      const text = await res.text();
      expect(text).not.toContain('stored-secret-key');
    });

    it('allows a URL change when a fresh, unmasked credential is supplied in the same request', async () => {
      const save = await app.request('/integrations/monitoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ grafana: { enabled: true, url: 'https://grafana.example.test', apiKey: 'stored-secret-key' } }),
      });
      expect(save.status).toBe(200);
      safeFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

      const res = await testCall({
        provider: 'grafana',
        config: { enabled: true, url: 'https://new-grafana.example.test', apiKey: 'freshly-typed-key' },
      });
      expect(res.status).toBe(200);
      expect(safeFetchMock).toHaveBeenCalledWith(
        'https://new-grafana.example.test/api/org',
        expect.objectContaining({ headers: { Authorization: 'Bearer freshly-typed-key' } }),
      );
    });

    it('refuses a masked credential with nothing stored instead of testing a placeholder', async () => {
      const res = await testCall({
        provider: 'opsGenie',
        config: { apiKey: '********' },
      });
      expect(res.status).toBe(400);
      expect(safeFetchMock).not.toHaveBeenCalled();
    });

    it('resolves a masked webhook endpoint URL from the stored sealed settings', async () => {
      const save = await app.request('/integrations/monitoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ webhooks: { enabled: true, endpoints: [
          { id: 'ep-1', name: 'relay', url: 'https://hooks.example.test/private-token', enabled: true },
        ] } }),
      });
      expect(save.status).toBe(200);
      safeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      const res = await testCall({
        provider: 'webhooks',
        endpointId: 'ep-1',
        config: { enabled: true, endpoints: [{ id: 'ep-1', name: 'relay', url: '********', enabled: true }] },
      });
      expect(res.status).toBe(200);
      expect(safeFetchMock.mock.calls[0]![0]).toBe('https://hooks.example.test/private-token');
      expect(await res.text()).not.toContain('private-token');
    });

    it('answers 400, not 500, when a stored credential cannot be decrypted', async () => {
      const save = await app.request('/integrations/monitoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ opsGenie: { enabled: true, apiKey: 'sealed-under-current-key' } }),
      });
      expect(save.status).toBe(200);
      // Rotate the key material out from under the stored ciphertext.
      const priorKey = process.env.APP_ENCRYPTION_KEY;
      process.env.APP_ENCRYPTION_KEY = 'a-different-key-after-rotation';
      try {
        const res = await testCall({ provider: 'opsGenie', config: { enabled: true, apiKey: '********' } });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/could not be read/i);
        expect(safeFetchMock).not.toHaveBeenCalled();
        expect(writeRouteAudit).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ action: 'integration.monitoring.test', details: { outcome: 'secret_unreadable' } }),
        );
      } finally {
        process.env.APP_ENCRYPTION_KEY = priorKey;
      }
    });

    it('answers 400 for an SSRF-blocked destination', async () => {
      const blocked = new Error('URL points to blocked address: 10.0.0.5');
      blocked.name = 'SsrfBlockedError';
      safeFetchMock.mockRejectedValue(blocked);
      const res = await testCall({ provider: 'grafana', config: { url: 'http://10.0.0.5', apiKey: 'k' } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not an allowed destination/);
    });

    it('posts a test event to the selected webhook endpoint', async () => {
      safeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      const res = await testCall({
        provider: 'webhooks',
        endpointId: 'two',
        config: { enabled: true, endpoints: [
          { id: 'one', name: 'first', url: 'https://hooks.example.test/one', enabled: true },
          { id: 'two', name: 'second', url: 'https://hooks.example.test/two', enabled: true },
        ] },
      });
      expect(res.status).toBe(200);
      expect(safeFetchMock).toHaveBeenCalledTimes(1);
      expect(safeFetchMock.mock.calls[0]![0]).toBe('https://hooks.example.test/two');
      expect(safeFetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    });
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

  it('refuses the write with 503 when no active encryption key id is configured', async () => {
    const restore = process.env.APP_ENCRYPTION_KEY_ID;
    delete process.env.APP_ENCRYPTION_KEY_ID;
    try {
      const save = await app.request('/integrations/ticketing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ provider: 'example', apiKey: 'unsealable-api-key' })
      });

      expect(save.status).toBe(503);
      const body = await save.json();
      expect(body.error).toContain('APP_ENCRYPTION_KEY_ID');
    } finally {
      if (restore === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
      else process.env.APP_ENCRYPTION_KEY_ID = restore;
    }

    // Nothing was stored. The compatibility maps are module-level and outlive
    // each test's app, so assert on the credential itself rather than on the
    // store being empty: the refused write must not have left a plaintext or
    // v1-sealed value behind for a reader to pick up.
    const read = await app.request('/integrations/ticketing', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(read.status).toBe(200);
    expect(await read.text()).not.toContain('unsealable-api-key');
  });
});

// #12054: the chat-integration "Test notification" button used to answer
// `{ success: true, message: '<provider> test notification queued.' }` without
// sending or queueing anything. A test must report a real dispatch outcome.
describe('chat integration test notifications', () => {
  let app: Hono;
  const discordWebhook = 'https://discord.com/api/webhooks/123456789/private-webhook-token';

  const post = (provider: string, body: Record<string, unknown>) =>
    app.request(`/integrations/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/integrations', integrationRoutes);
  });

  it('posts a real message to the Discord webhook and reports it sent', async () => {
    safeFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await post('discord', { enabled: true, webhookUrl: discordWebhook, test: true });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).not.toMatch(/queued/i);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetchMock.mock.calls[0]!;
    expect(url).toBe(discordWebhook);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const sent = JSON.parse(init.body);
    expect(typeof sent.content).toBe('string');
    expect(sent.content.length).toBeGreaterThan(0);
    // A test message must never ping @everyone/@here or a role.
    expect(sent.allowed_mentions).toEqual({ parse: [] });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'integration.discord.test',
      details: { outcome: 'ok' },
    }));
  });

  it('tests the stored webhook when the UI sends back the masked value', async () => {
    const saved = await post('discord', { enabled: true, webhookUrl: discordWebhook });
    expect(saved.status).toBe(200);
    safeFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await post('discord', { enabled: true, webhookUrl: '********', test: true });

    expect(res.status).toBe(200);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.calls[0]![0]).toBe(discordWebhook);
  });

  it('reports a webhook Discord rejects as a failure without echoing the token', async () => {
    safeFetchMock.mockResolvedValueOnce(new Response('{"message":"Unknown Webhook"}', { status: 404 }));

    const res = await post('discord', { enabled: true, webhookUrl: discordWebhook, test: true });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('private-webhook-token');
    const body = JSON.parse(text);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/404/);
  });

  it('reports a Discord server error or rate limit as a 502 failure', async () => {
    safeFetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const limited = await post('discord', { enabled: true, webhookUrl: discordWebhook, test: true });
    expect(limited.status).toBe(502);
    expect((await limited.json()).success).toBe(false);

    safeFetchMock.mockRejectedValueOnce(new Error('connect ETIMEDOUT https://discord.com/api/webhooks/123456789/private-webhook-token'));
    const unreachable = await post('discord', { enabled: true, webhookUrl: discordWebhook, test: true });
    expect(unreachable.status).toBe(502);
    const text = await unreachable.text();
    expect(text).not.toContain('private-webhook-token');
    expect(JSON.parse(text).success).toBe(false);
  });

  it('refuses to test a webhook that is not a Discord webhook URL', async () => {
    for (const webhookUrl of [
      'https://example.com/api/webhooks/1/token',
      'http://discord.com/api/webhooks/1/token',
      'https://discord.com/channels/1/2',
      'https://discord.com.attacker.test/api/webhooks/1/token',
      'https://user:pass@discord.com/api/webhooks/1/token',
      'https://discord.com:8443/api/webhooks/1/token',
    ]) {
      const res = await post('discord', { enabled: true, webhookUrl, test: true });
      expect(res.status, webhookUrl).toBe(400);
      expect((await res.json()).success).toBe(false);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('refuses to test Discord before a webhook URL is entered', async () => {
    const res = await post('discord', { enabled: true, webhookUrl: '', test: true });
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it.each(['slack', 'teams'])('does not claim a %s test succeeded when nothing can be delivered', async (provider) => {
    const res = await post(provider, { enabled: true, test: true });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
