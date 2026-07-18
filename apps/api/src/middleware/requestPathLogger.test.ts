import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestPathLogger } from './requestPathLogger';

describe('requestPathLogger', () => {
  it('logs only method, pathname, status, and timing for callback and generic query routes', async () => {
    const print = vi.fn();
    const app = new Hono();
    app.use('*', requestPathLogger(print));
    app.get('*', (c) => c.text('ok'));

    const requests = [
      '/api/v1/m365/consent/callback?state=identity-state-secret&code=authorization-code-secret',
      '/api/v1/m365/consent/callback?state=admin-state-secret&tenant=11111111-1111-4111-8111-111111111111&admin_consent=true',
      '/api/v1/m365/consent/callback?state=error-state-secret&error=access_denied&error_description=provider-description-secret',
      '/health?token=generic-token-secret&password=generic-password-secret',
    ];

    for (const path of requests) {
      expect((await app.request(path)).status).toBe(200);
    }

    const logs = print.mock.calls.flat().join('\n');
    expect(logs).toContain('<-- GET /api/v1/m365/consent/callback');
    expect(logs).toMatch(/--> GET \/api\/v1\/m365\/consent\/callback 200 \d+(?:ms|s)/);
    expect(logs).toContain('<-- GET /health');
    expect(logs).toMatch(/--> GET \/health 200 \d+(?:ms|s)/);
    expect(logs).not.toContain('?');
    for (const secret of [
      'state', 'code', 'tenant', 'admin_consent', 'error', 'error_description',
      'token', 'password', 'identity-state-secret', 'authorization-code-secret',
      'admin-state-secret', 'error-state-secret', 'provider-description-secret',
      'generic-token-secret', 'generic-password-secret',
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('stays upstream of handlers and logs the final response status', async () => {
    const events: string[] = [];
    const app = new Hono();
    app.use('*', requestPathLogger((message) => events.push(message)));
    app.get('/ordered', (c) => {
      events.push('handler');
      return c.text('created', 201);
    });

    expect((await app.request('/ordered?secret=hidden')).status).toBe(201);
    expect(events).toHaveLength(3);
    expect(events[0]).toBe('<-- GET /ordered');
    expect(events[1]).toBe('handler');
    expect(events[2]).toMatch(/^--> GET \/ordered 201 \d+(?:ms|s)$/);
  });
});
