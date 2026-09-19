import { describe, it, expect, vi } from 'vitest';
import { testMonitoringProvider, MONITORING_TEST_PROVIDERS } from './monitoringIntegrationTest.js';

describe('testMonitoringProvider', () => {
  describe('prometheus', () => {
    it('returns ok when /-/healthy returns 200', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const result = await testMonitoringProvider(
        { provider: 'prometheus', config: { endpointUrl: 'http://prom.example.com' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Prometheus is reachable.' });
      expect(fetch).toHaveBeenCalledWith('http://prom.example.com/-/healthy', {
        method: 'GET',
        timeoutMs: 10_000,
        allowPrivateNetwork: false
      });
    });

    it('falls back to /metrics when /-/healthy returns 404', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const result = await testMonitoringProvider(
        { provider: 'prometheus', config: { endpointUrl: 'http://prom.example.com' }, allowPrivateNetwork: true },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Metrics endpoint is reachable.' });
      expect(fetch).toHaveBeenNthCalledWith(2, 'http://prom.example.com/metrics', {
        method: 'GET',
        timeoutMs: 10_000,
        allowPrivateNetwork: true
      });
    });
  });

  describe('grafana', () => {
    it('returns ok when API key is valid and /api/org returns 200', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const result = await testMonitoringProvider(
        { provider: 'grafana', config: { url: 'https://grafana.example.com', apiKey: 'test-key-123' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Grafana accepted the API key.' });
      expect(fetch).toHaveBeenCalledWith('https://grafana.example.com/api/org', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-key-123' },
        timeoutMs: 10_000,
        allowPrivateNetwork: false
      });
    });

    it('returns rejected on 401', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      const result = await testMonitoringProvider(
        { provider: 'grafana', config: { url: 'https://grafana.example.com', apiKey: 'bad-key' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'rejected', message: 'Grafana rejected the API key.' });
    });
  });

  describe('pagerDuty', () => {
    it('returns ok without making any fetch call when key is valid', async () => {
      const fetch = vi.fn();
      const result = await testMonitoringProvider(
        { provider: 'pagerDuty', config: { integrationKey: 'a'.repeat(32) }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Integration key format is valid. PagerDuty offers no dry-run; the first real alert confirms delivery.' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns invalid when key is wrong length', async () => {
      const fetch = vi.fn();
      const result = await testMonitoringProvider(
        { provider: 'pagerDuty', config: { integrationKey: 'short' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'invalid', message: 'PagerDuty integration key must be the 32-character Events API v2 key' });
    });
  });

  describe('opsGenie', () => {
    it('returns ok when API key is valid and /v2/account returns 200', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const result = await testMonitoringProvider(
        { provider: 'opsGenie', config: { apiKey: 'valid-key' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Opsgenie accepted the API key.' });
      expect(fetch).toHaveBeenCalledWith('https://api.opsgenie.com/v2/account', {
        method: 'GET',
        headers: { Authorization: 'GenieKey valid-key' },
        timeoutMs: 10_000,
        allowPrivateNetwork: false
      });
    });

    it('returns rejected on 403', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
      const result = await testMonitoringProvider(
        { provider: 'opsGenie', config: { apiKey: 'bad-key' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'rejected', message: 'Opsgenie rejected the API key.' });
    });
  });

  describe('webhooks', () => {
    it('selects endpoint by id when provided', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const result = await testMonitoringProvider(
        { provider: 'webhooks', config: { endpoints: [{ id: 'abc', url: 'http://hook.example.com' }] }, endpointId: 'abc', allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Webhook hook.example.com accepted the test event (HTTP 200).' });
    });

    it('falls back to first enabled endpoint', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const result = await testMonitoringProvider(
        { provider: 'webhooks', config: { endpoints: [{ url: 'http://hook.example.com' }, { id: 'xyz', enabled: true, url: 'http://enabled.example.com' }] }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Webhook enabled.example.com accepted the test event (HTTP 200).' });
    });

    it('falls back to first endpoint when none enabled', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const result = await testMonitoringProvider(
        { provider: 'webhooks', config: { endpoints: [{ url: 'http://first.example.com' }] }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: true, message: 'Webhook first.example.com accepted the test event (HTTP 200).' });
    });

    it('returns invalid when no endpoints', async () => {
      const fetch = vi.fn();
      const result = await testMonitoringProvider(
        { provider: 'webhooks', config: { endpoints: [] }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'invalid', message: 'No webhook endpoint to test' });
    });

    it('returns rejected on 401', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      const result = await testMonitoringProvider(
        { provider: 'webhooks', config: { endpoints: [{ name: 'MyHook', url: 'http://hook.example.com' }] }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'rejected', message: 'Webhook MyHook rejected the test event (HTTP 401)' });
    });

    it('returns unreachable on other status', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
      const result = await testMonitoringProvider(
        { provider: 'webhooks', config: { endpoints: [{ url: 'http://hook.example.com' }] }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'unreachable', message: 'Webhook hook.example.com returned HTTP 500' });
    });

    it('sends correct JSON body', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      await testMonitoringProvider(
        { provider: 'webhooks', config: { endpoints: [{ url: 'http://hook.example.com' }] }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(fetch).toHaveBeenCalledWith('http://hook.example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('breeze.monitoring.test'),
        timeoutMs: 10_000,
        allowPrivateNetwork: false
      });
    });
  });

  describe('webhook endpoint selection (#5778 review)', () => {
    it('refuses an endpointId that matches no endpoint instead of testing another one', async () => {
      const fetch = vi.fn();
      const result = await testMonitoringProvider(
        { provider: 'webhooks', endpointId: 'missing', allowPrivateNetwork: false,
          config: { endpoints: [{ id: 'one', url: 'https://hooks.example.test/one', enabled: true }] } },
        { fetch },
      );
      expect(result).toEqual({ ok: false, kind: 'invalid', message: 'Webhook endpoint not found' });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('SSRF guard', () => {
    it("classifies a blocked destination as kind 'blocked', not a transient failure", async () => {
      const blocked = new Error('URL points to blocked address: 169.254.169.254');
      blocked.name = 'SsrfBlockedError';
      const fetch = vi.fn().mockRejectedValue(blocked);
      const result = await testMonitoringProvider(
        { provider: 'grafana', allowPrivateNetwork: false, config: { url: 'http://169.254.169.254', apiKey: 'k' } },
        { fetch },
      );
      expect(result).toMatchObject({ ok: false, kind: 'blocked' });
      expect((result as { message: string }).message).toContain('not an allowed destination');
      expect((result as { message: string }).message).not.toContain('k"');
    });
  });

  describe('error handling', () => {
    it('returns unreachable when fetch throws and includes host in message without API key', async () => {
      const fetch = vi.fn().mockRejectedValue(new Error('network down'));
      const result = await testMonitoringProvider(
        { provider: 'prometheus', config: { endpointUrl: 'http://prom.example.com' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'unreachable', message: 'Could not reach prom.example.com: network down' });
    });

    it('returns invalid for malformed URL without calling fetch', async () => {
      const fetch = vi.fn();
      const result = await testMonitoringProvider(
        { provider: 'prometheus', config: { endpointUrl: 'not-a-url' }, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'invalid', message: 'Prometheus endpoint URL must be an http(s) URL' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns invalid for unknown provider', async () => {
      const fetch = vi.fn();
      const result = await testMonitoringProvider(
        { provider: 'unknown' as any, config: {}, allowPrivateNetwork: false },
        { fetch }
      );
      expect(result).toEqual({ ok: false, kind: 'invalid', message: 'Unsupported monitoring provider' });
    });
  });
});