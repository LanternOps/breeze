/**
 * Every /system-tools route dispatches a live command to the device's agent —
 * listing processes, services, scheduled tasks, event logs, files and registry
 * keys included. Live device inspection therefore requires `devices:execute`
 * on every method, not just the mutating ones; `devices:read` alone keeps
 * cached/inventory reads (the device routes under /devices), not live ones.
 *
 * This drives the REAL `systemToolsRoutes` router (index.ts) with the real
 * `hasPermission` grant matching — only the permission lookup, the device row
 * and the agent dispatch are stubbed — so it proves the router-level gate, not
 * a stand-in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  executeCommandMock,
  getUserPermissionsMock,
  dbSelectMock,
} = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '55555555-5555-4555-8555-555555555555';

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com' },
        token: { roleId: ROLE_ID, mfa: true },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
      });
      await next();
    },
    requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

// Only the lookup is stubbed; hasPermission / PERMISSIONS run for real.
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/commandQueue')>();
  return { ...actual, executeCommand: executeCommandMock };
});

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(),
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

import { systemToolsRoutes } from './index';

function grants(...specs: string[]) {
  return {
    permissions: specs.map((s) => {
      const [resource, action] = s.split(':');
      return { resource: resource!, action: action! };
    }),
    partnerId: null,
    orgId: ORG_ID,
    roleId: ROLE_ID,
    scope: 'organization' as const,
  };
}

function app() {
  const instance = new Hono();
  instance.route('/system-tools', systemToolsRoutes);
  return instance;
}

/**
 * Every GET registered by a /system-tools sub-router, read from source so a
 * route added later is covered without editing this list.
 */
function registeredGetPaths(): string[] {
  const files = ['processes.ts', 'services.ts', 'registry.ts', 'eventLogs.ts', 'scheduledTasks.ts', 'fileBrowser.ts'];
  const paths = new Set<string>();
  for (const file of files) {
    const src = readFileSync(join(__dirname, file), 'utf8');
    for (const m of src.matchAll(/Routes\.get\(\s*'([^']+)'/g)) paths.add(m[1]!);
  }
  return [...paths].sort();
}

function concrete(path: string): string {
  return path.replace(':deviceId', DEVICE_ID).replace(/:[A-Za-z]+/g, 'x');
}

beforeEach(() => {
  vi.clearAllMocks();
  dbSelectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'device-1' }],
      }),
    }),
  });
  executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });
});

describe('/system-tools live reads require devices:execute', () => {
  const getPaths = registeredGetPaths();

  it('finds the live read routes in source (guards against a vacuous scan)', () => {
    expect(getPaths).toEqual(expect.arrayContaining([
      '/devices/:deviceId/files',
      '/devices/:deviceId/files/drives',
      '/devices/:deviceId/processes',
      '/devices/:deviceId/services',
      '/devices/:deviceId/registry/keys',
      '/devices/:deviceId/eventlogs',
      '/devices/:deviceId/tasks',
    ]));
    expect(getPaths.length).toBeGreaterThanOrEqual(17);
  });

  it.each(registeredGetPaths().map((p) => [p]))(
    'GET %s is refused for a devices:read-only role and dispatches nothing',
    async (path) => {
      getUserPermissionsMock.mockResolvedValue(grants('devices:read'));

      const res = await app().request(`/system-tools${concrete(path)}`);

      expect(res.status).toBe(403);
      expect(executeCommandMock).not.toHaveBeenCalled();
    },
  );

  it('a role with devices:read + devices:write (no execute) is still refused', async () => {
    getUserPermissionsMock.mockResolvedValue(grants('devices:read', 'devices:write'));

    const res = await app().request(`/system-tools/devices/${DEVICE_ID}/processes`);

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ['processes', `/devices/${DEVICE_ID}/processes`],
    ['services', `/devices/${DEVICE_ID}/services`],
    ['scheduled tasks', `/devices/${DEVICE_ID}/tasks`],
    ['event logs', `/devices/${DEVICE_ID}/eventlogs`],
    ['files', `/devices/${DEVICE_ID}/files?path=${encodeURIComponent('/tmp')}`],
    ['drives', `/devices/${DEVICE_ID}/files/drives`],
    ['registry keys', `/devices/${DEVICE_ID}/registry/keys?hive=HKEY_LOCAL_MACHINE&path=Software`],
  ])('a devices:execute role can still list %s', async (_label, path) => {
    getUserPermissionsMock.mockResolvedValue(grants('devices:read', 'devices:execute'));

    const res = await app().request(`/system-tools${path}`);

    expect(res.status).not.toBe(403);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
  });

  it('a wildcard (*:*) admin can still list processes', async () => {
    getUserPermissionsMock.mockResolvedValue(grants('*:*'));

    const res = await app().request(`/system-tools/devices/${DEVICE_ID}/processes`);

    expect(res.status).not.toBe(403);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
  });
});
