import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestPathLogger } from './requestPathLogger';

describe('requestPathLogger', () => {
  it('never logs capability-bearing raw paths and labels completions by matched template', async () => {
    const print = vi.fn();
    const app = new Hono();
    app.use('*', requestPathLogger(print));
    app.get('/public/quotes/:token', (c) => c.text('ok'));
    app.get('/invites/:token', (c) => c.text('ok'));
    app.get('/provisioning/:token', (c) => c.text('ok'));
    app.get('/installers/:token', (c) => c.text('ok'));
    app.get('/remote-access/:capability', (c) => c.text('ok'));

    const fixtures: Array<readonly [string, string]> = [
      ['/public/quotes/quote-capability-7c4c', '/public/quotes/:token'],
      ['/invites/invite-capability-4b2a', '/invites/:token'],
      ['/provisioning/provision-capability-9f3d', '/provisioning/:token'],
      ['/installers/installer-capability-6a1e', '/installers/:token'],
      ['/remote-access/remote-capability-2d8b', '/remote-access/:capability'],
    ];

    for (const [path] of fixtures) {
      expect((await app.request(path)).status).toBe(200);
    }

    const logs = print.mock.calls.flat().join('\n');
    for (const [path, route] of fixtures) {
      expect(logs).not.toContain(path);
      expect(logs).toMatch(
        new RegExp(
          `--> GET route=${route!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} status=200 duration_ms=\\d+ request_id=[0-9a-f-]{36}`,
        ),
      );
    }
  });

  it('uses one request ID across both lines and the response header', async () => {
    const events: string[] = [];
    const app = new Hono();
    app.use('*', requestPathLogger((message) => events.push(message)));
    app.get('/ordered', (c) => {
      events.push('handler');
      return c.text('created', 201);
    });

    const inbound = '123e4567-e89b-42d3-a456-426614174000';
    const response = await app.request('/ordered?secret=hidden', {
      headers: { 'X-Request-Id': inbound },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('X-Request-Id')).toBe(inbound);
    expect(events).toHaveLength(3);
    expect(events[0]).toBe(`<-- GET request_id=${inbound}`);
    expect(events[1]).toBe('handler');
    expect(events[2]).toMatch(
      new RegExp(
        `^--> GET route=/ordered status=201 duration_ms=\\d+ request_id=${inbound}$`,
      ),
    );
  });

  it('replaces an attacker-supplied non-UUID request ID', async () => {
    const print = vi.fn();
    const app = new Hono();
    app.use('*', requestPathLogger(print));
    app.get('/health', (c) => c.text('ok'));

    const response = await app.request('/health', {
      headers: { 'X-Request-Id': 'attacker/request?token=capability-secret' },
    });

    const requestId = response.headers.get('X-Request-Id');
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(print.mock.calls.flat().join('\n')).not.toContain('capability-secret');
  });

  it('uses unmatched for a 404 and never falls back to the raw path', async () => {
    const print = vi.fn();
    const app = new Hono();
    app.use('*', requestPathLogger(print));

    expect((await app.request('/missing/404-capability-secret')).status).toBe(404);

    const logs = print.mock.calls.flat().join('\n');
    expect(logs).toContain('route=unmatched status=404');
    expect(logs).not.toContain('404-capability-secret');
  });

  it('logs a safe completion label when a matched route throws', async () => {
    const print = vi.fn();
    const app = new Hono();
    app.use('*', requestPathLogger(print));
    app.get('/throws/:token', () => {
      throw new Error('route failed');
    });
    app.onError((_error, c) => c.text('failed', 500));

    expect((await app.request('/throws/thrown-capability-secret')).status).toBe(500);

    const logs = print.mock.calls.flat().join('\n');
    expect(logs).toContain('route=/throws/:token status=500');
    expect(logs).not.toContain('thrown-capability-secret');
  });
});
