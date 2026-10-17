import { describe, it, expect } from 'vitest';
import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { byTrustCrossOriginPath, isTrustCrossOriginPath } from './trustCrossOrigin';

describe('isTrustCrossOriginPath', () => {
  it.each([
    ['/api/v1/trust/attestation/jwks.json', true],
    ['/api/v1/trust/attestation/nw', true],
    ['/api/v1/trust/attestation/nw/acme', true],
    ['/api/v1/trust/public/nw/acme/badge.svg', true],
    ['/api/v1/trust/public/nw/acme', false], // payload: read by the portal page, same-origin
    ['/api/v1/trust/public/nw', false],
    ['/api/v1/trust/card/nw/acme', false],
    ['/api/v1/trust/public/nw/acme/documents/0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', false],
    ['/api/v1/trust/public/nw/acme/badge.svgx', false],
    ['/api/v1/trust/public/nw/acme/x/badge.svg', false],
    ['/api/v1/trust/attestation', false],
    ['/api/v1/trust/attestationx/nw', false],
    ['/api/v1/partner/trust/attestation/x', false],
    ['/api/v1/devices', false],
  ])('%s → %s', (path, expected) => {
    expect(isTrustCrossOriginPath(path)).toBe(expected);
  });
});

describe('byTrustCrossOriginPath (the index.ts secureHeaders registration)', () => {
  // Same shape as index.ts: one app-wide registration ahead of the routers. The handlers try to set their own CORP
  // to prove the point of this middleware — secureHeaders writes after next(), so a handler cannot opt out.
  const app = new Hono();
  const OPTIONS = { strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload', xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin' } as const;
  app.use('*', byTrustCrossOriginPath(
    secureHeaders({ ...OPTIONS }),
    secureHeaders({ ...OPTIONS, crossOriginResourcePolicy: 'cross-origin' }),
  ));
  const handler = (c: Context) => {
    c.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return c.text('ok');
  };
  app.get('/api/v1/trust/public/:p/:o/badge.svg', handler);
  app.get('/api/v1/trust/attestation/:p/:o', handler);
  app.get('/api/v1/trust/attestation/jwks.json', handler);
  app.get('/api/v1/trust/public/:p/:o', handler);
  app.get('/api/v1/devices', handler);

  it('badge.svg response carries Cross-Origin-Resource-Policy: cross-origin', async () => {
    const res = await app.request('/api/v1/trust/public/nw/acme/badge.svg');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it('attestation and JWKS responses carry cross-origin', async () => {
    expect((await app.request('/api/v1/trust/attestation/nw/acme')).headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect((await app.request('/api/v1/trust/attestation/jwks.json')).headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it('payload response keeps same-origin (a handler cannot widen it)', async () => {
    expect((await app.request('/api/v1/trust/public/nw/acme')).headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect((await app.request('/api/v1/devices')).headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('every other secure header is identical on both branches', async () => {
    const strip = (h: Headers) => [...h.entries()].filter(([k]) => k !== 'cross-origin-resource-policy' && k !== 'content-type' && k !== 'content-length');
    const cross = strip((await app.request('/api/v1/trust/public/nw/acme/badge.svg')).headers);
    const same = strip((await app.request('/api/v1/devices')).headers);
    expect(cross).toEqual(same);
    expect(Object.fromEntries(cross)).toMatchObject({ 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' });
  });
});
