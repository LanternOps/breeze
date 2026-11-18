/**
 * POST /system-tools/devices/:deviceId/files/mkdir (#10975).
 *
 * Drives the REAL `systemToolsRoutes` router, so the org chokepoint, the site
 * ceiling and the permission gates run for real. Only the permission lookup,
 * the device row, the agent dispatch and the audit sink are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  executeCommandMock,
  getUserPermissionsMock,
  dbSelectMock,
  createAuditLogMock,
} = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  dbSelectMock: vi.fn(),
  createAuditLogMock: vi.fn(),
}));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG_ID = '66666666-6666-4666-8666-666666666666';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_SITE_ID = '77777777-7777-4777-8777-777777777777';
const ROLE_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '11111111-1111-4111-8111-111111111111';

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
        user: { id: USER_ID, email: 'tech@example.com' },
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

// Only the lookup is stubbed; hasPermission / canAccessSite run for real.
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
}));

// The real CommandTypes stay, so a test can pin the literal wire name.
vi.mock('../../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/commandQueue')>();
  return { ...actual, executeCommand: executeCommandMock };
});

vi.mock('../../services/auditService', () => ({
  createAuditLog: createAuditLogMock,
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

import { systemToolsRoutes } from './index';

function grants(specs: string[], extra: Record<string, unknown> = {}) {
  return {
    permissions: specs.map((s) => {
      const [resource, action] = s.split(':');
      return { resource: resource!, action: action! };
    }),
    partnerId: null,
    orgId: ORG_ID,
    roleId: ROLE_ID,
    scope: 'organization' as const,
    ...extra,
  };
}

const FULL_GRANTS = ['devices:read', 'devices:execute', 'scripts:execute'];

function deviceRow(overrides: Record<string, unknown> = {}) {
  return { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'device-1', ...overrides };
}

function mockDeviceRows(rows: unknown[]) {
  dbSelectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  });
}

function postRaw(body: string) {
  const instance = new Hono();
  instance.route('/system-tools', systemToolsRoutes);
  return instance.request(`/system-tools/devices/${DEVICE_ID}/files/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

function post(body: unknown) {
  return postRaw(JSON.stringify(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeviceRows([deviceRow()]);
  getUserPermissionsMock.mockResolvedValue(grants(FULL_GRANTS));
  executeCommandMock.mockResolvedValue({
    status: 'completed',
    stdout: JSON.stringify({ path: '/tmp/reports', created: true }),
  });
  createAuditLogMock.mockResolvedValue(undefined);
});

describe('POST /files/mkdir dispatch', () => {
  it('sends file_mkdir with the requested path and the caller as the actor', async () => {
    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    const [deviceId, commandType, payload, options] = executeCommandMock.mock.calls[0]!;
    expect(deviceId).toBe(DEVICE_ID);
    // The literal wire name the agent's handler table is keyed on.
    expect(commandType).toBe('file_mkdir');
    expect(payload).toEqual({ path: '/tmp/reports' });
    expect(options).toMatchObject({ userId: USER_ID });
  });

  it('answers with the path the agent normalized, not the one it was sent', async () => {
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ path: '/tmp/reports', created: true }),
    });

    const res = await post({ path: '/tmp//reports/' });

    expect(executeCommandMock.mock.calls[0]![2]).toEqual({ path: '/tmp//reports/' });
    expect(await res.json()).toEqual({ success: true, data: { path: '/tmp/reports' } });
  });

  it.each([
    ['unparseable stdout', 'not json'],
    ['no stdout', undefined],
    ['a non-string path', JSON.stringify({ path: 42 })],
  ])('falls back to the requested path on %s', async (_label, stdout) => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout });

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { path: '/tmp/reports' } });
  });
});

describe('POST /files/mkdir validation', () => {
  it.each([
    ['POSIX traversal', '/tmp/../etc/new'],
    ['Windows traversal', String.raw`C:\Temp\..\Windows\new`],
    ['a bare ..', '..'],
    ['a trailing ..', '/tmp/..'],
    ['a null byte', '/tmp/new\0folder'],
    ['an empty path', ''],
    ['an over-long path', `/${'a'.repeat(2048)}`],
    ['a non-string path', 42],
  ])('refuses %s without dispatching or auditing', async (_label, path) => {
    const res = await post({ path });

    expect(res.status).toBe(400);
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(createAuditLogMock).not.toHaveBeenCalled();
  });

  it('refuses a body with no path', async () => {
    const res = await post({});

    expect(res.status).toBe(400);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ['Windows', String.raw`C:\ProgramData\Breeze\new`],
    ['Windows, compatibility junction', String.raw`C:\Documents and Settings\All Users\Breeze\new`],
    ['Linux', '/etc/breeze/new'],
    ['macOS', '/Library/Application Support/Breeze/new'],
  ])('refuses the agent config directory (%s) outright', async (_label, path) => {
    const res = await post({ path });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'sensitive_path_denied' });
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});

describe('POST /files/mkdir authorization', () => {
  it('is refused for devices:execute without scripts:execute', async () => {
    getUserPermissionsMock.mockResolvedValue(grants(['devices:read', 'devices:execute']));

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(createAuditLogMock).not.toHaveBeenCalled();
  });

  it('is refused for scripts:execute without devices:execute', async () => {
    getUserPermissionsMock.mockResolvedValue(grants(['devices:read', 'scripts:execute']));

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a device in another org', async () => {
    mockDeviceRows([deviceRow({ orgId: OTHER_ORG_ID })]);

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(createAuditLogMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a device that does not exist', async () => {
    mockDeviceRows([]);

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('answers 403 for a device outside the caller\'s site ceiling', async () => {
    getUserPermissionsMock.mockResolvedValue(grants(FULL_GRANTS, { allowedSiteIds: [OTHER_SITE_ID] }));

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});

describe('POST /files/mkdir audit', () => {
  it('writes a success row naming the device and the path', async () => {
    await post({ path: '/tmp/reports' });

    expect(createAuditLogMock).toHaveBeenCalledTimes(1);
    expect(createAuditLogMock.mock.calls[0]![0]).toMatchObject({
      orgId: ORG_ID,
      actorId: USER_ID,
      actorEmail: 'tech@example.com',
      action: 'file_mkdir',
      resourceType: 'device',
      resourceId: DEVICE_ID,
      resourceName: 'device-1',
      details: { path: '/tmp/reports' },
      result: 'success',
    });
  });

  it('writes a failure row carrying the agent error', async () => {
    executeCommandMock.mockResolvedValue({
      status: 'failed',
      error: 'operation denied on system path: /proc/new',
      errorCode: 'system_path_denied',
    });

    await post({ path: '/proc/new' });

    expect(createAuditLogMock.mock.calls[0]![0]).toMatchObject({
      action: 'file_mkdir',
      result: 'failure',
      errorMessage: 'operation denied on system path: /proc/new',
    });
  });

  it('a failed audit write does not turn a completed mkdir into an error', async () => {
    createAuditLogMock.mockRejectedValue(new Error('audit backend unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('POST /files/mkdir agent failures', () => {
  it('surfaces an agent refusal as 422 with its reason', async () => {
    executeCommandMock.mockResolvedValue({
      status: 'failed',
      error: 'operation denied on system path: /proc/new',
      errorCode: 'system_path_denied',
    });

    const res = await post({ path: '/proc/new' });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'operation denied on system path: /proc/new',
      code: 'AGENT_COMMAND_REJECTED',
    });
  });

  it('surfaces a file system error with the agent\'s text', async () => {
    executeCommandMock.mockResolvedValue({
      status: 'failed',
      error: 'failed to create directory: mkdir /tmp/x: permission denied',
    });

    const res = await post({ path: '/tmp/x' });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: 'failed to create directory: mkdir /tmp/x: permission denied',
      code: 'AGENT_EXECUTION_FAILED',
    });
  });

  it('reports a timeout as unverified, in the response and in the audit trail', async () => {
    executeCommandMock.mockResolvedValue({ status: 'timeout', error: 'command timed out' });

    const res = await post({ path: '/tmp/reports' });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'AGENT_TIMEOUT', unverified: true });
    expect(body.error).toMatch(/may have completed/i);
    expect(createAuditLogMock.mock.calls[0]![0]).toMatchObject({
      result: 'failure',
      errorMessage: '[unverified] command timed out',
    });
  });

  it('never answers a status Cloudflare would replace', async () => {
    for (const result of [
      { status: 'failed', error: 'anything' },
      { status: 'timeout', error: 'command timed out' },
      { status: 'failed', error: 'Device is offline, cannot execute command' },
    ]) {
      executeCommandMock.mockResolvedValue(result);
      const res = await post({ path: '/tmp/reports' });
      expect([502, 504]).not.toContain(res.status);
    }
  });
});
