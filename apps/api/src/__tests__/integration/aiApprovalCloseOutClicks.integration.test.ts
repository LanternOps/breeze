/**
 * #12084 review follow-up: the approval-wait close-out (`waitForApproval`'s
 * `closeOutApprovalWait`) against the REAL click paths on a real database:
 * the chat Approve (`handleApproval` + the route's `getDecidedExecutionOutcome`
 * 409), the mobile decide (`decideApprovalRequest`), and a decide holding its
 * locks while the close-out runs. Also: a zero wait budget never honours an
 * approval, a stop that beats an approval is recorded on the mobile request
 * and in the audit log, and the PAM stale-request expirer closes a helper
 * execution row that no close-out managed to close.
 */
import './setup';

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiSessions, aiToolExecutions, approvalRequests, auditLogs, elevationRequests } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
  getDecidedExecutionOutcome,
  handleApproval,
  waitForApproval,
  type ApprovalWaitDetail,
} from '../../services/aiAgent';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import { decideHelperToolAction } from '../../services/pamToolActionGovernance';
import { expireStaleRequests } from '../../jobs/pamJobs';
import { inLastSleep } from './aiApprovalWaitFixtures';
import { orgContext, tenant, toolAuth, type Tenant } from './caughtQueryFixtures';
import { getTestDb } from './setup';

let t: Tenant;
let auth: AuthContext;
let userId: string;
let sessionId: string;

beforeEach(async () => {
  t = await tenant();
  auth = await toolAuth(t);
  userId = auth.user.id;
  const [s] = await getTestDb()
    .insert(aiSessions)
    .values({ orgId: t.orgId, userId, type: 'general', model: 'close-out-model' })
    .returning({ id: aiSessions.id });
  sessionId = s!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** As a request does: the user's own org context, outside any ambient one. */
const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withDbAccessContext({ ...orgContext(t), userId }, fn));

async function seedExecution(status: 'pending' | 'approved' = 'pending'): Promise<string> {
  const [row] = await getTestDb()
    .insert(aiToolExecutions)
    .values({ sessionId, toolName: 'execute_command', toolInput: { deviceId: 'd' }, status })
    .returning({ id: aiToolExecutions.id });
  return row!.id;
}

/** The Tier-2 mobile bridge row the SDK creates beside the execution row. */
async function seedMobileRequest(executionId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(approvalRequests)
    .values({
      userId,
      executionId,
      requestingClientLabel: 'Breeze AI',
      actionLabel: 'Run a command',
      actionToolName: 'execute_command',
      riskTier: 'low',
      riskSummary: 'test',
      status: 'pending',
      expiresAt: new Date(Date.now() + 300_000),
    } as never)
    .returning({ id: approvalRequests.id });
  return row!.id;
}

async function readExecution(executionId: string) {
  const [row] = await getTestDb()
    .select({ status: aiToolExecutions.status, errorMessage: aiToolExecutions.errorMessage })
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.id, executionId));
  return row;
}

async function readRequest(requestId: string) {
  const [row] = await getTestDb()
    .select({ status: approvalRequests.status, refusalReason: approvalRequests.refusalReason })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  return row;
}

async function stopAuditRows(executionId: string) {
  return getTestDb()
    .select({ orgId: auditLogs.orgId, resourceId: auditLogs.resourceId, details: auditLogs.details })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'ai.tool_approval.stopped'), eq(auditLogs.resourceId, executionId)));
}

const mobileDecide = (requestId: string, status: 'approved' | 'denied' = 'approved') =>
  asUser(() => decideApprovalRequest({ auth, id: requestId, status }));

const chatApprove = (executionId: string) => asUser(() => handleApproval(executionId, true, auth, sessionId));

