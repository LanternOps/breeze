import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { metricMock } = vi.hoisted(() => ({ metricMock: vi.fn() }));
vi.mock('../services/tunnelHttpMetrics', () => ({ recordTunnelHttpOutcome: metricMock }));

import { parseTunnelOriginConfig } from '../config/tunnelOrigin';
import { requestPathLogger } from './requestPathLogger';
import { tunnelHostClassifier, tunnelHostDispatch } from './tunnelHostDispatch';

const TUNNEL_HOST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const parsed = parseTunnelOriginConfig({
  NODE_ENV: 'production', PUBLIC_APP_URL: 'https://us.breeze-app.test', TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.us.breezetunnel.test',
});
if (!parsed.ok || !parsed.config) throw new Error('bad fixture');
const CONFIG = parsed.config;

function makeApp(lines: string[]) {
  const tunnelApp = new Hono();
  // A device-controlled X-Request-Id must never win over the correlation id.
  tunnelApp.all('*', (c) => c.text('x', 401, { 'x-request-id': 'device-chosen' }));
  const app = new Hono();
  app.use('*', requestPathLogger((m) => lines.push(m)));
  app.use('*', tunnelHostClassifier(() => CONFIG));
  app.use('*', tunnelHostDispatch(tunnelApp));
  app.get('/api/v1/health', (c) => c.text('ok'));
  return app;
}

beforeEach(() => metricMock.mockClear());

describe('tunnel host request logging', () => {
  it('never logs the ticket, cookies or the device path; logs route=tunnel-host and returns X-Request-Id', async () => {
    const lines: string[] = [];
    const res = await makeApp(lines).request('/__bz/enter?t=SECRET-TICKET-123', {
      headers: { host: TUNNEL_HOST, 'x-breeze-tunnel-site': '1', cookie: '__Host-bzt=SECRET-COOKIE' },
    });
    const joined = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(joined).not.toContain('SECRET-TICKET-123');
    expect(joined).not.toContain('SECRET-COOKIE');
    expect(joined).not.toContain('__bz/enter');
    // amended 2026-10-12b item 5: a route label, never `unmatched`, and the correlation id.
    expect(joined).toContain('route=tunnel-host status=401');
    expect(joined).not.toContain('route=unmatched');
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toMatch(UUID);
    expect(joined).toContain(`request_id=${requestId}`);
  });

  it('a host rejected at the classifier keeps its reject reason and counts as host_rejected', async () => {
    const lines: string[] = [];
    const res = await makeApp(lines).request('/api/v1/health', { headers: { host: TUNNEL_HOST } });
    expect(res.status).toBe(421);
    expect(lines.join('\n')).toContain('reason=tunnel_host_without_assertion');
    expect(metricMock).toHaveBeenCalledWith('host', 'host_rejected');
  });

  it('app hosts keep their own route label', async () => {
    const lines: string[] = [];
    const res = await makeApp(lines).request('/api/v1/health', { headers: { host: 'us.breeze-app.test' } });
    expect(res.status).toBe(200);
    expect(lines.join('\n')).toContain('route=/api/v1/health');
    expect(metricMock).not.toHaveBeenCalled();
  });
});
