import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { systemToolsRoutes } from './systemTools';

const mockExecuteCommand = vi.fn();

vi.mock('../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
  CommandTypes: {
    LIST_PROCESSES: 'LIST_PROCESSES',
    KILL_PROCESS: 'KILL_PROCESS',
    LIST_SERVICES: 'LIST_SERVICES'
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

  it('falls back to mock processes on invalid agent response', async () => {
    mockDeviceSelect();
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: '{not-json'
    });

    const res = await app.request(`/system-tools/devices/${deviceId}/processes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.meta.total).toBe(8);
  });

  it('gets process details by pid', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/processes/2048`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.pid).toBe(2048);
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

  it('returns 404 for missing service', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/services/UnknownService`);

    expect(res.status).toBe(404);
  });

  it('starts a service and logs audit', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/services/WinRM/start`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('running');
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it('lists registry keys', async () => {
    mockDeviceSelect();

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/keys?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
  });

  it('gets registry value details', async () => {
    mockDeviceSelect();

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/value?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE&name=ProductName`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('ProductName');
  });

  it('sets a registry value and logs audit', async () => {
    mockDeviceSelect();

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

    const res = await app.request(
      `/system-tools/devices/${deviceId}/registry/value?hive=HKEY_LOCAL_MACHINE&path=SOFTWARE&name=TestValue`,
      { method: 'DELETE' }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it('lists event logs', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/eventlogs`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('filters event log entries', async () => {
    mockDeviceSelect();

    const res = await app.request(
      `/system-tools/devices/${deviceId}/eventlogs/System/events?level=critical&eventId=6008`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.meta.filters.level).toBe('critical');
  });

  it('gets event log record details', async () => {
    mockDeviceSelect();

    const res = await app.request(
      `/system-tools/devices/${deviceId}/eventlogs/System/events/15234`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.recordId).toBe(15234);
  });

  it('lists scheduled tasks', async () => {
    mockDeviceSelect();

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks?limit=2&page=1`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it('gets task details with encoded path', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan');

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toContain('Windows Defender');
  });

  it('runs a task and logs audit', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan');

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}/run`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.state).toBe('running');
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it('enables a task and logs audit', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Backup\\Daily Backup');

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}/enable`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.state).toBe('ready');
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it('disables a task and logs audit', async () => {
    mockDeviceSelect();
    const encodedPath = encodeURIComponent('\\Microsoft\\Windows\\WindowsUpdate\\Scheduled Start');

    const res = await app.request(`/system-tools/devices/${deviceId}/tasks/${encodedPath}/disable`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.state).toBe('disabled');
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });
});
