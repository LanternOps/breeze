import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { routeReferrerPolicyWins } from './routeReferrerPolicy';

const OPTIONS = { referrerPolicy: 'strict-origin-when-cross-origin' } as const;

function build(wrap: boolean) {
  const app = new Hono();
  const mw = secureHeaders({ ...OPTIONS });
  app.use('*', wrap ? routeReferrerPolicyWins(mw) : mw);
  app.get('/capability', (c) => {
    c.header('Referrer-Policy', 'no-referrer');
    return c.json({ ok: true });
  });
  app.get('/capability-response', () =>
    new Response('pdf', { headers: { 'Referrer-Policy': 'no-referrer' } }));
  app.get('/capability-throws', () => {
    throw new Error('boom');
  });
  app.get('/plain', (c) => c.json({ ok: true }));
  return app;
}

describe('routeReferrerPolicyWins (#8964)', () => {
  it('control: bare secureHeaders overwrites a route-level no-referrer', async () => {
    const res = await build(false).request('/capability');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('keeps a route-level no-referrer set via c.header', async () => {
    const res = await build(true).request('/capability');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('keeps a route-level no-referrer on a returned Response', async () => {
    const res = await build(true).request('/capability-response');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('routes that set nothing still get the global default', async () => {
    const res = await build(true).request('/plain');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('still applies the other secure headers on capability routes', async () => {
    const res = await build(true).request('/capability');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('error responses fall back to the global default without throwing', async () => {
    const res = await build(true).request('/capability-throws');
    expect(res.status).toBe(500);
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('wiring', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('index.ts registers the app-wide secureHeaders through routeReferrerPolicyWins', () => {
    expect(read('../index.ts')).toMatch(/routeReferrerPolicyWins\(\s*byTrustCrossOriginPath\(/);
  });

  it('the Caddy site block only defaults Referrer-Policy, so an upstream no-referrer survives', () => {
    const caddy = read('../../../../docker/Caddyfile.prod').replace(/#[^\n]*/g, '');
    expect(caddy).toMatch(/^\s*\?Referrer-Policy\s+"strict-origin-when-cross-origin"/m);
    expect(caddy).not.toMatch(/^\s*Referrer-Policy\s/m);
  });

  it('the web middleware does not overwrite a Referrer-Policy a page already set', () => {
    const src = read('../../../web/src/middleware.ts');
    // the only remaining set is the guarded default inside setDefaultReferrerPolicy
    expect(src.match(/headers\.set\('Referrer-Policy'/g)).toHaveLength(1);
    expect(src).toMatch(/headers\.has\('Referrer-Policy'\)/);
  });
});
