import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { hypervRoutes } from './hyperv';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const VM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../services', () => ({}));

const executeCommandMock = vi.fn();

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
  hypervVms: {
    id: 'hyperv_vms.id',
    orgId: 'hyperv_vms.org_id',
    deviceId: 'hyperv_vms.device_id',
    vmId: 'hyperv_vms.vm_id',
    vmName: 'hyperv_vms.vm_name',
  },
}));

const writeRouteAuditMock = vi.fn();

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
  CommandTypes: {
    HYPERV_DISCOVER: 'HYPERV_DISCOVER',
    HYPERV_BACKUP: 'HYPERV_BACKUP',
    HYPERV_CHECKPOINT: 'HYPERV_CHECKPOINT',
    HYPERV_VM_STATE: 'HYPERV_VM_STATE',
    HYPERV_RESTORE: 'HYPERV_RESTORE',
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

describe('hyperv routes', () => {
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
    app.route('/backup/hyperv', hypervRoutes);
  });

  it('returns an empty Hyper-V VM list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/hyperv/vms', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vms).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('dispatches Hyper-V discovery for a device', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: ORG_ID }]));
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify([]),
    });

    const res = await app.request(`/backup/hyperv/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vms).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('validates required Hyper-V backup fields', async () => {
    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        vmName: 'Accounting VM',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('validates Hyper-V checkpoint action enum', async () => {
    const res = await app.request(`/backup/hyperv/checkpoints/${DEVICE_ID}/${VM_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ action: 'snapshot' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects cross-org Hyper-V discovery', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: OTHER_ORG_ID }]));

    const res = await app.request(`/backup/hyperv/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
