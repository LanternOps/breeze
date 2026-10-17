import { describe, expect, it } from 'vitest';
import { publicOriginFor } from './publicOrigin';

const fallback = new URL('http://internal:4321/trust/nw');
const req = (headers: Record<string, string>) => new Request('http://internal:4321/', { headers });

describe('publicOriginFor', () => {
  it('uses forwarded proto + host', () => {
    expect(publicOriginFor(req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'portal.example' }), fallback)).toBe('https://portal.example');
  });
  it('takes the first value of comma lists and falls back to host', () => {
    expect(publicOriginFor(req({ 'x-forwarded-proto': 'https, http', host: 'portal.example:8443' }), fallback)).toBe('https://portal.example:8443');
  });
  it('falls back when proto is not http/https', () => {
    expect(publicOriginFor(req({ 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'portal.example' }), fallback)).toBe(fallback.origin);
  });
  it('falls back when headers are missing', () => {
    expect(publicOriginFor(req({}), fallback)).toBe(fallback.origin);
  });
  it('falls back on a junk host', () => {
    expect(publicOriginFor(req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.com/<script>' }), fallback)).toBe(fallback.origin);
  });
});
