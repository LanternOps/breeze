import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { systemToolsRoutes } from './systemTools';

const mockExecuteCommand = vi.fn();

vi.mock('../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
  CommandTypes: {
    LIST_PROCESSES: 'LIST_PROCESSES',
    KILL_PROCESS: 'KILL_PROCESS',
    LIST_SERVICES: 'LIST_SERVICES',
    TASKS_LIST: 'TASKS_LIST',
    TASK_GET: 'TASK_GET',
    TASK_RUN: 'TASK_RUN',
    TASK_ENABLE: 'TASK_ENABLE',
    TASK_DISABLE: 'TASK_DISABLE',
    REGISTRY_KEYS: 'REGISTRY_KEYS',
    REGISTRY_VALUES: 'REGISTRY_VALUES',
    REGISTRY_GET: 'REGISTRY_GET',
    REGISTRY_SET: 'REGISTRY_SET',
    REGISTRY_DELETE: 'REGISTRY_DELETE',
    REGISTRY_KEY_CREATE: 'REGISTRY_KEY_CREATE',
    REGISTRY_KEY_DELETE: 'REGISTRY_KEY_DELETE'
  }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {},
  organizations: {},
  auditLogs: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';

describe('system tools routes', () => {
  let app: Hono;
  const deviceId = '11111111-1111-1111-1111-111111111111';
  const deviceRecord = { id: deviceId, orgId: 'org-123', hostname: 'device-1' };

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

  it('returns 502 on invalid process payload from agent', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: '{not-json'
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/processes`);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('Failed to parse agent response');
  });

  it('returns 501 for process details endpoint until agent integration is implemented', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/processes/2048`);

    expect(res.status).toBe(501);
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it('lists services via agent command', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        services: [{ name: 'WinRM', status: 'stopped' }],
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
    expect(body.meta.total).toBe(1);
  });

  it('returns 501 for service details endpoint until agent integration is implemented', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/services/UnknownService`);

    expect(res.status).toBe(501);
  });

  it('returns 501 for service start endpoint until agent integration is implemented', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM/start`, {
      method: 'POST'
    });

    expect(res.status).toBe(501);
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it('returns 501 for event log listing until agent integration is implemented', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/eventlogs`);

    expect(res.status).toBe(501);
  });

  it('returns 501 for event log query until agent integration is implemented', async () => {
    mockDeviceSelect();

    const res = await app.request(
      `/system-tools/devices/${deviceId}/eventlogs/System/events?level=critical&eventId=6008`
    );

    expect(res.status).toBe(501);
  });

  it('returns 501 for event log detail until agent integration is implemented', async () => {
    mockDeviceSelect();

    const res = await app.request(
      `/system-tools/devices/${deviceId}/eventlogs/System/events/15234`
    );

    expect(res.status).toBe(501);
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

  it('returns 502 on invalid scheduled task payload from agent', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: '{not-json'
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks?limit=2&page=1`);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('Failed to parse agent response');
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
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
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });
});
