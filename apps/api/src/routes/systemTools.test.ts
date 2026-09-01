import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { systemToolsRoutes } from './systemTools';

const mockExecuteCommand = vi.fn();

vi.mock('../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
  DEVICE_UNREACHABLE_ERROR: 'Device is not currently reachable over the live connection. Please try again in a moment.',
  SEND_RETRY_ATTEMPTS: 3,
  CommandTypes: {
    LIST_PROCESSES: 'LIST_PROCESSES',
    GET_PROCESS: 'GET_PROCESS',
    KILL_PROCESS: 'KILL_PROCESS',
    LIST_SERVICES: 'LIST_SERVICES',
    GET_SERVICE: 'GET_SERVICE',
    START_SERVICE: 'START_SERVICE',
    STOP_SERVICE: 'STOP_SERVICE',
    RESTART_SERVICE: 'RESTART_SERVICE',
    TASKS_LIST: 'TASKS_LIST',
    TASK_GET: 'TASK_GET',
    TASK_RUN: 'TASK_RUN',
    TASK_ENABLE: 'TASK_ENABLE',
    TASK_DISABLE: 'TASK_DISABLE',
    TASK_HISTORY: 'TASK_HISTORY',
    REGISTRY_KEYS: 'REGISTRY_KEYS',
    REGISTRY_VALUES: 'REGISTRY_VALUES',
    REGISTRY_GET: 'REGISTRY_GET',
    REGISTRY_SET: 'REGISTRY_SET',
    REGISTRY_DELETE: 'REGISTRY_DELETE',
    REGISTRY_KEY_CREATE: 'REGISTRY_KEY_CREATE',
    REGISTRY_KEY_DELETE: 'REGISTRY_KEY_DELETE',
    EVENT_LOGS_LIST: 'EVENT_LOGS_LIST',
    EVENT_LOGS_QUERY: 'EVENT_LOGS_QUERY',
    EVENT_LOG_GET: 'EVENT_LOG_GET',
    FILE_READ: 'FILE_READ',
    FILE_COPY: 'file_copy',
    FILE_LIST: 'file_list',
    FILE_WRITE: 'file_write',
    FILE_DELETE: 'file_delete',
    FILE_RENAME: 'file_rename',
    FILE_TRASH_LIST: 'file_trash_list',
    FILE_TRASH_RESTORE: 'file_trash_restore',
    FILE_TRASH_PURGE: 'file_trash_purge',
  }
}));

vi.mock('../services/auditService', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
  // The file-download handler now records a sensitive-read audit, which reaches
  // auditEvents -> createAuditLogAsync. Without this export the mock's getter
  // throws and the audit chokepoint has to swallow it, so the route would never
  // exercise the real audit path.
  createAuditLogAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../db/schema', () => ({
  devices: {},
  organizations: {},
  auditLogs: {},
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {}
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({
    settings: { webrtcDesktop: true, vncRelay: true, remoteTools: true, enableProxy: true, defaultAllowedPorts: [], autoEnableProxy: false, maxConcurrentTunnels: 5, idleTimeoutMinutes: 5, maxSessionDurationHours: 8 },
    policyName: null,
    policyId: null,
  }),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      token: {
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-123',
        orgId: 'org-123',
        partnerId: null,
        scope: 'organization',
        type: 'access',
        mfa: true,
      },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<unknown>) => next()),
  requireMfa: vi.fn(() => async (_c: unknown, next: () => Promise<unknown>) => next()),
}));

vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(async () => ({
    permissions: [{ resource: '*', action: '*' }],
    partnerId: null,
    orgId: 'org-123',
    roleId: 'role-123',
    scope: 'organization',
  })),
  hasPermission: vi.fn(() => true),
  canAccessSite: vi.fn((permissions: { allowedSiteIds?: string[] }, siteId: string) =>
    permissions.allowedSiteIds?.includes(siteId) ?? true
  ),
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  }
}));

import { db } from '../db';
import { createAuditLog } from '../services/auditService';
import { getUserPermissions } from '../services/permissions';

