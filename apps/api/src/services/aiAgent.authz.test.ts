import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drive getSession / getSessionMessages / handleApproval through the real service
// logic without a live DB. We mock drizzle's `eq`/`and` to capture the WHERE
// predicates so we can assert the SR5-09 owner-binding, and drive JS-level
// branches (SR5-10 owner assertion in handleApproval) via mocked query results.

const selectMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...a: unknown[]) => selectMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'aiSessions.id',
    orgId: 'aiSessions.orgId',
    userId: 'aiSessions.userId',
    status: 'aiSessions.status',
    lastActivityAt: 'aiSessions.lastActivityAt',
    createdAt: 'aiSessions.createdAt',
  },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: {
    id: 'aiToolExecutions.id',
    status: 'aiToolExecutions.status',
    sessionId: 'aiToolExecutions.sessionId',
  },
  delegantM365Connections: {},
  devices: {},
}));

// Capture-friendly drizzle predicate builders.
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: Object.assign((..._a: unknown[]) => ({ op: 'sql' }), {}),
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base' }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn() }));
vi.mock('./aiInputSanitizer', () => ({ sanitizePageContext: (x: unknown) => x }));

import { getSession, getSessionMessages, handleApproval } from './aiAgent';

type Cond = { op: string; col?: unknown; val?: unknown; conds?: Cond[] };

const auth = (userId: string): any => ({
  user: { id: userId },
  orgId: 'org-1',
  orgCondition: () => undefined, // no org filter in these unit tests
});

/** Mock a single `select().from().where().limit()` chain returning `rows`; returns the where spy. */
function stubSelectOnce(rows: unknown[]) {
  const whereSpy = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) });
  selectMock.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: whereSpy }) });
  return whereSpy;
}

function ownerCondFrom(whereSpy: ReturnType<typeof vi.fn>): Cond | undefined {
  const arg = whereSpy.mock.calls[0]![0] as Cond;
  return arg.conds?.find((c) => c.op === 'eq' && c.col === 'aiSessions.userId');
}

beforeEach(() => vi.clearAllMocks());

describe('getSession owner-binding (SR5-09)', () => {
  it('binds the query to the caller as owner by default', async () => {
    const whereSpy = stubSelectOnce([{ id: 's1', orgId: 'org-1', userId: 'user-1' }]);

    await getSession('s1', auth('user-1'));

    const ownerCond = ownerCondFrom(whereSpy);
    expect(ownerCond).toBeDefined();
    expect(ownerCond?.val).toBe('user-1');
  });

  it('omits the owner predicate only when allowAnyOwnerInOrg is set (admin/internal)', async () => {
    const whereSpy = stubSelectOnce([{ id: 's1', orgId: 'org-1', userId: 'someone-else' }]);

    await getSession('s1', auth('admin-1'), { allowAnyOwnerInOrg: true });

    expect(ownerCondFrom(whereSpy)).toBeUndefined();
  });
});

describe('getSessionMessages (SR5-09)', () => {
  it('returns null for a non-owner (owner-scoped lookup finds nothing) and never reads messages', async () => {
    stubSelectOnce([]); // getSession: owner predicate filters the row out

    const result = await getSessionMessages('s1', auth('peer-user'));

    expect(result).toBeNull();
    // messages query must NOT run once the session lookup fails
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('returns session + messages for the owner', async () => {
    stubSelectOnce([{ id: 's1', orgId: 'org-1', userId: 'user-1' }]); // getSession
    // messages: select().from().where().orderBy()
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([{ id: 'm1', content: 'hi' }]),
        }),
      }),
    });

    const result = await getSessionMessages('s1', auth('user-1'));

    expect(result?.session.id).toBe('s1');
    expect(result?.messages).toHaveLength(1);
  });
});

describe('handleApproval owner-binding (SR5-10)', () => {
  function stubExecutionThenSession(execution: unknown, session: unknown) {
    stubSelectOnce([execution]); // execution lookup
    stubSelectOnce([session]); // getSession internal (org-scoped)
  }

  it('rejects approval by a non-owner and does not mutate the execution', async () => {
    stubExecutionThenSession(
      { id: 'exec-1', status: 'pending', sessionId: 's1' },
      { id: 's1', orgId: 'org-1', userId: 'victim' },
    );
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    updateMock.mockReturnValue({ set: setSpy });

    const ok = await handleApproval('exec-1', true, auth('attacker'), 's1');

    expect(ok).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('allows the session owner to approve and records approvedBy', async () => {
    stubExecutionThenSession(
      { id: 'exec-1', status: 'pending', sessionId: 's1' },
      { id: 's1', orgId: 'org-1', userId: 'victim' },
    );
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    updateMock.mockReturnValue({ set: setSpy });

    const ok = await handleApproval('exec-1', true, auth('victim'), 's1');

    expect(ok).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: 'victim' }),
    );
  });
});
