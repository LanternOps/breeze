import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { c2cItemsRoutes } from './items';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },
}));

vi.mock('../../db/schema', () => ({
  c2cBackupItems: {
    id: 'c2c_backup_items.id',
    orgId: 'c2c_backup_items.org_id',
    configId: 'c2c_backup_items.config_id',
  },
  c2cBackupJobs: {
    id: 'c2c_backup_jobs.id',
    orgId: 'c2c_backup_jobs.org_id',
    configId: 'c2c_backup_jobs.config_id',
    status: 'c2c_backup_jobs.status',
    createdAt: 'c2c_backup_jobs.created_at',
    updatedAt: 'c2c_backup_jobs.updated_at',
    startedAt: 'c2c_backup_jobs.started_at',
    completedAt: 'c2c_backup_jobs.completed_at',
    itemsProcessed: 'c2c_backup_jobs.items_processed',
    errorLog: 'c2c_backup_jobs.error_log',
  },
  c2cConnections: {
    id: 'c2c_connections.id',
    orgId: 'c2c_connections.org_id',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

const queueAddMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../jobs/c2cEnqueue', () => ({
  enqueueC2cRestore: vi.fn((...args: unknown[]) => queueAddMock(...(args as []))),
}));

let authState = {
  user: { id: 'user-123' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
}));

import { authMiddleware } from '../../middleware/auth';

describe('c2c items routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/c2c', c2cItemsRoutes);
  });

  it('rejects restore requests that span multiple configs', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        { id: '11111111-1111-4111-8111-111111111111', configId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        { id: '22222222-2222-4222-8222-222222222222', configId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      ])
    );

    const res = await app.request('/c2c/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        itemIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'All restore items must belong to the same backup configuration',
    });
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled();
  });
});
