/**
 * File upload, copy and move write files with the agent's own privileges, so
 * they require `scripts:execute` (the grant script execution needs) on top of
 * the router-wide `devices:execute`. Trash restore returns an item to the path
 * it was deleted from and stays at `devices:execute`.
 *
 * Drives the REAL `systemToolsRoutes` router with the real `hasPermission`
 * grant matching. Only the permission lookup, the device row and the agent
 * dispatch are stubbed.
 */
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
        user: { id: '11111111-1111-4111-8111-111111111111', email: 'tech@example.com' },
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

function post(path: string, body: unknown) {
  const instance = new Hono();
  instance.route('/system-tools', systemToolsRoutes);
  return instance.request(`/system-tools/devices/${DEVICE_ID}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const WRITE_ROUTES: Array<[string, string, unknown]> = [
  ['upload', '/files/upload', { path: '/tmp/report.txt', content: 'hello\n' }],
  ['copy', '/files/copy', { items: [{ sourcePath: '/tmp/report.txt', destPath: '/tmp/report-copy.txt' }] }],
  ['move', '/files/move', { items: [{ sourcePath: '/tmp/report.txt', destPath: '/tmp/archive/report.txt' }] }],
];

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

describe('file browser writes require scripts:execute', () => {
  it.each(WRITE_ROUTES)(
    '%s is refused for devices:execute without scripts:execute and dispatches nothing',
    async (_label, path, body) => {
      getUserPermissionsMock.mockResolvedValue(grants('devices:read', 'devices:execute'));

      const res = await post(path, body);

      expect(res.status).toBe(403);
      expect(executeCommandMock).not.toHaveBeenCalled();
    },
  );

  it.each(WRITE_ROUTES)(
    '%s is refused for scripts:execute without devices:execute',
    async (_label, path, body) => {
      getUserPermissionsMock.mockResolvedValue(grants('devices:read', 'scripts:execute'));

      const res = await post(path, body);

      expect(res.status).toBe(403);
      expect(executeCommandMock).not.toHaveBeenCalled();
    },
  );

  it.each(WRITE_ROUTES)(
    '%s dispatches for a role holding devices:execute and scripts:execute',
    async (_label, path, body) => {
      getUserPermissionsMock.mockResolvedValue(grants('devices:read', 'devices:execute', 'scripts:execute'));

      const res = await post(path, body);

      expect(res.status).not.toBe(403);
      expect(executeCommandMock).toHaveBeenCalled();
    },
  );

  it('trash restore stays at devices:execute', async () => {
    getUserPermissionsMock.mockResolvedValue(grants('devices:read', 'devices:execute'));

    const res = await post('/files/trash/restore', { trashIds: ['abc123'] });

    expect(res.status).not.toBe(403);
    expect(executeCommandMock).toHaveBeenCalled();
  });
});
