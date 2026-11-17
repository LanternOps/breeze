import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Drive getSession / getSessionMessages / handleApproval through the real service
// logic without a live DB. We mock drizzle's `eq`/`and` to capture the WHERE
// predicates so we can assert the SR5-09 owner-binding, and drive JS-level
// branches (SR5-10 owner assertion in handleApproval) via mocked query results.

const selectMock = vi.fn();
const updateMock = vi.fn();
/**
 * #12084 review: the request lock (`lockLinkedApprovalRequests`,
 * select({ id: approvalRequests.id })...for('update')) is answered here, not by
 * `selectMock`, so the existing select sequences stay as they were.
 */
let lockedRequestIds: string[] = [];
const lockCalls: Array<{ where: unknown; mode: unknown }> = [];
const auditMock = vi.fn(async (..._a: unknown[]) => undefined);

// Topology M4-D2 visibility is covered by aiSessionAccess tests and topologyAiSessionHistory.integration.
vi.mock('./topology/aiSessionAccess', () => ({ topologySessionAccessCondition: vi.fn(async () => undefined) }));
vi.mock('../db', () => ({
  db: {
    select: (...a: unknown[]) => {
      const fields = a[0] as { id?: unknown } | undefined;
      if (fields?.id === 'approvalRequests.id') {
        return {
          from: () => ({
            where: (where: unknown) => ({
              for: (mode: unknown) => {
                lockCalls.push({ where, mode });
                return Promise.resolve(lockedRequestIds.map((id) => ({ id })));
              },
            }),
          }),
        };
      }
      return selectMock(...a);
    },
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
    id: 'approvalRequests.id',
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
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: Object.assign((..._a: unknown[]) => ({ op: 'sql' }), {}),
}));

vi.mock('./auditEvents', () => ({
  requestLikeFromSnapshot: () => ({}),
  writeAuditEventAsync: (...a: unknown[]) => auditMock(...a),
}));
vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('./aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'base\nindex\ntail', renderPageContextToolBlocks: () => '', resolveToolIndexMode: () => 'lazy' }));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn() }));
vi.mock('./aiInputSanitizer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiInputSanitizer')>()),
  sanitizePageContext: (x: unknown) => x,
}));

// W03 Task 9 (#7601): createSession picks its model through the registry.
vi.mock('./aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn(async () => 'partner-1') }));
vi.mock('./aiModels/sessionModel', () => ({
  chooseSessionModel: vi.fn(async () => ({
    offeringId: 'off-1', offeringPartnerId: 'partner-1', options: null,
    model: 'claude-sonnet-4-6', billingSource: 'platform',
  })),
}));

import { getSession, getSessionMessages, handleApproval, isIntentBackedExecution, getDecidedExecutionOutcome, waitForApproval, AI_APPROVAL_REQUEST_EXPIRED_MESSAGE, AI_APPROVAL_WAIT_ENDED_MESSAGE, AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE, type ApprovalWaitDetail } from './aiAgent';

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

beforeEach(() => {
  vi.clearAllMocks();
  lockedRequestIds = [];
  lockCalls.length = 0;
});

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
    let locksBeforeCas: number | undefined;
    updateMock.mockImplementation(() => {
      locksBeforeCas ??= lockCalls.length;
      return { set: setSpy };
    });

    const ok = await handleApproval('exec-1', true, auth('victim'), 's1');

    expect(ok).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: 'victim' }),
    );
    // #12084 review: the linked mobile request is locked before the CAS on
    // the execution row, the order the wait's close-out takes them.
    expect(locksBeforeCas).toBe(1);
    expect(lockCalls).toEqual([
      { where: { op: 'eq', col: 'approvalRequests.executionId', val: 'exec-1' }, mode: 'update' },
    ]);
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