/** Wait until at least `n` backends are blocked on a lock. */
async function untilLocksWait(n = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ n: number }>(
      sql`SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted`,
    );
    if ((rows as unknown as Array<{ n: number }>)[0]!.n >= n) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${n} statement(s) ever blocked on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function closeOutFailures(warn: { mock: { calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter(([message]) => String(message).includes('Approval close-out attempt'));
}

describe('a zero wait budget never honours an approval (#12084 review item 1)', () => {
  it('a row already approved (PAM auto-approve) is refused and closed when the budget is spent', async () => {
    const executionId = await seedExecution('approved');
    const detail: ApprovalWaitDetail = {};

    // Not settled: the signal is live. The cycle's budget is gone (a work-limit
    // stop or a sibling wait spent it), so no poll runs at all.
    expect(await waitForApproval(executionId, 0, new AbortController().signal, detail)).toBe(false);

    // Nothing runs, and the row does not stay approved for a call nobody runs.
    expect(await readExecution(executionId)).toEqual({
      status: 'rejected',
      errorMessage: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
    });
  });

  it('a pending row is closed as timed out (unchanged)', async () => {
    const executionId = await seedExecution('pending');
    const detail: ApprovalWaitDetail = {};
    expect(await waitForApproval(executionId, 0, undefined, detail)).toBe(false);
    expect(detail.expired).toBe(true);
    expect(await readExecution(executionId)).toEqual({ status: 'rejected', errorMessage: 'Approval timed out' });
  });

  it('with budget left, the same approved row runs', async () => {
    const executionId = await seedExecution('approved');
    expect(await waitForApproval(executionId, 5_000, new AbortController().signal, {})).toBe(true);
    expect(await readExecution(executionId)).toEqual({ status: 'approved', errorMessage: null });
  });
});

describe('the close-out takes locks in the mobile decide order (#12084 review item 2)', () => {
  it('a decide holding the mobile request when the close-out starts: no deadlock, the approval is honoured', async () => {
    const warn = vi.spyOn(console, 'warn');
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let decideTx: Promise<void> | undefined;

    // The mobile decide's order: CAS the approval_requests row (taking its
    // lock), then mirror onto the execution row, in one transaction.
    const { decided } = inLastSleep(async () => {
      let casDone!: () => void;
      const cas = new Promise<void>((resolve) => { casDone = resolve; });
      decideTx = getTestDb().transaction(async (tx) => {
        await tx
          .update(approvalRequests)
          .set({ status: 'approved', decidedAt: new Date() })
          .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.status, 'pending')));
        casDone();
        await held;
        await tx
          .update(aiToolExecutions)
          .set({ status: 'approved', approvedBy: userId, approvedAt: new Date() })
          .where(and(eq(aiToolExecutions.id, executionId), eq(aiToolExecutions.status, 'pending')));
      });
      await cas;
    }, 300);

    const waiting = waitForApproval(executionId, 150, undefined, {});
    await decided;
    try {
      await untilLocksWait(1);
    } finally {
      release();
      await decideTx;
    }

    expect(await waiting).toBe(true);
    expect(closeOutFailures(warn)).toEqual([]);
    expect(await readExecution(executionId)).toEqual({ status: 'approved', errorMessage: null });
    expect((await readRequest(requestId))!.status).toBe('approved');
  });

  it('the real mobile decide and the close-out queued on the same request: no deadlock, the approval is honoured', async () => {
    const warn = vi.spyOn(console, 'warn');
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const requestLocked = new Promise<void>((resolve) => { locked = resolve; });
    // Something else (another approver's decide, the expiry reaper) holds the
    // request's row lock, so the mobile decide and then the close-out queue on
    // it in that order. When it is released the decide goes first and needs
    // the execution row next: a close-out that took the execution row before
    // queueing on the request would deadlock with it.
    const holder = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM approval_requests WHERE id = ${requestId} FOR UPDATE`);
      locked();
      await held;
    });
    await requestLocked;
    let decideRun: Promise<{ httpStatus: number }> | undefined;
    try {
      const { decided } = inLastSleep(async () => {
        decideRun = mobileDecide(requestId);
        await untilLocksWait(1);
      }, 300);
      const waiting = waitForApproval(executionId, 150, undefined, {});
      await decided;
      await untilLocksWait(2);
      release();
      await holder;

      expect((await decideRun!).httpStatus).toBe(200);
      expect(await waiting).toBe(true);
    } finally {
      release();
      await holder.catch(() => undefined);
      await decideRun?.catch(() => undefined);
    }
    expect(closeOutFailures(warn)).toEqual([]);
    expect(await readExecution(executionId)).toEqual({ status: 'approved', errorMessage: null });
    expect((await readRequest(requestId))!.status).toBe('approved');
  });
});

describe('a stop that beats an approval is recorded (#12084 review item 3)', () => {
  it('approved on mobile just before the stop: the request reads approved-not-run and one audit row is written', async () => {
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    const controller = new AbortController();
    let decideStatus: number | undefined;
    const { decided } = inLastSleep(async () => {
      decideStatus = (await mobileDecide(requestId)).httpStatus;
      controller.abort();
    }, 50);

    expect(await waitForApproval(executionId, 60_000, controller.signal, {})).toBe(false);
    await decided;

    expect(decideStatus).toBe(200);
    expect(await readExecution(executionId)).toEqual({
      status: 'rejected',
      errorMessage: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
    });
    // The mobile Recent list reads a denied row with a refusal reason as
    // "not approved · <reason>", never as approved.
    expect(await readRequest(requestId)).toEqual({
      status: 'denied',
      refusalReason: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
    });
    const audits = await stopAuditRows(executionId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.orgId).toBe(t.orgId);
    expect(audits[0]!.details).toMatchObject({ executionId, approvalRequestIds: [requestId] });
  });

  it('approved in chat just before the stop: same record', async () => {
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    const controller = new AbortController();
    let clicked: boolean | undefined;
    const { decided } = inLastSleep(async () => {
      clicked = await chatApprove(executionId);
      controller.abort();
    }, 50);

    expect(await waitForApproval(executionId, 60_000, controller.signal, {})).toBe(false);
    await decided;

    expect(clicked).toBe(true);
    expect(await readRequest(requestId)).toEqual({
      status: 'denied',
      refusalReason: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
    });
    expect(await stopAuditRows(executionId)).toHaveLength(1);
  });

  it('a stop with no approval writes no stop audit row', async () => {
    const executionId = await seedExecution();
    const controller = new AbortController();
    controller.abort();
    expect(await waitForApproval(executionId, 60_000, controller.signal, {})).toBe(false);
    expect(await stopAuditRows(executionId)).toHaveLength(0);
  });
});

describe('the real click paths against the close-out (#12084 review item 4)', () => {
  it('a chat click after the timeout close-out is refused, and the 409 says expired', async () => {
    const executionId = await seedExecution();
    expect(await waitForApproval(executionId, 0, undefined, {})).toBe(false);

    expect(await chatApprove(executionId)).toBe(false);
    // What routes/ai.ts answers the refused click with (409 + outcome).
    expect(await asUser(() => getDecidedExecutionOutcome(executionId, sessionId))).toBe('expired');
  });

  it('a double click in the last sleep: one approval, the second click is told approved, and it runs', async () => {
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    let clicks: boolean[] = [];
    const { decided } = inLastSleep(async () => {
      clicks = await Promise.all([chatApprove(executionId), chatApprove(executionId)]);
    }, 400);

    expect(await waitForApproval(executionId, 200, undefined, {})).toBe(true);
    await decided;

    expect(clicks.filter(Boolean)).toHaveLength(1);
    expect(await asUser(() => getDecidedExecutionOutcome(executionId, sessionId))).toBe('approved');
    expect((await readRequest(requestId))!.status).toBe('approved');
  });

  it('a mobile Approve after the close-out loses its CAS and is not told approved', async () => {
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    expect(await waitForApproval(executionId, 0, undefined, {})).toBe(false);

    const res = await mobileDecide(requestId);
    expect(res.httpStatus).toBe(409);
    expect(res.body).toMatchObject({ finalStatus: 'expired' });
    expect(await readExecution(executionId)).toEqual({ status: 'rejected', errorMessage: 'Approval timed out' });
  });

  it('a mobile Approve in the last sleep before a timeout is honoured once', async () => {
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    let status: number | undefined;
    const { decided } = inLastSleep(async () => { status = (await mobileDecide(requestId)).httpStatus; }, 400);

    expect(await waitForApproval(executionId, 200, undefined, {})).toBe(true);
    await decided;
    expect(status).toBe(200);
    expect((await readRequest(requestId))!.status).toBe('approved');
  });
});

describe('a helper/PAM execution no close-out closed (#12084 review item 5)', () => {
  it('the PAM stale-request expirer closes the linked execution row as expired', async () => {
    const executionId = await seedExecution();
    // No PAM rule matches: the elevation request is created pending.
    const decision = await decideHelperToolAction({
      orgId: t.orgId, deviceId: t.deviceId, executionId, toolName: 'execute_command', toolInput: {},
      riskTier: 2, subjectUsername: 'helper-host',
    });
    expect(decision).toBe('pending');
    // Every close-out failed, so the row is still pending; the request is past its TTL.
    await getTestDb()
      .update(elevationRequests)
      .set({ requestedAt: new Date(Date.now() - 24 * 60 * 60_000) })
      .where(eq(elevationRequests.executionId, executionId));

    // As the BullMQ worker runs it: in system scope.
    expect(await withSystemDbAccessContext(() => expireStaleRequests())).toBeGreaterThanOrEqual(1);

    expect(await readExecution(executionId)).toEqual({ status: 'rejected', errorMessage: 'Approval request expired' });
  });
});