describe('system tools routes', () => {
  let app: Hono;
  const deviceId = '11111111-1111-1111-1111-111111111111';
  const deviceRecord = { id: deviceId, orgId: 'org-123', siteId: 'site-allowed', hostname: 'device-1' };

  const mockDeviceSelect = (device = deviceRecord) => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(device ? [device] : [])
        })
      })
    } as any);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/system-tools', systemToolsRoutes);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    } as any);
  });

  it('lists processes via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        processes: [{ pid: 10, name: 'node', cpuPercent: 1, memoryMB: 32 }],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/processes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('denies system tool commands when site scope excludes the device', async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce({
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-123',
      scope: 'organization',
      allowedSiteIds: ['site-allowed']
    } as never);
    mockDeviceSelect({ ...deviceRecord, siteId: 'site-denied' });

    const res = await app.request(`/system-tools/devices/${deviceId}/processes`);

    expect(res.status).toBe(403);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  // Site-scope coverage across every systemTools sub-cluster. The contract
  // test (`site-scope-coverage.integration.test.ts`) statically checks each
  // handler references a gate; these tests verify the gate actually rejects
  // cross-site requests at runtime. Mirrors Task 35 sweep.
  it.each([
    ['fileBrowser:list', `/system-tools/devices/${'11111111-1111-1111-1111-111111111111'}/files?path=%2Ftmp`],
    ['fileBrowser:drives', `/system-tools/devices/${'11111111-1111-1111-1111-111111111111'}/files/drives`],
    ['fileBrowser:trash', `/system-tools/devices/${'11111111-1111-1111-1111-111111111111'}/files/trash`],
    ['services:list', `/system-tools/devices/${'11111111-1111-1111-1111-111111111111'}/services`],
    ['registry:keys', `/system-tools/devices/${'11111111-1111-1111-1111-111111111111'}/registry/keys?keyPath=HKLM%5CSoftware`],
    ['scheduledTasks:list', `/system-tools/devices/${'11111111-1111-1111-1111-111111111111'}/tasks`],
    ['eventLogs:list', `/system-tools/devices/${'11111111-1111-1111-1111-111111111111'}/eventlogs`],
  ])('site-scope denies %s when caller is restricted to a different site', async (_label, path) => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce({
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-123',
      scope: 'organization',
      allowedSiteIds: ['site-allowed'],
    } as never);
    // The chokepoint middleware in systemTools/index.ts is the first gate to
    // reject; mock the device row once for that lookup.
    mockDeviceSelect({ ...deviceRecord, siteId: 'site-denied' });

    const res = await app.request(path);
    expect(res.status).toBe(403);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it('returns 500 on invalid process payload from agent', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: '{not-json'
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/processes`);

    // 500, not 502: an origin 502 body is replaced by Cloudflare's branded
    // error page on hosted deployments, so the client can never read this.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Failed to parse agent response');
    expect(body.code).toBe('invalid_agent_response');
  });

  it('gets process details via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        pid: 2048,
        name: 'svchost.exe',
        cpuPercent: 0.2,
        memoryMb: 84
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/processes/2048`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.pid).toBe(2048);
    expect(body.data.name).toBe('svchost.exe');
  });

  it('kills a process and logs audit', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ name: 'chrome.exe' })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/processes/3456/kill?force=true`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain('chrome.exe');
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('lists services via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        services: [{ name: 'WinRM', displayName: 'Windows Remote Management', status: 'Running', startupType: 'Automatic' }],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/services`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe('running');
    expect(body.data[0].startType).toBe('auto');
    expect(body.meta.total).toBe(1);
  });

  it('forwards a high services limit and clamps it to the route maximum (500)', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ services: [], total: 0, page: 1, limit: 500, totalPages: 0 })
    });

    // The web Services tab requests ?limit=500 to fetch the full list in one
    // request; values above the route cap must clamp to 500, not fall back to 50.
    await app.request(`/system-tools/devices/${deviceId}/services?limit=500`);
    expect(mockExecuteCommand).toHaveBeenLastCalledWith(
      deviceId,
      'LIST_SERVICES',
      expect.objectContaining({ limit: 500 }),
      expect.anything()
    );

    await app.request(`/system-tools/devices/${deviceId}/services?limit=600`);
    expect(mockExecuteCommand).toHaveBeenLastCalledWith(
      deviceId,
      'LIST_SERVICES',
      expect.objectContaining({ limit: 500 }),
      expect.anything()
    );
  });

  it('gets service details via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        name: 'WinRM',
        displayName: 'Windows Remote Management',
        status: 'Stopped',
        startupType: 'Manual',
        account: 'LocalSystem'
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('WinRM');
    expect(body.data.status).toBe('stopped');
    expect(body.data.startType).toBe('manual');
  });

  it('starts a service via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ success: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM/start`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('stops a service via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ success: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM/stop`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('restarts a service via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ success: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM/restart`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  describe('agent self-protection for BreezeAgent service', () => {
    it('relays agent rejection when stopping the BreezeAgent service', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'failed',
        error: 'Cannot stop the Breeze agent service: operation blocked by self-protection'
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/services/BreezeAgent/stop`, {
        method: 'POST'
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('self-protection');
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'stop_service',
          result: 'failure',
          errorMessage: expect.stringContaining('self-protection')
        })
      );
    });

    it('succeeds with delayed restart for the BreezeAgent service', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({ success: true, delayed: true })
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/services/BreezeAgent/restart`, {
        method: 'POST'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('BreezeAgent');
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'restart_service',
          result: 'success'
        })
      );
    });

    it('logs audit with failure result when stop is blocked', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'failed',
        error: 'Cannot stop the Breeze agent service: operation blocked by self-protection'
      });

      await app.request(`/system-tools/devices/${deviceId}/services/BreezeAgent/stop`, {
        method: 'POST'
      });

      expect(createAuditLog).toHaveBeenCalledTimes(1);
      const auditCall = vi.mocked(createAuditLog).mock.calls[0]![0];
      expect(auditCall).toMatchObject({
        action: 'stop_service',
        resourceType: 'device',
        resourceId: deviceId,
        details: { name: 'BreezeAgent' },
        result: 'failure'
      });
    });

    it('logs audit with success result when restart is accepted', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({ success: true, delayed: true })
      });

      await app.request(`/system-tools/devices/${deviceId}/services/BreezeAgent/restart`, {
        method: 'POST'
      });

      expect(createAuditLog).toHaveBeenCalledTimes(1);
      const auditCall = vi.mocked(createAuditLog).mock.calls[0]![0];
      expect(auditCall).toMatchObject({
        action: 'restart_service',
        resourceType: 'device',
        resourceId: deviceId,
        details: { name: 'BreezeAgent' },
        result: 'success'
      });
    });
  });

  it('lists registry keys', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        keys: [
          { name: 'Microsoft', path: 'SOFTWARE\\Microsoft', subKeyCount: 10, valueCount: 0 },
          { name: 'Policies', path: 'SOFTWARE\\Policies', subKeyCount: 2, valueCount: 1 }
        ]
      })
    });

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/keys?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].name).toBe('Microsoft');
  });

  it('lists registry values', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        values: [
          { name: '', type: 'REG_SZ', data: '' },
          { name: 'InstallDate', type: 'REG_DWORD', data: '1704067200' },
          { name: 'Bin', type: 'REG_BINARY', data: '00 01 0A FF' }
        ]
      })
    });

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/values?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].name).toBe('(Default)');
    expect(body.data[1].data).toBe(1704067200);
    expect(body.data[2].data).toEqual([0, 1, 10, 255]);
  });

  it('gets registry value details', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        name: 'ProductName',
        type: 'REG_SZ',
        data: 'Windows 11 Pro'
      })
    });

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/value?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE&name=ProductName`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('ProductName');
  });

  it('sets a registry value and logs audit', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ success: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/registry/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hive: 'HKEY_LOCAL_MACHINE',
        path: 'SOFTWARE',
        name: 'TestValue',
        type: 'REG_SZ',
        data: 'Hello'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('deletes a registry value and logs audit', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true })
    });

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/value?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE&name=TestValue`,
      { method: 'DELETE' }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('creates a registry key and logs audit', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ created: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/registry/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hive: 'HKEY_LOCAL_MACHINE',
        path: 'SOFTWARE\\Breeze'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('deletes a registry key and logs audit', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true })
    });

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/key?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE\\Breeze`,
      { method: 'DELETE' }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('lists event logs via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        logs: [
          { name: 'System', displayName: 'System', recordCount: 1000 },
          { name: 'Application', displayName: 'Application', recordCount: 800 }
        ]
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/eventlogs`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].name).toBe('System');
  });

  it('queries event logs via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        events: [
          {
            recordId: 15234,
            timeCreated: '2026-02-08T10:00:00.000Z',
            level: 'Error',
            source: 'Service Control Manager',
            eventId: 7001,
            message: 'A service failed to start',
            computer: 'KIT',
            userId: 'S-1-5-18'
          }
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1
      })
    });

    const res = await app.request(
      `/system-tools/devices/${deviceId}/eventlogs/System/events?level=critical&eventId=6008`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].recordId).toBe(15234);
    expect(body.meta.total).toBe(1);
  });

  it('gets event log details via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        recordId: 15234,
        timeCreated: '2026-02-08T10:00:00.000Z',
        level: 'Warning',
        source: 'Kernel-General',
        eventId: 16,
        message: 'The access history in hive was cleared',
        computer: 'KIT',
        userId: 'S-1-5-18'
      })
    });

    const res = await app.request(
      `/system-tools/devices/${deviceId}/eventlogs/System/events/15234`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.recordId).toBe(15234);
    expect(body.data.level).toBe('warning');
  });

  it('lists scheduled tasks via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        tasks: [{
          name: 'Windows Defender Scheduled Scan',
          path: '\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan',
          status: 'ready',
          lastRun: '2026-02-08T09:00:00.000Z',
          nextRun: '2026-02-09T09:00:00.000Z',
          author: 'Microsoft Corporation',
          description: 'Scans for malicious software',
          triggers: ['Daily']
        }],
        total: 1,
        page: 1,
        limit: 2,
        totalPages: 1
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks?limit=2&page=1`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].state).toBe('ready');
    expect(body.meta.total).toBe(1);
  });

  it('returns 500 on invalid scheduled task payload from agent', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: '{not-json'
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks?limit=2&page=1`);

    // 500, not 502: an origin 502 body is replaced by Cloudflare's branded
    // error page on hosted deployments, so the client can never read this.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Failed to parse agent response');
    expect(body.code).toBe('invalid_agent_response');
  });

  it('gets task details via agent command', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan');
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        name: 'Windows Defender Scheduled Scan',
        path: '\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan',
        status: 'running',
        lastRun: '2026-02-08T09:00:00.000Z',
        nextRun: '2026-02-09T09:00:00.000Z',
        triggers: ['Daily']
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toContain('Windows Defender Scheduled Scan');
    expect(body.data.state).toBe('running');
  });

  it('runs task via agent command', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan');
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ success: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}/run`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('enables task via agent command', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Backup\\Daily Backup');
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ success: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}/enable`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('disables task via agent command', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Microsoft\\Windows\\WindowsUpdate\\Scheduled Start');
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ success: true })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}/disable`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(createAuditLog).toHaveBeenCalled();
  });

  it('gets scheduled task history via agent command', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan');
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        path: '\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan',
        total: 1,
        history: [{
          id: '321',
          eventId: 102,
          timestamp: '2026-02-08T09:30:00.000Z',
          level: 'Information',
          message: 'Task completed',
          resultCode: 0
        }]
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}/history?limit=10`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].level).toBe('info');
    expect(body.data[0].resultCode).toBe(0);
  });

  it('downloads file content via agent command', async () => {
    mockDeviceSelect();
    const encoded = Buffer.from('hello from device', 'utf8').toString('base64');
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        path: '/tmp/example.txt',
        size: 17,
        encoding: 'base64',
        content: encoded
      })
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/files/download?path=%2Ftmp%2Fexample.txt`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('example.txt');
    const content = Buffer.from(await res.arrayBuffer()).toString('utf8');
    expect(content).toBe('hello from device');
  });

  describe('POST /files/copy', () => {
    it('returns 404 when device not found', async () => {
      mockDeviceSelect(null as any);
      const res = await app.request(`/system-tools/devices/${deviceId}/files/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ sourcePath: '/tmp/a.txt', destPath: '/tmp/b.txt' }]
        })
      });
      expect(res.status).toBe(404);
    });

    it('returns results for successful copy', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({ success: true })
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/files/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ sourcePath: '/tmp/a.txt', destPath: '/tmp/b.txt' }]
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('success');
      expect(body.results[0].sourcePath).toBe('/tmp/a.txt');
      expect(body.results[0].destPath).toBe('/tmp/b.txt');
    });

    it('handles failed copy operation', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'failed',
        error: 'Permission denied'
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/files/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ sourcePath: '/tmp/a.txt', destPath: '/tmp/b.txt' }]
        })
      });

      // 200 even when every item failed: the batch WAS processed, and the
      // per-item detail below is the payload that matters. Answering 502 got
      // this body replaced by Cloudflare's branded page, so the UI could only
      // say "Copy failed" with no per-item reason at all.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('failure');
      expect(body.results[0].error).toBe('Permission denied');
      expect(body.results[0].code).toBe('agent_execution_failed');
    });
  });

  describe('POST /files/move', () => {
    it('returns 404 when device not found', async () => {
      mockDeviceSelect(null as any);
      const res = await app.request(`/system-tools/devices/${deviceId}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ sourcePath: '/tmp/old.txt', destPath: '/tmp/new.txt' }]
        })
      });
      expect(res.status).toBe(404);
    });

    it('returns results for successful move', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({ success: true })
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ sourcePath: '/tmp/old.txt', destPath: '/tmp/new.txt' }]
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('success');
      expect(body.results[0].sourcePath).toBe('/tmp/old.txt');
      expect(body.results[0].destPath).toBe('/tmp/new.txt');
    });
  });

  describe('POST /files/delete', () => {
    it('returns 404 when device not found', async () => {
      mockDeviceSelect(null as any);
      const res = await app.request(`/system-tools/devices/${deviceId}/files/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths: ['/tmp/delete-me.txt']
        })
      });
      expect(res.status).toBe(404);
    });

    it('returns results for successful delete', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({ success: true })
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/files/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths: ['/tmp/delete-me.txt']
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('success');
      expect(body.results[0].path).toBe('/tmp/delete-me.txt');
    });
  });

  describe('GET /files/trash', () => {
    it('returns 404 when device not found', async () => {
      mockDeviceSelect(null as any);
      const res = await app.request(`/system-tools/devices/${deviceId}/files/trash`);
      expect(res.status).toBe(404);
    });

    it('returns trash items', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({
          items: [
            { trashId: 'trash-1', originalPath: '/tmp/deleted.txt', deletedAt: '2026-02-08T10:00:00.000Z', size: 1024 },
            { trashId: 'trash-2', originalPath: '/tmp/old.log', deletedAt: '2026-02-07T08:00:00.000Z', size: 512 }
          ]
        })
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/files/trash`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].trashId).toBe('trash-1');
      expect(body.data[1].originalPath).toBe('/tmp/old.log');
    });
  });

  describe('POST /files/trash/restore', () => {
    it('returns 404 when device not found', async () => {
      mockDeviceSelect(null as any);
      const res = await app.request(`/system-tools/devices/${deviceId}/files/trash/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trashIds: ['trash-1']
        })
      });
      expect(res.status).toBe(404);
    });

    it('returns results for successful restore', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({ restoredPath: '/tmp/restored.txt' })
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/files/trash/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trashIds: ['trash-1']
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('success');
      expect(body.results[0].trashId).toBe('trash-1');
      expect(body.results[0].restoredPath).toBe('/tmp/restored.txt');
    });
  });

  describe('POST /files/trash/purge', () => {
    it('returns 404 when device not found', async () => {
      mockDeviceSelect(null as any);
      const res = await app.request(`/system-tools/devices/${deviceId}/files/trash/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trashIds: ['trash-1']
        })
      });
      expect(res.status).toBe(404);
    });

    it('returns success for purge', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({ purged: 3 })
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/files/trash/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trashIds: ['trash-1', 'trash-2', 'trash-3']
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.purged).toBe(3);
    });
  });

  // Issue #4025. Every systemTools route outside the File Browser tested
  // `result.status === 'failed'` and nothing else, so a `status: 'timeout'`
  // result fell straight through into the success path:
  //
  //   - `kill_process` answered `{ success: true, "Process N terminated
  //     successfully" }` when the agent never replied — while the audit row it
  //     had just written said `result: 'failure'`. The trail and the response
  //     actively contradicted each other about whether a device was mutated.
  //   - Every listing parsed `undefined` stdout as `{}` and returned HTTP 200
  //     with an empty array, so a technician read "no processes running" off a
  //     device that simply did not answer in time.
  //
  // These routes now share the File Browser's classifier. The table below
  // covers every one of the 25 sites so a new route cannot regress silently.
  describe('agent timeout is never reported as success (#4025)', () => {
    const taskPath = encodeURIComponent('\\Backup\\Daily Backup');
    const registryQs = 'hive=HKEY_LOCAL_MACHINE&path=SOFTWARE';
    const jsonPost = (body: unknown) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    type RouteCase = {
      label: string;
      path: string;
      init?: RequestInit;
      /** Route changes device state → response must warn the result is unverified. */
      mutating: boolean;
      /** `action` on the audit row a mutating route writes. */
      audit?: string;
    };

    const routes: RouteCase[] = [
      // processes.ts
      { label: 'processes:list', path: '/processes', mutating: false },
      { label: 'processes:get', path: '/processes/2048', mutating: false },
      { label: 'processes:kill', path: '/processes/3456/kill?force=true', init: { method: 'POST' }, mutating: true, audit: 'kill_process' },
      // services.ts
      { label: 'services:list', path: '/services', mutating: false },
      { label: 'services:get', path: '/services/WinRM', mutating: false },
      { label: 'services:start', path: '/services/WinRM/start', init: { method: 'POST' }, mutating: true, audit: 'start_service' },
      { label: 'services:stop', path: '/services/WinRM/stop', init: { method: 'POST' }, mutating: true, audit: 'stop_service' },
      { label: 'services:restart', path: '/services/WinRM/restart', init: { method: 'POST' }, mutating: true, audit: 'restart_service' },
      // registry.ts
      { label: 'registry:keys', path: `/registry/keys?${registryQs}`, mutating: false },
      { label: 'registry:values', path: `/registry/values?${registryQs}`, mutating: false },
      { label: 'registry:value:get', path: `/registry/value?${registryQs}&name=ProductName`, mutating: false },
      {
        label: 'registry:value:set',
        path: '/registry/value',
        init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hive: 'HKEY_LOCAL_MACHINE', path: 'SOFTWARE', name: 'TestValue', type: 'REG_SZ', data: 'Hello' }),
        },
        mutating: true,
        audit: 'set_registry_value',
      },
      { label: 'registry:value:delete', path: `/registry/value?${registryQs}&name=TestValue`, init: { method: 'DELETE' }, mutating: true, audit: 'delete_registry_value' },
      { label: 'registry:key:create', path: '/registry/key', init: jsonPost({ hive: 'HKEY_LOCAL_MACHINE', path: 'SOFTWARE\\Breeze' }), mutating: true, audit: 'create_registry_key' },
      { label: 'registry:key:delete', path: `/registry/key?${registryQs}\\Breeze`, init: { method: 'DELETE' }, mutating: true, audit: 'delete_registry_key' },
      // eventLogs.ts
      { label: 'eventLogs:list', path: '/eventlogs', mutating: false },
      { label: 'eventLogs:info', path: '/eventlogs/System', mutating: false },
      { label: 'eventLogs:query', path: '/eventlogs/System/events', mutating: false },
      { label: 'eventLogs:get', path: '/eventlogs/System/events/15234', mutating: false },
      // scheduledTasks.ts
      { label: 'tasks:list', path: '/tasks', mutating: false },
      { label: 'tasks:get', path: `/tasks/${taskPath}`, mutating: false },
      { label: 'tasks:history', path: `/tasks/${taskPath}/history?limit=10`, mutating: false },
      { label: 'tasks:run', path: `/tasks/${taskPath}/run`, init: { method: 'POST' }, mutating: true, audit: 'run_scheduled_task' },
      { label: 'tasks:enable', path: `/tasks/${taskPath}/enable`, init: { method: 'POST' }, mutating: true, audit: 'enable_scheduled_task' },
      { label: 'tasks:disable', path: `/tasks/${taskPath}/disable`, init: { method: 'POST' }, mutating: true, audit: 'disable_scheduled_task' },
    ];

    // Cross-reference the table against the SOURCE, not against itself.
    //
    // `expect(routes).toHaveLength(25)` was the first version of this and it
    // was a lie: the array literal is declared 40 lines up, so the assertion
    // only fails if someone deletes a row — never if someone adds a route to
    // one of the five files without a row here, which is the case the guard
    // exists for. Proven by adding a 26th real call site and watching the
    // suite stay green.
    //
    // Reading the files is what makes it a guard. Every `executeCommand` in
    // these five modules must be followed by an `isCommandFailure` gate, and
    // the table must have one row per gate.
    it('has one row per agent command in the five converted route files', () => {
      const files = ['processes', 'services', 'registry', 'eventLogs', 'scheduledTasks'];
      const ungated: string[] = [];
      let dispatchTotal = 0;

      for (const name of files) {
        const src = readFileSync(join(__dirname, 'systemTools', `${name}.ts`), 'utf8');

        // Pair each dispatch with the text that FOLLOWS it, up to the next
        // dispatch. Counting `executeCommand`s and `isCommandFailure`s
        // separately and comparing the totals would let one route grow a
        // second gate while another loses its only one — the totals still
        // balance and #4025 walks back in. Matching on a bare
        // `isCommandFailure(` reference rather than a full `if (…) {` also
        // keeps this from red-flagging the `!isCommandFailure(result)` idiom
        // fileBrowser.ts uses, which is equally correct.
        const segments = src.split(/await executeCommand\(/).slice(1);
        dispatchTotal += segments.length;

        segments.forEach((segment, index) => {
          if (!/isCommandFailure\(/.test(segment)) {
            ungated.push(`${name}.ts dispatch #${index + 1}`);
          }
        });
      }

      // A dispatch with no failure gate before the next one is a route that
      // can still report an agent timeout as success.
      expect(ungated, `agent commands with no isCommandFailure gate: ${ungated.join(', ')}`).toEqual([]);

      expect(routes, `source has ${dispatchTotal} agent commands; the table has ${routes.length} rows`)
        .toHaveLength(dispatchTotal);
    });

    it.each(routes)('$label answers 503 agent_timeout, never a success', async ({ path, init, mutating }) => {
      mockDeviceSelect();
      // `stdout` is absent on a timeout — exactly what used to parse to `{}`
      // and become an empty listing or a "terminated successfully" message.
      mockExecuteCommand.mockResolvedValue({ status: 'timeout', error: 'Command timed out' });

      const res = await app.request(`/system-tools/devices/${deviceId}${path}`, init);

      // 503, not 502/504: Cloudflare replaces an origin 502/504 body with its
      // own branded page, which would blank this message on hosted.
      // These two lines are what actually pin #4025: pre-fix the route
      // answered 200 with a success body, so `status` and `code` are the
      // assertions that go red. The shape checks below them document the
      // contract but can never be the ones that catch the bug — vitest stops
      // at the first failure, so they are never reached in a red run.
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('agent_timeout');
      expect(body.error).toContain("didn't respond in time");
      expect(body.success).toBeUndefined();
      expect(body.data).toBeUndefined();
      expect(body.message).toBeUndefined();
      // Only a state-changing route can leave the device in an unknown state.
      expect(body.unverified).toBe(mutating ? true : undefined);
    });

    it.each(routes.filter((route) => route.mutating))(
      '$label warns the operation may have completed, and tags its audit row',
      async ({ path, init, audit }) => {
        mockDeviceSelect();
        mockExecuteCommand.mockResolvedValue({ status: 'timeout', error: 'Command timed out' });

        const res = await app.request(`/system-tools/devices/${deviceId}${path}`, init);
        const body = await res.json();

        // Re-running a kill/registry-delete/service-stop against a
        // half-completed state can compound the damage, so the copy must tell
        // the user to verify rather than "please try again".
        expect(body.error).toContain('may have completed');
        expect(body.error).not.toContain('Please try again');

        // The audit trail must agree with the response that the device's final
        // state was never confirmed. Asserted for all 11 mutating routes, not
        // just kill_process: the `[unverified]` marker on a timed-out registry
        // key delete or service stop is exactly the breadcrumb an admin needs
        // to answer "did this actually happen on the device?", and it could
        // previously be dropped from ten of them with a green suite.
        expect(createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: audit,
            result: 'failure',
            errorMessage: expect.stringContaining('[unverified]'),
          }),
        );
      },
    );

    it('kill_process no longer contradicts its own audit row', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({ status: 'timeout', error: 'Command timed out' });

      const res = await app.request(
        `/system-tools/devices/${deviceId}/processes/3456/kill?force=true`,
        { method: 'POST' },
      );

      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.success).toBeUndefined();
      expect(body.message).toBeUndefined();

      // The audit row already said 'failure' before this fix; the response now
      // agrees, and the trail is tagged so an admin reviewing it can see the
      // device's final state was never confirmed.
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'kill_process',
          result: 'failure',
          errorMessage: expect.stringContaining('[unverified]'),
        }),
      );
    });

    // The queue can report a timeout as a plain `failed` with timeout-shaped
    // prose. Testing `status === 'timeout'` literally in the routes would miss
    // it and present an unverifiable mutation as a verified failure that is
    // safe to retry — the same trap fixed in `buildBulkItemFailure`.
    it('treats a prose-only timeout on a mutating route as unverified', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({ status: 'failed', error: 'command timed out after 30s' });

      const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM/stop`, {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('agent_timeout');
      expect(body.unverified).toBe(true);
    });

    it('still surfaces a real agent failure as a 500 with the agent message', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({ status: 'failed', error: 'access is denied' });

      const res = await app.request(`/system-tools/devices/${deviceId}/registry/keys?${registryQs}`);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('access is denied');
      expect(body.code).toBe('agent_execution_failed');
      expect(body.unverified).toBeUndefined();
    });

    it('keeps the 404 the routes used to derive from a "not found" substring', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({ status: 'failed', error: 'service not found: WinRM' });

      const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe('path_not_found');
    });

    // Verbatim from commandQueue.ts:832,1013 — `Device is ${device.status},
    // cannot execute command`. Using the real producer string rather than a
    // paraphrase is the whole point: the paraphrase 'Device is offline' passed
    // while the five OTHER non-online states were being mislabelled.
    it('reports an offline device as 503 device_offline, not a timeout', async () => {
      mockDeviceSelect();
      mockExecuteCommand.mockResolvedValue({
        status: 'failed',
        error: 'Device is offline, cannot execute command',
      });

      const res = await app.request(`/system-tools/devices/${deviceId}/tasks`);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('device_offline');
      expect(body.error).toBe('The device is offline.');
      expect(body.unverified).toBeUndefined();
    });

    // `device_status` has seven values and the queue refuses all six non-online
    // ones with the same sentence. Reporting every one of them as "offline"
    // sends a technician to chase a network fault — `updating` is set on every
    // agent self-update (agentWs.ts:2156), and `quarantined` is a security
    // containment state that must not read as a connectivity problem.
    it.each(['maintenance', 'decommissioned', 'quarantined', 'updating', 'pending'])(
      'names the real device state for a %s device instead of calling it offline',
      async (deviceState) => {
        mockDeviceSelect();
        mockExecuteCommand.mockResolvedValue({
          status: 'failed',
          error: `Device is ${deviceState}, cannot execute command`,
        });

        const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM/restart`, {
          method: 'POST',
        });

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.code).toBe('device_offline');
        expect(body.error).toBe(`The device is ${deviceState} and cannot run commands.`);
        expect(body.error).not.toContain('offline');
      },
    );
  });
});
