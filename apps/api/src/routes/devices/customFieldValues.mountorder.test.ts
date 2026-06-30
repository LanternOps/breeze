import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Mount-order regression guard for #2066.
//
// The custom-field VALUE routes accept X-API-Key auth and MUST be mounted in
// devices/index.ts BEFORE coreRoutes (whose `.use('*', authMiddleware)` wildcard
// attaches to every route mounted after it). If a future edit reorders them
// below coreRoutes, the JWT-only authMiddleware would run ahead of the API-key
// branch and resurrect the 401. This test exercises the FULLY-ASSEMBLED
// deviceRoutes (not the router in isolation) so that reorder is caught: a
// real authMiddleware here throws 401 when no Bearer header is present.

const ORG_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const API_KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

// REAL-shaped authMiddleware: 401 without a Bearer header. This is what makes
// the reorder detectable — if coreRoutes' wildcard runs ahead of the API-key
// branch, the X-API-Key request (no Bearer) gets 401 here.
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
  apiKeyAuthMiddleware: vi.fn((c: any, next: any) => {
    c.set('apiKey', {
      id: API_KEY_ID,
      orgId: ORG_A,
      partnerId: null,
      name: 'Automation key',
      keyPrefix: 'brz_test',
      scopes: ['devices:write'],
      rateLimit: 1000,
      createdBy: 'user-1',
    });
    return next();
  }),
  requireApiKeyScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// Other device sub-routers pulled in by the assembled router import them at
// module load; stub the heavy ones so the import succeeds.
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

function rigDeviceLookup(device: unknown) {
  const limit = vi.fn().mockResolvedValue(device ? [device] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

function rigUpdate(updatedRow: unknown) {
  const returning = vi.fn().mockResolvedValue(updatedRow ? [updatedRow] : []);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
}

describe('custom-field value routes mount order (#2066)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  it('an X-API-Key PATCH reaches the handler through the assembled deviceRoutes (not 401)', async () => {
    rigDeviceLookup({ id: DEVICE_ID, orgId: ORG_A, siteId: null, hostname: 'WS', displayName: 'WS', customFields: {} });
    rigUpdate({ customFields: { note: 'hi' } });

    const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({ note: 'hi' }),
    });

    // The critical assertion: it is NOT 401. A reorder below coreRoutes' wildcard
    // authMiddleware would make this 401 (no Bearer header present).
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it('a no-credentials PATCH is still rejected (401) through the assembled routes', async () => {
    const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'hi' }),
    });

    expect(res.status).toBe(401);
  });
});
