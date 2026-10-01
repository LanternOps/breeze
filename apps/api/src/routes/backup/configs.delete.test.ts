import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { configsRoutes } from './configs';

const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'for']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn();
const deleteMock = vi.fn();
const recordCredentialChangeMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: (...a: unknown[]) => selectMock(...(a as [])),
    delete: (...a: unknown[]) => deleteMock(...(a as [])),
  },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  assertOutsideHeldDbContext: vi.fn(),
}));

vi.mock('../../db/schema', () => ({
  backupConfigs: { id: 'backup_configs.id', orgId: 'backup_configs.org_id' },
  backupSnapshots: { id: 'backup_snapshots.id', configId: 'backup_snapshots.config_id' },
}));

vi.mock('../../services/backupStorageCredentialHistory', () => ({
  recordCredentialChange: (...a: unknown[]) => recordCredentialChangeMock(...(a as [])),
}));
vi.mock('../../jobs/backupRetention', () => ({ normalizeStorageIdentity: () => 'x' }));
vi.mock('../../services/backupSnapshotStorage', () => ({ checkBackupProviderCapabilities: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-1' }, scope: 'organization', orgId: ORG_ID, partnerId: null, token: { sub: 'user-1' } });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';

const existing = { id: CONFIG_ID, orgId: ORG_ID, name: 'Primary S3', provider: 's3', providerConfig: {} };

function fkError(constraint: string) {
  return Object.assign(new Error('update or delete violates foreign key constraint'), {
    code: '23503',
    constraint_name: constraint,
  });
}

describe('DELETE /backup/configs/:id', () => {
  let app: Hono;
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockImplementation(() => chainMock([existing]));
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', configsRoutes);
  });

  it('deletes a destination with no dependents', async () => {
    deleteMock.mockImplementation(() => chainMock([existing]));
    const res = await app.request(`/backup/configs/${CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  it.each([
    ['backup_jobs_config_id_backup_configs_id_fk', 'backup job history'],
    ['backup_snapshots_config_id_backup_configs_id_fk', 'snapshots'],
    ['backup_policies_config_id_backup_configs_id_fk', 'policies'],
  ])('returns 409 naming the dependency on FK violation %s', async (constraint, noun) => {
    deleteMock.mockImplementation(() => { throw fkError(constraint); });
    const res = await app.request(`/backup/configs/${CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain(noun);
    expect(body.error).not.toContain('other records');
    expect(body.error).toContain('Disable');
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('returns 409 with a generic message for an unrecognised FK constraint', async () => {
    deleteMock.mockImplementation(() => { throw fkError('something_else_fk'); });
    const res = await app.request(`/backup/configs/${CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('other records');
    expect(body.error).toContain('Disable it instead');
  });

  it('still surfaces non-FK errors', async () => {
    deleteMock.mockImplementation(() => { throw new Error('boom'); });
    const res = await app.request(`/backup/configs/${CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(500);
  });
});
