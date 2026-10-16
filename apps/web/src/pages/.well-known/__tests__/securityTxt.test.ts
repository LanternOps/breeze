import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadRoute() {
  vi.resetModules();
  return import('../security.txt');
}

describe('GET /.well-known/security.txt', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is 404 when no contact is configured, so self-hosted installs publish nothing by default', async () => {
    vi.stubEnv('PUBLIC_ABUSE_CONTACT', '');
    vi.stubEnv('PUBLIC_SECURITY_CONTACT', '');
    vi.stubEnv('PUBLIC_SECURITY_POLICY_URL', '');
    const { GET } = await loadRoute();
    const res = await GET({} as never);
    expect(res.status).toBe(404);
  });

  it('serves text/plain with the configured contacts and a cache header', async () => {
    vi.stubEnv('PUBLIC_ABUSE_CONTACT', 'abuse@example.com');
    vi.stubEnv('PUBLIC_SECURITY_CONTACT', 'security@example.com');
    vi.stubEnv('PUBLIC_SECURITY_POLICY_URL', 'https://example.com/trust');
    const { GET } = await loadRoute();
    const res = await GET({} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await res.text();
    expect(body).toContain('Contact: mailto:security@example.com\n');
    expect(body).toContain('Contact: mailto:abuse@example.com\n');
    expect(body).toContain('Policy: https://example.com/trust\n');
    expect(body).toMatch(/^Expires: \d{4}-\d{2}-\d{2}T/m);
  });
});
