import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { exceptPathPrefix } from './pathExemption';

describe('exceptPathPrefix', () => {
  it('skips the wrapped middleware for a request path under the prefix', async () => {
    const app = new Hono();
    app.use('*', exceptPathPrefix('/exempt/', secureHeaders({ xFrameOptions: 'DENY' })));
    app.get('/exempt/thing', (c) => c.text('ok'));
    app.get('/other', (c) => c.text('ok'));

    const exempted = await app.request('/exempt/thing');
    expect(exempted.headers.get('x-frame-options')).toBeNull();

    const notExempted = await app.request('/other');
    expect(notExempted.headers.get('x-frame-options')).toBe('DENY');
  });

  it('lets a downstream handler set its own conflicting header on the exempted path', async () => {
    // A middleware installed
    // AFTER the exemption (mirroring `cors`/downstream ordering in index.ts)
    // must not be able to re-add a header the route's own handler removed or
    // replaced, on the exempted path only.
    const app = new Hono();
    app.use('*', exceptPathPrefix('/exempt/', secureHeaders({ xFrameOptions: 'DENY' })));
    app.get('/exempt/thing', (c) => {
      return new Response('proxied', {
        headers: { 'content-security-policy': "sandbox allow-scripts; frame-ancestors 'self'" },
      });
    });

    const res = await app.request('/exempt/thing');
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe("sandbox allow-scripts; frame-ancestors 'self'");
  });

  it('does not affect a sibling path that merely starts with a similar string', async () => {
    const app = new Hono();
    app.use('*', exceptPathPrefix('/exempt/', secureHeaders({ xFrameOptions: 'DENY' })));
    app.get('/exempted-but-not-really', (c) => c.text('ok'));

    const res = await app.request('/exempted-but-not-really');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
