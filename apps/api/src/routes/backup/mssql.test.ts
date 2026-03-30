import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mssqlRoutes } from './mssql';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

vi.mock('../../services', () => ({}));

const executeCommandMock = vi.fn();
const queueCommandForExecutionMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(resolvedValue));
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
  },
}));

vi.mock('../../db/schema/applicationBackup', () => ({
  sqlInstances: {
    orgId: 'sql_instances.org_id',
    deviceId: 'sql_instances.device_id',
    instanceName: 'sql_instances.instance_name',
  },
  backupChains: {
    orgId: 'backup_chains.org_id',
  },
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
  CommandTypes: {
    MSSQL_DISCOVER: 'MSSQL_DISCOVER',
    MSSQL_BACKUP: 'MSSQL_BACKUP',
    MSSQL_RESTORE: 'MSSQL_RESTORE',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

describe('mssql routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', mssqlRoutes);
  });

  it('returns an empty MSSQL instance list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/mssql/instances', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('dispatches MSSQL discovery for a device', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: ORG_ID }]));
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ instances: [] }),
    });

    const res = await app.request(`/backup/mssql/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.instances).toEqual([]);
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'MSSQL_DISCOVER',
      {},
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('validates required MSSQL backup fields', async () => {
    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        instance: 'MSSQLSERVER',
        outputPath: 'C:/backups',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects cross-org device discovery', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: OTHER_ORG_ID }]));

    const res = await app.request(`/backup/mssql/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
