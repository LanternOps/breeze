import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Mount-order regression guard for the linked-device-profile routes (#2138),
// modeled on customFieldValues.mountorder.test.ts (#2066).
//
// linksRoutes MUST be mounted in devices/index.ts BEFORE coreRoutes: the
// static `/link-groups` path would otherwise be eaten by core's `/:id`
// matcher ("link-groups" is not a device id → core 400/404s and the entire
// feature's API surface dies while the isolated links.test.ts stays green).
// This test exercises the FULLY-ASSEMBLED deviceRoutes so a reorder is caught.

const ORG_A = '11111111-1111-4111-8111-111111111111';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      const header = c.req.header('Authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
      }
      c.set('auth', {
        user: { id: 'user-1', email: 't@example.com' },
        scope: 'organization',
        orgId: ORG_A,
        partnerId: null,
        accessibleOrgIds: [ORG_A],
        canAccessOrg: (orgId: string) => orgId === ORG_A,
        canAccessSite: () => true,
        orgCondition: () => undefined,
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn(() => async (c: any, next: any) => {
      c.set('permissions', { permissions: [], orgId: ORG_A, scope: 'organization' });
      return next();
    }),
    requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

vi.mock('../../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: vi.fn((_c: any, next: any) => next()),
  requireApiKeyScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// Heavy modules imported by the assembled router at module load.
vi.mock('../../services/auditEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auditEvents')>();
  return { ...actual, writeRouteAudit: vi.fn(), writeAuditEvent: vi.fn() };
});
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));
vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));
vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));
vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

import { deviceRoutes } from './index';
import { db } from '../../db';

/** A drizzle-select chain (.from().where()...) resolving to `rows`. */
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(res, rej);
  return chain;
}

describe('link-group routes mount order (#2138)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  it('GET /devices/link-groups reaches the links handler through the assembled deviceRoutes', async () => {
    // Groups query, then loadMembers query (empty group list → no member query,
    // but rig both to be safe).
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]) as never)
      .mockReturnValueOnce(selectChain([]) as never);

    const res = await app.request('/devices/link-groups', {
      headers: { Authorization: 'Bearer test-token' },
    });

    // The critical assertion: core's `/:id` matcher did NOT eat the static
    // path ("link-groups" is not a uuid — core would 400/404/500). The links
    // handler returns 200 with a data array.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('a no-credentials request is still rejected (401) through the assembled routes', async () => {
    const res = await app.request('/devices/link-groups');
    expect(res.status).toBe(401);
  });
});