describe('getDecidedExecutionOutcome (#9431)', () => {
  it.each([
    ['approved', 'approved'],
    ['executing', 'approved'],
    ['completed', 'approved'],
    ['failed', 'approved'],
    ['rejected', 'not_approved'],
  ])('maps a %s execution of this session to %s', async (status, outcome) => {
    stubSelectOnce([{ status, sessionId: 'session-1', intentId: null }]);

    await expect(getDecidedExecutionOutcome('exec-1', 'session-1')).resolves.toBe(outcome);
  });

  // #12079: a row closed by a timeout was never denied — say it expired.
  it.each([
    ['Approval timed out', 'expired'],
    ['Approval request expired', 'expired'],
    [null, 'not_approved'],
    ['Approval wait ended before a decision was made', 'not_approved'],
    ['Polling failed', 'not_approved'],
  ])('maps a rejected execution with error %j to %s', async (errorMessage, outcome) => {
    stubSelectOnce([{ status: 'rejected', errorMessage, sessionId: 'session-1', intentId: null }]);

    await expect(getDecidedExecutionOutcome('exec-1', 'session-1')).resolves.toBe(outcome);
  });

  it('returns null while the execution is still pending', async () => {
    stubSelectOnce([{ status: 'pending', sessionId: 'session-1', intentId: null }]);

    await expect(getDecidedExecutionOutcome('exec-1', 'session-1')).resolves.toBeNull();
  });

  it('returns null for an execution of another session (no cross-session disclosure)', async () => {
    stubSelectOnce([{ status: 'approved', sessionId: 'session-other', intentId: null }]);

    await expect(getDecidedExecutionOutcome('exec-1', 'session-1')).resolves.toBeNull();
  });

  it('returns null for an intent-backed execution (decided in Approvals, not here)', async () => {
    stubSelectOnce([{ status: 'approved', sessionId: 'session-1', intentId: 'intent-1' }]);

    await expect(getDecidedExecutionOutcome('exec-1', 'session-1')).resolves.toBeNull();
  });

  it('returns null when the execution does not exist', async () => {
    stubSelectOnce([]);

    await expect(getDecidedExecutionOutcome('exec-missing', 'session-1')).resolves.toBeNull();
  });
});

