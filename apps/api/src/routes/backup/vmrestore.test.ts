import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { vmRestoreRoutes } from './vmrestore';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

vi.mock('../../services', () => ({}));

const queueCommandForExecutionMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
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
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
  },
  restoreJobs: {
    id: 'restore_jobs.id',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    status: 'devices.status',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
  CommandTypes: {
    VM_RESTORE_FROM_BACKUP: 'VM_RESTORE_FROM_BACKUP',
    VM_INSTANT_BOOT: 'VM_INSTANT_BOOT',
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

describe('vm restore routes', () => {
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
    app.route('/', vmRestoreRoutes);
  });

  it('validates required fields for restore as VM', async () => {
    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        hypervisor: 'hyperv',
        vmName: 'Recovered VM',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('validates required fields for instant boot', async () => {
    const res = await app.request('/backup/restore/instant-boot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        targetDeviceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('returns a VM restore estimate', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_ID,
      orgId: ORG_ID,
      size: 50 * 1024 * 1024 * 1024,
      hardwareProfile: {
        cpuCores: 4,
        totalMemoryMB: 8192,
        disks: [{ sizeBytes: 80 * 1024 * 1024 * 1024 }],
      },
      metadata: {
        platform: 'hyperv',
        osVersion: 'Windows Server 2022',
      },
    }]));

    const res = await app.request(`/backup/restore/as-vm/estimate/${SNAPSHOT_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recommendedMemoryMb).toBe(8192);
    expect(body.recommendedCpu).toBe(4);
    expect(body.requiredDiskGb).toBe(100);
    expect(body.platform).toBe('hyperv');
  });
});
