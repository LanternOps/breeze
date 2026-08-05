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
    intentId: 'aiToolExecutions.intentId',
  },
  approvalRequests: {
    executionId: 'approvalRequests.executionId',
    status: 'approvalRequests.status',
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

import { getSession, getSessionMessages, handleApproval, isIntentBackedExecution } from './aiAgent';

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
    const returningSpy = vi.fn().mockResolvedValue([{ id: 'exec-1' }]);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: returningSpy }) });
    updateMock.mockReturnValue({ set: setSpy });

    const ok = await handleApproval('exec-1', true, auth('victim'), 's1');

    expect(ok).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: 'victim' }),
    );
  });

  it('returns false when the CAS updates zero rows (row settled/decided concurrently — #3089)', async () => {
    // The pre-check SELECT saw 'pending', but by the time the guarded UPDATE
    // ran, a settle (or the waitForApproval timeout writer) had already moved
    // the row out of 'pending'. Reporting true here would tell the UI an
    // action was approved that nothing will ever execute.
    stubExecutionThenSession(
      { id: 'exec-1', status: 'pending', sessionId: 's1' },
      { id: 's1', orgId: 'org-1', userId: 'victim' },
    );
    const returningSpy = vi.fn().mockResolvedValue([]);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: returningSpy }) });
    updateMock.mockReturnValue({ set: setSpy });

    const ok = await handleApproval('exec-1', true, auth('victim'), 's1');

    expect(ok).toBe(false);
  });
});

// #3094: the Tier-2 per_step flow creates BOTH an ai_tool_executions row and a
// mobile-bridge approval_requests row. The inline web-chat decide historically
// flipped only the execution row, stranding the bridge row 'pending' until its
// 5-minute TTL — which reads as an unattended-expired approval sitting next to
// a recorded success. Pin that handleApproval now mirrors the decision onto
// the still-pending bridge row.
describe('handleApproval approval_requests mirror (#3094)', () => {
  function stubExecutionThenSession(execution: unknown, session: unknown) {
    stubSelectOnce([execution]);
    stubSelectOnce([session]);
  }

  function captureUpdates() {
    const calls: Array<{ set: Record<string, unknown>; where: unknown }> = [];
    let call = 0;
    updateMock.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          calls.push({ set: values, where: cond });
          call += 1;
          // First update is the CAS on aiToolExecutions (#3089) — chains
          // .returning() and must yield the updated row for `updated` to be
          // truthy so the mirror below is reached. Second update is the
          // approval_requests mirror, which resolves the where() directly.
          if (call === 1) {
            return { returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]) };
          }
          return Promise.resolve(undefined);
        },
      }),
    }));
    return calls;
  }

  it('marks the pending bridge row approved when the owner approves', async () => {
    stubExecutionThenSession(
      { id: 'exec-1', status: 'pending', sessionId: 's1' },
      { id: 's1', orgId: 'org-1', userId: 'victim' },
    );
    const updates = captureUpdates();

    const ok = await handleApproval('exec-1', true, auth('victim'), 's1');

    expect(ok).toBe(true);
    expect(updates).toHaveLength(2);
    const mirror = updates[1]!;
    expect(mirror.set).toMatchObject({ status: 'approved' });
    expect(mirror.set.decidedAt).toBeInstanceOf(Date);
    // Predicate must bind to this execution AND only flip a still-pending row.
    const where = mirror.where as { op: string; conds: Array<{ col: unknown; val: unknown }> };
    expect(where.op).toBe('and');
    expect(where.conds).toContainEqual(
      expect.objectContaining({ col: 'approvalRequests.executionId', val: 'exec-1' }),
    );
    expect(where.conds).toContainEqual(
      expect.objectContaining({ col: 'approvalRequests.status', val: 'pending' }),
    );
  });

  it('marks the pending bridge row denied when the owner rejects', async () => {
    stubExecutionThenSession(
      { id: 'exec-1', status: 'pending', sessionId: 's1' },
      { id: 's1', orgId: 'org-1', userId: 'victim' },
    );
    const updates = captureUpdates();

    const ok = await handleApproval('exec-1', false, auth('victim'), 's1');

    expect(ok).toBe(true);
    expect(updates[1]!.set).toMatchObject({ status: 'denied' });
  });

  it('still reports success when the bridge mirror fails (execution row is the source of truth)', async () => {
    stubExecutionThenSession(
      { id: 'exec-1', status: 'pending', sessionId: 's1' },
      { id: 's1', orgId: 'org-1', userId: 'victim' },
    );
    let call = 0;
    updateMock.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          call += 1;
          // First update (the CAS) must succeed and report the updated row so
          // `updated` is truthy and the mirror update is attempted at all.
          if (call === 1) {
            return { returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]) };
          }
          return Promise.reject(new Error('db down'));
        },
      }),
    }));

    await expect(handleApproval('exec-1', true, auth('victim'), 's1')).resolves.toBe(true);
  });
});

// CRITICAL-3 (whole-branch review): the web chat "Approve" button was a
// silent no-op for Tier-3 durable intents — handleApproval only ever flipped
// ai_tool_executions, but the intent-backed chat flow blocks on
// action_intents.status (waitForIntentDecision), so the row flip did nothing
// and the route still reported `{ success: true }`. These tests pin down the
// fix: an intent-backed execution is never flipped and never reported as a
// successful self-approval, regardless of who's asking (unlike SR5-10, this
// is NOT an owner check — it's a hard "this endpoint never decides intents").
describe('handleApproval intent-backed guard (CRITICAL-3)', () => {
  it('does not flip and returns false for an intent-backed execution, even for the session owner', async () => {
    // Only the execution lookup should run — the intent-backed guard fires
    // before getSession/owner-check, so a second select() must never happen.
    stubSelectOnce([
      { id: 'exec-1', status: 'pending', sessionId: 's1', intentId: 'intent-1' },
    ]);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    updateMock.mockReturnValue({ set: setSpy });

    const ok = await handleApproval('exec-1', true, auth('victim'), 's1');

    expect(ok).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('rejecting an intent-backed execution via this route is also refused (no reject-only bypass)', async () => {
    stubSelectOnce([
      { id: 'exec-1', status: 'pending', sessionId: 's1', intentId: 'intent-1' },
    ]);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    updateMock.mockReturnValue({ set: setSpy });

    const ok = await handleApproval('exec-1', false, auth('victim'), 's1');

    expect(ok).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('isIntentBackedExecution', () => {
  it('returns true when the execution row carries an intent_id', async () => {
    stubSelectOnce([{ intentId: 'intent-1' }]);

    await expect(isIntentBackedExecution('exec-1')).resolves.toBe(true);
  });

  it('returns false for a legacy (non-intent) execution', async () => {
    stubSelectOnce([{ intentId: null }]);

    await expect(isIntentBackedExecution('exec-1')).resolves.toBe(false);
  });

  it('returns false when the execution does not exist', async () => {
    stubSelectOnce([]);

    await expect(isIntentBackedExecution('exec-missing')).resolves.toBe(false);
  });
});
