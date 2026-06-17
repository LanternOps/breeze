import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildPortalApiUrl } from './api';

// Regression guard for the same-origin client API base (the deploy relies on it):
// with PUBLIC_API_URL unset, the browser must issue RELATIVE /api/v1 requests so
// the reverse proxy routes them to the API. A previous default of
// `http://localhost:3001` produced an absolute, CSP-blocked, wrong-port URL.
//
// Simulate the browser by defining a minimal `window` (the empty-base path returns
// before reading window.location, so a stub is enough).
describe('buildPortalApiUrl (client, PUBLIC_API_URL unset)', () => {
  beforeAll(() => {
    (globalThis as unknown as { window?: unknown }).window = {
      location: { origin: 'http://localhost', hostname: 'localhost' }
    };
  });
  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('produces a same-origin relative /api/v1 path', () => {
    expect(buildPortalApiUrl('/portal/auth/login')).toBe('/api/v1/portal/auth/login');
  });

  it('does not emit an absolute http://localhost:3001 origin', () => {
    expect(buildPortalApiUrl('/portal/devices')).not.toMatch(/^https?:\/\//);
  });

  it('rewrites a leading /api/ to the versioned /api/v1 prefix', () => {
    expect(buildPortalApiUrl('/api/portal/branding/x')).toBe('/api/v1/portal/branding/x');
  });

  it('passes absolute URLs through untouched', () => {
    expect(buildPortalApiUrl('https://files.example/x.pdf')).toBe('https://files.example/x.pdf');
  });
});
