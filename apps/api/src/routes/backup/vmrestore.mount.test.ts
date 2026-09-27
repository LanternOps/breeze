// Regression test for the routing defect where vmRestoreRoutes registered
// its paths with a redundant '/backup' prefix while backupRoutes.route('/',
// vmRestoreRoutes) is itself mounted at '/backup' in index.ts — producing
// real URLs of /backup/backup/restore/... instead of /backup/restore/...
// that the web app actually calls.
//
// vmrestore.test.ts mounts vmRestoreRoutes directly at '/' and so never
// exercises the real composition. This file mounts the REAL backupRoutes
// (from ./index) at '/backup', exactly like apps/api/src/routes/backup.test.ts
// does, to prove the web-facing paths are reachable through the full stack.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

vi.mock('../../services', () => ({}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

const queueCommandForExecutionMock = vi.fn();
const executeCommandMock = vi.fn();
const queueBackupStopCommandMock = vi.fn();
// Fully replaced (not importOriginal) to match apps/api/src/routes/backup.test.ts's
// approach: the real commandQueue.ts transitively pulls in commandResultHandlers
// -> scriptWriteBack, which needs more of ../../services/auditEvents mocked than
// this file provides.
vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...args),
  executeCommand: (...args: unknown[]) => executeCommandMock(...args),
  queueBackupStopCommand: (...args: unknown[]) => queueBackupStopCommandMock(...args),
  CommandTypes: {
    BACKUP_STOP: 'backup_stop',
    BACKUP_RESTORE: 'backup_restore',
    VM_RESTORE_FROM_BACKUP: 'vm_restore_from_backup',
    VM_INSTANT_BOOT: 'vm_instant_boot',
  },
}));

const authorizeResilienceResourcesMock = vi.fn();
vi.mock('../../services/resilienceSiteAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/resilienceSiteAuthorization')>();
  return {
    ...actual,
    authorizeResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...args),
  };
});

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'groupBy', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
    transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        select: (...args: unknown[]) => selectMock(...(args as [])),
        insert: (...args: unknown[]) => insertMock(...(args as [])),
        update: (...args: unknown[]) => updateMock(...(args as [])),
        delete: (...args: unknown[]) => deleteMock(...(args as [])),
      }),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', async () => {
  const actual = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  return { ...actual };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User', isPlatformAdmin: false },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123', scope: 'organization' },
      accessibleOrgIds: [ORG_ID],
      orgCondition: () => undefined,
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      allowedSiteIds: undefined,
      canAccessSite: () => true,
    });
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => {
    c.set('permissions', {
      permissions: [
        { resource: 'backup', action: 'read' },
        { resource: 'devices', action: 'execute' },
      ],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'test-role',
      scope: 'organization',
      allowedSiteIds: undefined,
    });
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { backupRoutes } from './index';

describe('vm restore routes — mounted through the real backupRoutes composition', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    deleteMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    insertMock.mockImplementation(() => chainMock([]));
    updateMock.mockImplementation(() => chainMock([]));
    deleteMock.mockImplementation(() => chainMock([]));
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    app = new Hono();
    app.route('/backup', backupRoutes);
  });

  it('reaches the VM restore handler at the path the web calls (not the old double-prefixed path)', async () => {
    // Invalid body (missing required fields) — enough to prove the request
    // reached zValidator/the handler instead of Hono's route-not-found path.
    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ snapshotId: SNAPSHOT_ID }),
    });

    expect(res.status).toBe(400);
  });

  it('reaches the instant-boot handler at the path the web calls', async () => {
    const res = await app.request('/backup/restore/instant-boot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ snapshotId: SNAPSHOT_ID }),
    });

    expect(res.status).toBe(400);
  });

  it('reaches the active-instant-boots handler at the path the web calls', async () => {
    const res = await app.request('/backup/restore/instant-boot/active', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('reaches the VM restore estimate handler at the path the web calls', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_ID,
      orgId: ORG_ID,
      size: 10 * 1024 * 1024 * 1024,
      hardwareProfile: null,
      metadata: null,
    }]));

    const res = await app.request(`/backup/restore/as-vm/estimate/${SNAPSHOT_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.platform).toBe('unknown');
  });

  it('404s on the old, incorrectly double-prefixed path', async () => {
    const res = await app.request('/backup/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ snapshotId: SNAPSHOT_ID }),
    });

    expect(res.status).toBe(404);
  });

  it('does not dispatch a command when device is missing (sanity: no accidental shadowing captured the call)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, orgId: ORG_ID, snapshotId: 'snap-ext-001' }]))
      .mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        targetDeviceId: DEVICE_ID,
        hypervisor: 'hyperv',
        vmName: 'Recovered VM',
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Target device not found' });
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });
});
