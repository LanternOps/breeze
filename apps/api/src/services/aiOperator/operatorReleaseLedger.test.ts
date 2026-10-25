import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real-Postgres shape (rows, RLS, the feed join) is pinned by
// aiOperatorRevealFeed.integration.test.ts. This suite pins the predicate and
// the two failure contracts: begin fails CLOSED (null), finish never throws.

const dbMock = vi.hoisted(() => ({
  insertFails: false,
  updateFails: false,
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        if (dbMock.insertFails) {
          const p: any = Promise.reject(new Error('insert refused'));
          p.returning = () => p;
          p.catch(() => undefined);
          return p;
        }
        dbMock.inserted.push(row);
        const p: any = Promise.resolve(undefined);
        p.returning = () => Promise.resolve([{ id: 'exec-1' }]);
        return p;
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((row: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          if (dbMock.updateFails) throw new Error('update refused');
          dbMock.updated.push(row);
        }),
      })),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../db/schema/ai', () => ({ aiSessions: {}, aiToolExecutions: { id: 'aiToolExecutions.id' } }));

import { AI_OPERATOR_SESSION_TYPE, beginOperatorReleaseLedger, isOperatorOriginIntent } from './operatorReleaseLedger';

const intent = {
  id: 'intent-1', orgId: 'org-1', actionName: 'm365_create_user', arguments: { userPrincipalName: 'a@b.example' },
  riskTier: 3, source: 'mcp_api', originPrincipalKind: 'user_session', taskId: 'task-1', taskStepKey: 'create_accounts',
  operationKey: 'op-1', requestedByUserId: 'user-approver', decidedByUserId: 'user-approver', decidedAt: new Date(0),
} as const;

beforeEach(() => {
  dbMock.insertFails = false;
  dbMock.updateFails = false;
  dbMock.inserted = [];
  dbMock.updated = [];
});

describe('isOperatorOriginIntent', () => {
  it.each([
    [{ source: 'mcp_api', originPrincipalKind: 'user_session', taskId: 't' }, true],
    [{ source: 'mcp_api', originPrincipalKind: 'api_key', taskId: 't' }, false],
    [{ source: 'mcp_api', originPrincipalKind: 'oauth_grant', taskId: 't' }, false],
    [{ source: 'mcp_api', originPrincipalKind: 'user_session', taskId: null }, false],
    [{ source: 'mcp_api', originPrincipalKind: 'user_session' }, false],
    [{ source: 'chat', originPrincipalKind: 'user_session', taskId: 't' }, false],
  ])('%j → %s', (i, expected) => {
    expect(isOperatorOriginIntent(i)).toBe(expected);
  });
});

describe('beginOperatorReleaseLedger', () => {
  it('writes a closed ai_operator session for the requester, then an executing row carrying intent_id', async () => {
    const ledger = await beginOperatorReleaseLedger(intent as never);
    expect(ledger).toMatchObject({ executionId: 'exec-1' });
    const [session, execution] = dbMock.inserted;
    expect(session).toMatchObject({
      id: ledger!.sessionId, orgId: 'org-1', userId: 'user-approver', type: AI_OPERATOR_SESSION_TYPE, status: 'closed',
      contextSnapshot: { source: 'ai_operator', taskId: 'task-1', stepKey: 'create_accounts', intentId: 'intent-1' },
    });
    expect(execution).toMatchObject({
      sessionId: ledger!.sessionId, toolName: 'm365_create_user', status: 'executing', intentId: 'intent-1',
      approvedBy: 'user-approver',
    });
  });

  it('fails closed: null when the rows cannot be written', async () => {
    dbMock.insertFails = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(beginOperatorReleaseLedger(intent as never)).resolves.toBeNull();
    err.mockRestore();
  });

  it('finish records status without a result when none is given, and is idempotent', async () => {
    const ledger = (await beginOperatorReleaseLedger(intent as never))!;
    await ledger.finish({ status: 'success' });
    await ledger.finish({ status: 'failure', error: new Error('late') });
    expect(dbMock.updated).toHaveLength(1);
    expect(dbMock.updated[0]).toMatchObject({ status: 'completed', toolOutput: { source: 'ai_operator', status: 'success' } });
    expect((dbMock.updated[0]!.toolOutput as Record<string, unknown>).result).toBeUndefined();
  });

  it('finish never throws when the completion write fails', async () => {
    const ledger = (await beginOperatorReleaseLedger(intent as never))!;
    dbMock.updateFails = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(ledger.finish({ status: 'failure', error: new Error('boom') })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
