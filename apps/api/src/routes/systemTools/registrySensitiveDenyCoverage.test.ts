/**
 * Regression coverage: the registry read routes (GET keys/values/value)
 * already deny SAM/SECURITY regardless of permission, but the four
 * mutation routes (PUT/DELETE value, POST/DELETE key) did not — an
 * execute-tier caller could still write or delete under those hives
 * through the API even though the agent-side deny (once released) blocks
 * it. This proves the API-layer deny now covers writes too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { executeCommandMock, getDeviceMock } = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getDeviceMock: vi.fn(),
}));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'tech@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: executeCommandMock,
  CommandTypes: {
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
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: () => undefined,
}));

vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    getDeviceWithOrgAndSiteCheck: getDeviceMock,
  };
});

import { registryRoutes } from './registry';

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

describe('registry value mutation sensitive-path deny', () => {
  it('denies PUT value under HKLM\\SAM', async () => {
    const res = await registryApp().request(`/devices/${DEVICE_ID}/registry/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hive: 'HKEY_LOCAL_MACHINE', path: 'SAM\\Domains', name: 'foo', type: 'REG_SZ', data: 'bar' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies DELETE value under HKLM\\SECURITY', async () => {
    const res = await registryApp().request(
      `/devices/${DEVICE_ID}/registry/value?hive=HKEY_LOCAL_MACHINE&path=SECURITY%5CPolicy%5CSecrets&name=foo`,
      { method: 'DELETE' },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows PUT value for an ordinary path', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });

    const res = await registryApp().request(`/devices/${DEVICE_ID}/registry/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hive: 'HKEY_LOCAL_MACHINE', path: 'SOFTWARE\\Microsoft', name: 'foo', type: 'REG_SZ', data: 'bar' }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });
});

describe('registry key mutation sensitive-path deny', () => {
  it('denies POST key under HKLM\\SAM', async () => {
    const res = await registryApp().request(`/devices/${DEVICE_ID}/registry/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hive: 'HKEY_LOCAL_MACHINE', path: 'SAM\\NewKey' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies DELETE key under HKLM\\SECURITY', async () => {
    const res = await registryApp().request(
      `/devices/${DEVICE_ID}/registry/key?hive=HKEY_LOCAL_MACHINE&path=SECURITY`,
      { method: 'DELETE' },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows POST key for an ordinary path', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });

    const res = await registryApp().request(`/devices/${DEVICE_ID}/registry/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hive: 'HKEY_LOCAL_MACHINE', path: 'SOFTWARE\\NewKey' }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });
});
