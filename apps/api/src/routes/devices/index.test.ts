import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

describe('device router mount order', () => {
  it('mounts the agent rollback sub-resource before core parameter routes', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const rollbackMount = source.indexOf("deviceRoutes.route('/', agentRollbackRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(rollbackMount).toBeGreaterThan(-1);
    expect(coreMount).toBeGreaterThan(rollbackMount);
  });

  it('mounts the Remove-dialog config route before core parameter routes (#3987)', () => {
    // `/removal-config` is a STATIC path under /devices. Mounted after
    // coreRoutes, core's `GET /:id` matcher would claim it and the Remove
    // dialog would fetch a 404 (or a 400 uuid error) instead of the window.
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("import { removalConfigRoutes } from './removalConfig'");
    const removalMount = source.indexOf("deviceRoutes.route('/', removalConfigRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(removalMount).toBeGreaterThan(-1);
    expect(coreMount).toBeGreaterThan(removalMount);
  });

  it('mounts the billing sub-resource after core parameter routes (#3205 W06)', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("import { billingRoutes } from './billing'");
    const billingMount = source.indexOf("deviceRoutes.route('/', billingRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(billingMount).toBeGreaterThan(-1);
    expect(billingMount).toBeGreaterThan(coreMount);
  });
});

// #6504: the PAM_ACTUATOR_ENABLED guard in actuateElevation.ts was registered
// as `actuateElevationRoutes.use('*', ...)`. Hono attaches a sub-router's
// wildcard middleware to every route mounted after it at the same base path
// (see the customFieldValuesRoutes comment above) — so with
// actuateElevationRoutes mounted before homebrewBootstrapRoutes (as in
// index.ts), the guard answered EVERY unmatched /devices/:id/* request with
// its 403, and made homebrew-bootstrap unreachable whenever the flag is
// unset (the production default). This suite mounts the two routers in the
// same relative order as index.ts and makes real requests through the
// compiled Hono app, so it reproduces the actual routing bug rather than
// just asserting mount order in source.
describe('PAM actuator guard scope (#6504)', () => {
  const DEVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let savedPamEnv: string | undefined;

  beforeEach(() => {
    savedPamEnv = process.env.PAM_ACTUATOR_ENABLED;
    delete process.env.PAM_ACTUATOR_ENABLED;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedPamEnv === undefined) {
      delete process.env.PAM_ACTUATOR_ENABLED;
    } else {
      process.env.PAM_ACTUATOR_ENABLED = savedPamEnv;
    }
    vi.doUnmock('../../db');
    vi.doUnmock('../../db/schema');
    vi.doUnmock('../../middleware/auth');
    vi.doUnmock('./helpers');
    vi.doUnmock('../../services/auditEvents');
    vi.doUnmock('../../services/partnerTrust.commands');
    vi.doUnmock('../../services/commandQueue');
    vi.doUnmock('../../services/commandAudit');
  });

  async function buildTestApp() {
    vi.doMock('../../db', () => ({
      runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
      withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
      withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      db: { select: vi.fn(), insert: vi.fn(), transaction: vi.fn() },
    }));

    vi.doMock('../../middleware/auth', () => ({
      authMiddleware: vi.fn((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: 'org-123',
          partnerId: null,
          accessibleOrgIds: ['org-123'],
          canAccessOrg: (orgId: string) => orgId === 'org-123',
          token: { mfa: true },
        });
        return next();
      }),
      requireScope: vi.fn(() => async (_c: any, next: any) => next()),
      requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
        c.set('permissions', {
          permissions: [{ resource, action }],
          partnerId: null,
          orgId: 'org-123',
          roleId: 'role-123',
          scope: 'organization',
        });
        return next();
      }),
      requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
    }));

    vi.doMock('./helpers', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./helpers')>()),
      getDeviceWithOrgCheck: vi.fn().mockResolvedValue(null),
    }));

    vi.doMock('../../services/auditEvents', () => ({
      writeRouteAudit: vi.fn(),
    }));

    vi.doMock('../../services/partnerTrust.commands', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../services/partnerTrust.commands')>()),
      assertDeviceExecuteAllowed: vi.fn(),
    }));

    vi.doMock('../../services/commandQueue', () => ({
      CommandTypes: { HOMEBREW_BOOTSTRAP: 'homebrew_bootstrap' },
      queueCommandForExecution: vi.fn().mockResolvedValue({
        command: { id: 'cmd-1', status: 'sent' },
      }),
    }));

    vi.doMock('../../services/commandAudit', () => ({
      commandAuditDetails: vi.fn((id: string, type: string) => ({ commandId: id, commandType: type })),
    }));

    const { actuateElevationRoutes } = await import('./actuateElevation');
    const { homebrewBootstrapRoutes } = await import('./homebrewBootstrap');

    const app = new Hono();
    // Same relative order as apps/api/src/routes/devices/index.ts:
    // actuateElevationRoutes mounted before homebrewBootstrapRoutes.
    app.route('/devices', actuateElevationRoutes);
    app.route('/devices', homebrewBootstrapRoutes);
    return app;
  }

  it('does not answer an unmatched /devices/:id/* path with the PAM 403', async () => {
    const app = await buildTestApp();

    const res = await app.request(`/devices/${DEVICE_ID}/no-such-route`, { method: 'GET' });

    expect(res.status).not.toBe(403);
    const body = await res.json().catch(() => null);
    expect(body?.error).not.toBe('PAM actuator is disabled');
  });

  it('leaves POST /devices/:id/homebrew-bootstrap reachable when PAM_ACTUATOR_ENABLED is unset', async () => {
    const app = await buildTestApp();

    const res = await app.request(`/devices/${DEVICE_ID}/homebrew-bootstrap`, { method: 'POST' });

    // The route's own auth/validation response (device not visible to caller,
    // per the getDeviceWithOrgCheck mock above) is fine — the PAM gate is not.
    expect(res.status).not.toBe(403);
    const body = await res.json().catch(() => null);
    expect(body?.error).not.toBe('PAM actuator is disabled');
  });
});
