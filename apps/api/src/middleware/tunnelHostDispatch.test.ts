import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { parseTunnelOriginConfig } from '../config/tunnelOrigin';
import {
  decideTunnelHost,
  exceptTunnelSurface,
  tunnelHostClassifier,
  tunnelHostDispatch,
} from './tunnelHostDispatch';
import { tunnelHostRoutes } from '../routes/tunnelHost';

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TUNNEL_HOST = `${ID}.us.breezetunnel.test`;
const parsed = parseTunnelOriginConfig({
  NODE_ENV: 'production', PUBLIC_APP_URL: 'https://us.breeze-app.test',
  TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.us.breezetunnel.test',
});
if (!parsed.ok || !parsed.config) throw new Error('fixture config invalid');
const CONFIG = parsed.config;

function makeApp(config = CONFIG, tunnelApp: Hono = defaultTunnelApp()) {
  const app = new Hono();
  app.use('*', tunnelHostClassifier(() => config));
  app.use('*', exceptTunnelSurface(secureHeaders({ xFrameOptions: 'DENY' })));
  app.use('*', tunnelHostDispatch(tunnelApp));
  app.get('/api/v1/secret', (c) => c.text('app-route'));
  app.post('/api/v1/secret', (c) => c.text('app-route'));
  app.get('*', (c) => c.text('app-route'));
  return app;
}
function defaultTunnelApp() {
  const tunnelApp = new Hono();
  tunnelApp.all('*', async (c) => c.text(`tunnel|${c.req.method}|${c.req.path}|${await c.req.text()}`));
  return tunnelApp;
}

describe('decideTunnelHost', () => {
  it.each([
    [TUNNEL_HOST, '1', CONFIG, 'tunnel'],
    [`a.b.us.breezetunnel.test`, '1', CONFIG, 'tunnel'],
    ['us.breezetunnel.test', '1', CONFIG, 'tunnel'],
    [`${TUNNEL_HOST}.`, '1', CONFIG, 'tunnel'],
    [TUNNEL_HOST, undefined, CONFIG, 'reject'],
    [`${TUNNEL_HOST}.`, undefined, CONFIG, 'reject'],
    [`a.${TUNNEL_HOST}`, undefined, CONFIG, 'reject'],
    ['us.breezetunnel.test', undefined, CONFIG, 'reject'],
    [TUNNEL_HOST, 'forged', CONFIG, 'reject'],
    ['us.breeze-app.test', '1', CONFIG, 'reject'],
    ['us.breeze-app.test', undefined, CONFIG, 'app'],
    [TUNNEL_HOST, '1', null, 'reject'],
    [TUNNEL_HOST, undefined, null, 'app'],
  ] as const)('host %s assertion %s → %s', (host, assertion, config, kind) => {
    expect(decideTunnelHost(host, assertion, config).kind).toBe(kind);
  });
});

describe('tunnel host dispatch', () => {
  it('sends an asserted tunnel host to the tunnel app — even for /api paths — without app headers', async () => {
    const res = await makeApp().request('/api/v1/secret', { headers: { host: TUNNEL_HOST, 'x-breeze-tunnel-site': '1' } });
    expect(await res.text()).toBe('tunnel|GET|/api/v1/secret|');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('passes a POST body through to the tunnel app', async () => {
    const res = await makeApp().request('/form', {
      method: 'POST', body: 'a=1', headers: { host: TUNNEL_HOST, 'x-breeze-tunnel-site': '1' },
    });
    expect(await res.text()).toBe('tunnel|POST|/form|a=1');
  });

  it('serves app routes on app hosts with app headers', async () => {
    const res = await makeApp().request('/api/v1/secret', { headers: { host: 'us.breeze-app.test' } });
    expect(await res.text()).toBe('app-route');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('421s a tunnel-pattern Host without the assertion and an app Host with it', async () => {
    const app = makeApp();
    expect((await app.request('/api/v1/secret', { headers: { host: TUNNEL_HOST } })).status).toBe(421);
    expect((await app.request('/api/v1/secret', { headers: { host: 'us.breeze-app.test', 'x-breeze-tunnel-site': '1' } })).status).toBe(421);
  });

  it('ignores X-Forwarded-Host for the decision', async () => {
    const res = await makeApp().request('/api/v1/secret', { headers: { host: 'us.breeze-app.test', 'x-forwarded-host': TUNNEL_HOST } });
    expect(await res.text()).toBe('app-route');
  });

  it('with host mode off, any assertion is refused and tunnel-looking hosts are ordinary app hosts', async () => {
    const app = makeApp(null as never);
    expect((await app.request('/api/v1/secret', { headers: { host: TUNNEL_HOST, 'x-breeze-tunnel-site': '1' } })).status).toBe(421);
    expect(await (await app.request('/api/v1/secret', { headers: { host: TUNNEL_HOST } })).text()).toBe('app-route');
  });
});

// W00 spike (#8418): these hosts miss Caddy's wildcard block and reach the app
// block. The API classifier is the backstop: never an app response, with or
// without the assertion header; with it, the fail-closed scaffold answers 404.
describe('tunnel-suffix hosts that bypass the Caddy wildcard are fail-closed', () => {
  const app = makeApp(CONFIG, tunnelHostRoutes as unknown as Hono);
  it.each([
    ['trailing-dot host', `${TUNNEL_HOST}.`],
    ['deeper host', `a.${TUNNEL_HOST}`],
    ['bare suffix', 'us.breezetunnel.test'],
    ['upper-case with port', `${TUNNEL_HOST.toUpperCase()}:443`],
  ])('%s', async (_n, host) => {
    for (const path of ['/api/v1/secret', '/anything']) {
      const asserted = await app.request(path, { headers: { host, 'x-breeze-tunnel-site': '1' } });
      expect(asserted.status).toBe(404);
      expect(await asserted.text()).not.toBe('app-route');
      const bare = await app.request(path, { headers: { host } });
      expect(bare.status).toBe(421);
      expect(await bare.text()).not.toBe('app-route');
    }
  });
});
