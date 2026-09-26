import { describe, it, expect, vi, beforeEach } from 'vitest';

// #6597: the backup dispatch worker reads the job row on its own connection
// the moment its dispatch is enqueued. trigger_backup runs inside the AI
// tool's ambient transaction, so a job row created there was invisible to the
// worker until the tool call finished: the worker resolved it as a pathless
// file backup, "failed" a row it could not see, and the committed row then sat
// `pending` until the stale reaper failed it ("Backup dispatch never
// completed"). The row must be created in its own transaction that has
// COMMITTED before enqueueBackupDispatch is called.

const { ctx } = vi.hoisted(() => ({
  ctx: { seq: 0, stack: [] as number[], committed: new Set<number>(), escaped: false },
}));

vi.mock('../db', () => ({
  // Escaping the ambient context is what lets the nested withDbAccessContext
  // open (and commit) its own transaction instead of joining the outer one.
  runOutsideDbContext: vi.fn((fn: any) => {
    ctx.escaped = true;
    try {
      return fn();
    } finally {
      ctx.escaped = false;
    }
  }),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => {
    if (!ctx.escaped) return fn(); // joins the ambient transaction: no commit
    ctx.escaped = false;
    const id = ++ctx.seq;
    ctx.stack.push(id);
    try {
      return await fn();
    } finally {
      ctx.stack.pop();
      ctx.committed.add(id);
    }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({ CommandTypes: { BACKUP_RESTORE: 'backup_restore' } }));
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn() }));
vi.mock('./backupJobCreation', () => ({ createManualBackupJobIfIdle: vi.fn() }));
vi.mock('../jobs/backupEnqueue', () => ({ enqueueBackupDispatch: vi.fn() }));
vi.mock('./backupProviderConfig', () => ({
  resolveBackupProviderConfig: vi.fn(),
  resolveBackupDestinationError: vi.fn(),
}));

import { db } from '../db';
import { registerBackupTools } from './aiToolsBackup';
import { createManualBackupJobIfIdle } from './backupJobCreation';
import { enqueueBackupDispatch } from '../jobs/backupEnqueue';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const ORG = '11111111-1111-1111-1111-111111111111';

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBackupTools(reg);
  return reg.get(name)!.handler;
}

function orgAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

describe('trigger_backup commits the job row before enqueueing (#6597)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.seq = 0;
    ctx.stack.length = 0;
    ctx.committed.clear();
    ctx.escaped = false;
  });

  it('creates the job in its own committed transaction, then enqueues', async () => {
    let call = 0;
    const rows = [
      [{ id: 'd1', orgId: ORG, status: 'online', siteId: 's1' }],
      [{ id: 'cfg1', orgId: ORG, name: 'Nightly' }],
    ];
    vi.mocked(db.select).mockImplementation((() => {
      const r = rows[call++] ?? [];
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(r) }) }) };
    }) as any);
    let createdIn: number | undefined;
    vi.mocked(createManualBackupJobIfIdle).mockImplementation(async () => {
      createdIn = ctx.stack.at(-1);
      return {
        created: true,
        job: { id: 'job1', status: 'pending', createdAt: new Date(), updatedAt: new Date() },
      } as any;
    });
    let committedAtEnqueue: boolean | undefined;
    vi.mocked(enqueueBackupDispatch).mockImplementation(async () => {
      committedAtEnqueue = createdIn !== undefined && ctx.committed.has(createdIn);
      return 'q1';
    });

    const result = JSON.parse(await handlerFor('trigger_backup')({ deviceId: 'd1', configId: 'cfg1' }, orgAuth()));

    expect(result.success).toBe(true);
    expect(createdIn, 'job row was created inside the ambient transaction').toBeDefined();
    expect(committedAtEnqueue, 'dispatch was enqueued before the job row committed').toBe(true);
  });
});
