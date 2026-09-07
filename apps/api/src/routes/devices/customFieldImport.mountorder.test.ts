import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Mount-order guard for the VALUES importer (#3257 W08), mirroring
 * `customFieldValues.mountorder.test.ts`.
 *
 * Two regressions this catches, both exercised through the FULLY-ASSEMBLED
 * `deviceRoutes` rather than the router in isolation:
 *
 *  1. **The import routes stop being reachable.** `/custom-fields/import` and
 *     `/custom-fields/import/preview` are static paths under `/devices`; a
 *     reorder that put them behind a `/:id` matcher would 404 them.
 *
 *  2. **The importer grows a wildcard.** `customFieldImportRoutes` uses
 *     PER-ROUTE middleware. If someone "simplifies" it to
 *     `.use('*', authMiddleware)`, that wildcard attaches to every route mounted
 *     AFTER it — and it is mounted directly after `customFieldValuesRoutes`, so
 *     the X-API-Key PATCH those routes exist for would start being handled by
 *     the JWT-only `authMiddleware` and 401 again (issue #2066). The API-key
 *     assertion below is that mutation's detector.
 */

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

// REAL-shaped authMiddleware: 401 without a Bearer header. That is what makes a
// leaked wildcard detectable on the X-API-Key request below.
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
        scope: 'partner',
        orgId: null,
        partnerId: '22222222-2222-4222-8222-222222222222',
        accessibleOrgIds: [ORG_A],
        canAccessOrg: (orgId: string) => orgId === ORG_A,
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn(() => async (c: any, next: any) => {
      c.set('permissions', { permissions: [], orgId: ORG_A, scope: 'partner' });
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

vi.mock('../../services/customFields/queries', () => ({
  loadVisibleCustomFieldDefinitions: vi.fn().mockResolvedValue([
    {
      id: 'def-note', fieldKey: 'note', name: 'note', type: 'text', options: null,
      // Literal, not ORG_A: a vi.mock factory is hoisted above the consts.
      deviceTypes: null, required: false, scriptWrite: false,
      orgId: '11111111-1111-4111-8111-111111111111', partnerId: null,
    },
  ]),
  persistDeviceCustomFieldValues: vi.fn().mockResolvedValue([]),
}));

// The importer service itself is exercised by its own suite; here it only has
// to prove the request REACHED the handler.
vi.mock('../../services/customFields/import/valueImport', () => ({
  previewDeviceCustomFieldImport: vi.fn().mockResolvedValue([]),
  commitDeviceCustomFieldImport: vi.fn().mockResolvedValue({
    appliedValues: 0, skippedValues: 0, failedValues: 0, rows: [], linksCreated: 0, errors: [],
  }),
}));
vi.mock('../../services/customFields/import/audit', () => ({
  writeCustomFieldDefinitionImportAudits: vi.fn(),
  writeCustomFieldValueImportAudits: vi.fn(),
}));

// Other device sub-routers pulled in by the assembled router import these at
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
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

function rigProjectionRead(updatedRow: { customFields: unknown } | null) {
  const limit = vi.fn().mockResolvedValue(updatedRow ? [updatedRow] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

const IMPORT_PATHS = ['/devices/custom-fields/import/preview', '/devices/custom-fields/import'];

const body = {
  rows: [{ hostname: 'wkstn-1', values: [{ target: { kind: 'customField', fieldKey: 'note' }, value: 'hi' }] }],
};

describe('custom-field import routes mount order (#3257 W08)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  it('both import routes reach their handler through the assembled deviceRoutes', async () => {
    for (const path of IMPORT_PATHS) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify(body),
      });
      // A reorder behind a `/:id` matcher would 404 here.
      expect(res.status).toBe(200);
    }
  });

  it('a no-credentials import POST is still rejected (401)', async () => {
    for (const path of IMPORT_PATHS) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
    }
  });

  it('an X-API-Key import POST is rejected (401) — deliberately no dualAuth branch', async () => {
    for (const path of IMPORT_PATHS) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'brz_test' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
    }
  });

  it('the sibling X-API-Key custom-field PATCH still reaches its handler (no wildcard leaked)', async () => {
    // The detector for "someone replaced the per-route middleware with
    // `.use('*', authMiddleware)`": that wildcard would attach to every route
    // mounted after this router and 401 this request (no Bearer header).
    rigDeviceLookup({ id: DEVICE_ID, orgId: ORG_A, siteId: null, hostname: 'WS', displayName: 'WS', customFields: {} });
    rigProjectionRead({ customFields: { note: 'hi' } });

    const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({ note: 'hi' }),
    });

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });
});