describe('waitForApproval expiry detail (#12079)', () => {
  it('reads the exact text the approval-expiry reaper writes', () => {
    // The reaper keeps its own literal (importing this module into a job is
    // heavy); a drift would quietly turn reaper-expired cards back into
    // "not approved".
    const reaper = readFileSync(join(__dirname, '../jobs/approvalExpiryReaper.ts'), 'utf8');
    expect(reaper).toContain(`errorMessage: '${AI_APPROVAL_REQUEST_EXPIRED_MESSAGE}'`);
  });

  type Update = { set: Record<string, unknown>; where: Cond };

  /**
   * Record every UPDATE. `returning` yields the next entry of `returned` (an
   * empty array = the guarded UPDATE matched nothing); a plain awaited
   * `.where()` (the approval_requests expiry) resolves without one.
   */
  function recordUpdates(returned: unknown[][] = []): Update[] {
    const calls: Update[] = [];
    updateMock.mockImplementation(() => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: Cond) => {
          calls.push({ set, where });
          return Object.assign(Promise.resolve(undefined), {
            returning: () => Promise.resolve(returned.shift() ?? []),
          });
        },
      }),
    }));
    return calls;
  }

  const execPending = {
    op: 'and',
    conds: [
      { op: 'eq', col: 'aiToolExecutions.id', val: 'exec-1' },
      { op: 'eq', col: 'aiToolExecutions.status', val: 'pending' },
    ],
  };
  const requestIn = (status: string) => ({
    op: 'and',
    conds: [
      { op: 'inArray', col: 'approvalRequests.id', val: ['req-1'] },
      { op: 'eq', col: 'approvalRequests.status', val: status },
    ],
  });
  const requestPending = requestIn('pending');
  const lockedByExecution = { where: { op: 'eq', col: 'approvalRequests.executionId', val: 'exec-1' }, mode: 'update' };

  afterEach(() => {
    // mockClear (beforeEach) keeps implementations; these must not leak.
    updateMock.mockReset();
    selectMock.mockReset();
    vi.useRealTimers();
  });

  it('keeps the SDK fallback literal equal to the settle message (#12084)', () => {
    const sdk = readFileSync(join(__dirname, 'aiAgentSdk.ts'), 'utf8');
    expect(sdk).toContain(`'${AI_APPROVAL_WAIT_ENDED_MESSAGE}'`);
  });

  it('on its own timeout closes only a still-pending row, and its mobile request with it (#12084)', async () => {
    lockedRequestIds = ['req-1'];
    const updates = recordUpdates([[{ id: 'exec-1' }]]);
    const detail: ApprovalWaitDetail = {};

    // A zero budget skips the poll and goes straight to the timeout close-out.
    await expect(waitForApproval('exec-1', 0, undefined, detail)).resolves.toBe(false);

    expect(detail).toEqual({ expired: true });
    expect(updates).toEqual([
      { set: { status: 'rejected', errorMessage: 'Approval timed out' }, where: execPending },
      // A later mobile click then loses its own CAS instead of being told
      // "approved" for an action that will not run.
      { set: { status: 'expired' }, where: requestPending },
    ]);
    // The request is locked before the execution row (#12084 review).
    expect(lockCalls).toEqual([lockedByExecution]);
  });

  it('honours an approval that beat the timeout close-out, and leaves the mobile request alone (#12084)', async () => {
    vi.useFakeTimers();
    lockedRequestIds = ['req-1'];
    stubSelectOnce([{ status: 'pending', errorMessage: null }]); // the last poll
    const updates = recordUpdates([[]]);
    stubSelectOnce([{ status: 'approved', errorMessage: null }]); // the close-out's read
    const detail: ApprovalWaitDetail = {};

    const waiting = waitForApproval('exec-1', 100, undefined, detail);
    await vi.runAllTimersAsync();

    await expect(waiting).resolves.toBe(true);
    expect(detail).toEqual({});
    expect(updates).toHaveLength(1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('with a zero budget refuses an approval that beat the close-out, records it on the request, and audits it (#12084 review)', async () => {
    lockedRequestIds = ['req-1'];
    // Pending close-out matches nothing; the approved row is moved out.
    const updates = recordUpdates([[], [{ sessionId: 's1', toolName: 'execute_command' }]]);
    stubSelectOnce([{ orgId: 'org-1' }]); // the session's org, for the audit row
    const detail: ApprovalWaitDetail = {};

    // A PAM auto-approved row, a spent budget, no settle.
    await expect(waitForApproval('exec-1', 0, new AbortController().signal, detail)).resolves.toBe(false);

    expect(updates.slice(1)).toEqual([
      {
        set: { status: 'rejected', errorMessage: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE },
        where: {
          op: 'and',
          conds: [
            { op: 'eq', col: 'aiToolExecutions.id', val: 'exec-1' },
            { op: 'eq', col: 'aiToolExecutions.status', val: 'approved' },
          ],
        },
      },
      { set: { status: 'denied', refusalReason: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE }, where: requestIn('approved') },
      { set: { status: 'expired' }, where: requestPending },
    ]);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      orgId: 'org-1',
      action: 'ai.tool_approval.stopped',
      resourceId: 'exec-1',
      details: { executionId: 'exec-1', approvalRequestIds: ['req-1'] },
    });
  });

  it('reports a denial that beat the timeout close-out as denied, not expired (#12084)', async () => {
    recordUpdates([[]]);
    stubSelectOnce([{ status: 'rejected', errorMessage: null }]);
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 0, undefined, detail)).resolves.toBe(false);

    expect(detail).toEqual({ denied: true });
  });

  it('reports an expiry-reaper close that beat the timeout close-out as expired (#12084)', async () => {
    recordUpdates([[]]);
    stubSelectOnce([{ status: 'rejected', errorMessage: 'Approval request expired' }]);
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 0, undefined, detail)).resolves.toBe(false);

    expect(detail).toEqual({ expired: true });
  });

  it('retries a failed close-out and reports nothing extra when a retry lands (#12084)', async () => {
    vi.useFakeTimers();
    const updates = recordUpdates([[{ id: 'exec-1' }]]);
    const recorded = updateMock.getMockImplementation()!;
    updateMock.mockImplementationOnce(() => { throw new Error('db blip'); });
    updateMock.mockImplementation(recorded);
    const detail: ApprovalWaitDetail = {};

    const waiting = waitForApproval('exec-1', 0, undefined, detail);
    await vi.runAllTimersAsync();

    await expect(waiting).resolves.toBe(false);
    expect(detail).toEqual({ expired: true });
    expect(updates[0]).toEqual({ set: { status: 'rejected', errorMessage: 'Approval timed out' }, where: execPending });
  });

  it('hands the timed-out message to the caller when the close-out cannot be written (#12084)', async () => {
    vi.useFakeTimers();
    updateMock.mockImplementation(() => { throw new Error('db down'); });
    const detail: ApprovalWaitDetail = {};

    const waiting = waitForApproval('exec-1', 0, undefined, detail);
    await vi.runAllTimersAsync();

    await expect(waiting).resolves.toBe(false);
    // Retried, then left to the caller's close-out, which must store the same
    // reason the card shows.
    expect(updateMock).toHaveBeenCalledTimes(3);
    expect(detail).toEqual({ expired: true, closeOutMessage: 'Approval timed out' });
  });

  it('after five poll errors closes the row as "Polling failed": not denied, not expired (#12084)', async () => {
    vi.useFakeTimers();
    selectMock.mockImplementation(() => { throw new Error('db down'); });
    const updates = recordUpdates([[{ id: 'exec-1' }]]);
    const detail: ApprovalWaitDetail = {};

    const waiting = waitForApproval('exec-1', 60_000, undefined, detail);
    await vi.runAllTimersAsync();

    await expect(waiting).resolves.toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(5);
    expect(detail).toEqual({});
    expect(updates[0]).toEqual({ set: { status: 'rejected', errorMessage: 'Polling failed' }, where: execPending });
  });

  it('reports expired when the expiry reaper closed the row', async () => {
    stubSelectOnce([{ status: 'rejected', errorMessage: 'Approval request expired' }]);
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 60_000, undefined, detail)).resolves.toBe(false);

    expect(detail.expired).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not report expired for a denial', async () => {
    stubSelectOnce([{ status: 'rejected', errorMessage: null }]);
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 60_000, undefined, detail)).resolves.toBe(false);

    expect(detail.expired).toBeUndefined();
  });

  it('closes a settled wait as ended, not expired, and only if still pending (#12084)', async () => {
    lockedRequestIds = ['req-1'];
    const updates = recordUpdates([[{ id: 'exec-1' }]]);
    const controller = new AbortController();
    controller.abort();
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 60_000, controller.signal, detail)).resolves.toBe(false);

    expect(detail).toEqual({});
    expect(selectMock).not.toHaveBeenCalled();
    expect(updates).toEqual([
      { set: { status: 'rejected', errorMessage: 'Approval wait ended before a decision was made' }, where: execPending },
      { set: { status: 'expired' }, where: requestPending },
    ]);
  });

  it('does not run an approval that landed just before a settle: the stop wins and the row says so (#12084)', async () => {
    // The pending close-out matches nothing; the approved row is moved out.
    const updates = recordUpdates([[], [{ sessionId: 's1', toolName: 'execute_command' }]]);
    stubSelectOnce([{ orgId: 'org-1' }]); // the session's org, for the audit row
    const controller = new AbortController();
    controller.abort();
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 60_000, controller.signal, detail)).resolves.toBe(false);

    expect(detail).toEqual({});
    // No poll ran: the only read is the session's org for the audit row.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(updates[1]).toEqual({
      set: { status: 'rejected', errorMessage: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE },
      where: {
        op: 'and',
        conds: [
          { op: 'eq', col: 'aiToolExecutions.id', val: 'exec-1' },
          { op: 'eq', col: 'aiToolExecutions.status', val: 'approved' },
        ],
      },
    });
  });

  it('reports a denial that landed just before a settle as denied (#12084)', async () => {
    recordUpdates([[], []]);
    stubSelectOnce([{ status: 'rejected', errorMessage: null }]);
    const controller = new AbortController();
    controller.abort();
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 60_000, controller.signal, detail)).resolves.toBe(false);

    expect(detail).toEqual({ denied: true });
  });

  it('does not report expired for an approval', async () => {
    stubSelectOnce([{ status: 'approved', errorMessage: null }]);
    const detail: ApprovalWaitDetail = {};

    await expect(waitForApproval('exec-1', 60_000, undefined, detail)).resolves.toBe(true);

    expect(detail.expired).toBeUndefined();
  });
});
