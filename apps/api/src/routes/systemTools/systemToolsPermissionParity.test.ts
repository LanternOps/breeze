/**
 * Regression coverage for the permission-parity fix: reading device content
 * back through the system-tools file/registry routes (not just listing it)
 * requires devices:execute, matching the AI tool path
 * (aiGuardrails.ts TOOL_PERMISSIONS file_operations.read/list and
 * registry_operations.read_key/get_value). Before the fix, the router-wide
 * GET->devices:read mapping in routes/systemTools/index.ts let a
 * devices:read-only role reach file content and registry values.
 *
 * Also covers the server-side deny that blocks the agent's own config/secrets
 * directory and the SAM/SECURITY registry hives outright, even for a caller
 * who does hold devices:execute.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  executeCommandMock,
  getDeviceMock,
  getUserPermissionsMock,
  authState,
} = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getDeviceMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  authState: {
    current: {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'reader@example.com',
      },
      scope: 'organization' as const,
      orgId: '22222222-2222-4222-8222-222222222222',
      partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    },
  },
}));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '55555555-5555-4555-8555-555555555555';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', authState.current);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: executeCommandMock,
  CommandTypes: {
    FILE_READ: 'FILE_READ',
    FILE_LIST: 'FILE_LIST',
    FILE_LIST_DRIVES: 'FILE_LIST_DRIVES',
    FILE_WRITE: 'FILE_WRITE',
    FILE_COPY: 'FILE_COPY',
    FILE_DELETE: 'FILE_DELETE',
    FILE_RENAME: 'FILE_RENAME',
    FILE_TRASH_LIST: 'FILE_TRASH_LIST',
    FILE_TRASH_RESTORE: 'FILE_TRASH_RESTORE',
    FILE_TRASH_PURGE: 'FILE_TRASH_PURGE',
    REGISTRY_KEYS: 'REGISTRY_KEYS',
    REGISTRY_VALUES: 'REGISTRY_VALUES',
    REGISTRY_GET: 'REGISTRY_GET',
    REGISTRY_SET: 'REGISTRY_SET',
    REGISTRY_DELETE: 'REGISTRY_DELETE',
    REGISTRY_KEY_CREATE: 'REGISTRY_KEY_CREATE',
    REGISTRY_KEY_DELETE: 'REGISTRY_KEY_DELETE',
  },
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(),
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: () => undefined,
}));

// Only the device lookup is mocked here — requireDevicesExecute (and
// isAgentConfigPath / isDeniedRegistryTarget once they exist) run for real,
// so this test exercises the actual permission gate rather than a stand-in.
vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    getDeviceWithOrgAndSiteCheck: getDeviceMock,
  };
});

// Only getUserPermissions is mocked — hasPermission/PERMISSIONS run for real
// so the test proves the actual grant-matching logic, not a stand-in.
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: getUserPermissionsMock,
  };
});

import { fileBrowserRoutes } from './fileBrowser';
import { registryRoutes } from './registry';

function readOnlyPerms() {
  return {
    permissions: [{ resource: 'devices', action: 'read' }],
    partnerId: null,
    orgId: ORG_ID,
    roleId: ROLE_ID,
    scope: 'organization' as const,
  };
}

function executePerms() {
  return {
    permissions: [
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'execute' },
    ],
    partnerId: null,
    orgId: ORG_ID,
    roleId: ROLE_ID,
    scope: 'organization' as const,
  };
}

function fileApp() {
  const instance = new Hono();
  instance.route('/', fileBrowserRoutes);
  return instance;
}

function registryApp() {
  const instance = new Hono();
  instance.route('/', registryRoutes);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  getDeviceMock.mockResolvedValue({
    id: DEVICE_ID,
    orgId: ORG_ID,
    siteId: null,
    hostname: 'device-1',
  });
});

describe('file download permission parity', () => {
  it('refuses a devices:read-only role', async () => {
    getUserPermissionsMock.mockResolvedValue(readOnlyPerms());

    const res = await fileApp().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent('/tmp/ordinary.txt')}`,
    );

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows a devices:execute role to read an ordinary path', async () => {
    getUserPermissionsMock.mockResolvedValue(executePerms());
    const bytes = Buffer.from('ordinary content', 'utf8');
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ path: '/tmp/ordinary.txt', content: bytes.toString('base64') }),
    });

    const res = await fileApp().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent('/tmp/ordinary.txt')}`,
    );

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    String.raw`C:\ProgramData\Breeze\secrets.yaml`,
    '/etc/breeze/secrets.yaml',
    '/Library/Application Support/Breeze/secrets.yaml',
    // Case and separator variants.
    String.raw`c:\PROGRAMDATA\BREEZE\SECRETS.YAML`,
    '/etc/breeze/agent.yaml',
  ])('denies the agent config/secrets directory even with devices:execute: %s', async (path) => {
    getUserPermissionsMock.mockResolvedValue(executePerms());

    const res = await fileApp().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent(path)}`,
    );

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});

describe('registry read permission parity', () => {
  it.each([
    ['keys', `/devices/${DEVICE_ID}/registry/keys?hive=HKEY_LOCAL_MACHINE&path=Software`],
    ['values', `/devices/${DEVICE_ID}/registry/values?hive=HKEY_LOCAL_MACHINE&path=Software`],
    ['value', `/devices/${DEVICE_ID}/registry/value?hive=HKEY_LOCAL_MACHINE&path=Software&name=Foo`],
  ])('refuses a devices:read-only role on %s', async (_label, path) => {
    getUserPermissionsMock.mockResolvedValue(readOnlyPerms());

    const res = await registryApp().request(path);

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows a devices:execute role to read an ordinary key', async () => {
    getUserPermissionsMock.mockResolvedValue(executePerms());
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ keys: [] }),
    });

    const res = await registryApp().request(
      `/devices/${DEVICE_ID}/registry/keys?hive=HKEY_LOCAL_MACHINE&path=Software`,
    );

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });

  it.each([
    ['SAM root', 'SAM'],
    ['SAM subkey', 'SAM\\Domains'],
    ['SECURITY root', 'SECURITY'],
    ['LSA secrets subkey', 'SECURITY\\Policy\\Secrets'],
    // Case and separator variants.
    ['lowercase, forward slash', 'sam/domains'],
    ['traversal collapses onto SAM', 'Software\\..\\SAM'],
  ])('denies %s even with devices:execute', async (_label, path) => {
    getUserPermissionsMock.mockResolvedValue(executePerms());

    const res = await registryApp().request(
      `/devices/${DEVICE_ID}/registry/keys?hive=HKEY_LOCAL_MACHINE&path=${encodeURIComponent(path)}`,
    );

    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('does not deny SAM/SECURITY under a non-HKLM hive', async () => {
    getUserPermissionsMock.mockResolvedValue(executePerms());
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ keys: [] }),
    });

    const res = await registryApp().request(
      `/devices/${DEVICE_ID}/registry/keys?hive=HKEY_CURRENT_USER&path=SAM`,
    );

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });
});
