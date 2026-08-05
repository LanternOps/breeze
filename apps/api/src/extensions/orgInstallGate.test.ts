import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { buildOrgInstallGuard, installScopeOf, resolveCallerOrgId } from './orgInstallGate';

function appWith(guard: ReturnType<typeof buildOrgInstallGuard>, seed?: (c: any) => void) {
  const app = new Hono();
  if (seed) app.use('*', async (c, next) => { seed(c); await next(); });
  app.use('*', guard);
  app.get('/hit', (c) => c.json({ ok: true }));
  return app;
}

describe('installScopeOf', () => {
  it('defaults to server when tenancy or installScope is absent', () => {
    expect(installScopeOf({})).toBe('server');
    expect(installScopeOf({ tenancy: {} })).toBe('server');
    expect(installScopeOf({ tenancy: { installScope: 'org' } })).toBe('org');
  });
});

describe('buildOrgInstallGuard', () => {
  it('server scope: passes through and NEVER consults the reader', async () => {
    const isInstalled = vi.fn(async () => false);
    const app = appWith(
      buildOrgInstallGuard({ extension: 'demo', installScope: 'server', isInstalled }),
      (c) => c.set('auth', { orgId: 'org-1' }),
    );
    const res = await app.request('/hit');
    expect(res.status).toBe(200);
    expect(isInstalled).not.toHaveBeenCalled();
  });

  it('org scope + installed org: passes', async () => {
    const app = appWith(
      buildOrgInstallGuard({ extension: 'demo', installScope: 'org', isInstalled: async () => true }),
      (c) => c.set('auth', { orgId: 'org-1' }),
    );
    expect((await app.request('/hit')).status).toBe(200);
  });

  it('org scope + non-installed org: 404 with the gateway not-found body', async () => {
    const app = appWith(
      buildOrgInstallGuard({ extension: 'demo', installScope: 'org', isInstalled: async () => false }),
      (c) => c.set('auth', { orgId: 'org-1' }),
    );
    const res = await app.request('/hit');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('org scope + no resolvable org (public route / partner-scope token): 404, fail closed', async () => {
    const isInstalled = vi.fn(async () => true);
    const app = appWith(
      buildOrgInstallGuard({ extension: 'demo', installScope: 'org', isInstalled }),
    );
    expect((await app.request('/hit')).status).toBe(404);
    expect(isInstalled).not.toHaveBeenCalled();
  });

  it('agent identity takes precedence over user auth for org resolution', async () => {
    const seen: string[] = [];
    const app = appWith(
      buildOrgInstallGuard({
        extension: 'demo',
        installScope: 'org',
        isInstalled: async (_ext, orgId) => { seen.push(orgId); return true; },
      }),
      (c) => {
        c.set('agent', { orgId: 'agent-org' });
        c.set('auth', { orgId: 'user-org' });
      },
    );
    await app.request('/hit');
    expect(seen).toEqual(['agent-org']);
  });

  it('a reader failure propagates (500), never silently denies as 404 or allows', async () => {
    const app = appWith(
      buildOrgInstallGuard({
        extension: 'demo',
        installScope: 'org',
        isInstalled: async () => { throw new Error('db down'); },
      }),
      (c) => c.set('auth', { orgId: 'org-1' }),
    );
    expect((await app.request('/hit')).status).toBe(500);
  });

  it('honors a custom deny body (the client-ai surface shape)', async () => {
    const app = appWith(
      buildOrgInstallGuard({
        extension: 'demo',
        installScope: 'org',
        isInstalled: async () => false,
        deny: (c) => c.json({ error: 'not found', code: 'extension_surface_not_found' }, 404),
      }),
      (c) => c.set('auth', { orgId: 'org-1' }),
    );
    const res = await app.request('/hit');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found', code: 'extension_surface_not_found' });
  });
});
