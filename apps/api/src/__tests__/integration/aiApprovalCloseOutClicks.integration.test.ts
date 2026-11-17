/**
 * #12084 review follow-up: the approval-wait close-out (`waitForApproval`'s
 * `closeOutApprovalWait`) against the REAL click paths on a real database:
 * the chat Approve (`handleApproval` + the route's `getDecidedExecutionOutcome`
 * 409), the mobile decide (`decideApprovalRequest`), and a decide holding its
 * locks while the close-out runs. Also: a zero wait budget never honours an
 * approval, a stop that beats an approval is recorded on the mobile request
 * and in the audit log. (The PAM stale-request expirer case lives in
 * `pamExpiryClosesAiExecution.integration.test.ts`.)
 */
import './setup';

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { aiSessions, aiToolExecutions, approvalRequests, auditLogs } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
  getDecidedExecutionOutcome,
  handleApproval,
  waitForApproval,
  type ApprovalWaitDetail,
} from '../../services/aiAgent';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
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

/** The backend pid of a transaction, so lock waits can be traced back to it. */
async function backendPid(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }): Promise<number> {
  const rows = (await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`)) as unknown as Array<{ pid: number }>;
  return rows[0]!.pid;
}

/**
 * Wait until at least `n` backends are blocked, directly or through a queue of
 * other waiters, behind `holderPid`. Traced through `pg_blocking_pids`, so an
 * unrelated lock wait elsewhere in the database cannot satisfy it.
 */
async function untilBlockedBehind(holderPid: number, n = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = (await getTestDb().execute(
      sql`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
    )) as unknown as Array<{ pid: number; blockers: number[] }>;
    const behind = new Set<number>([holderPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (!behind.has(row.pid) && row.blockers.some((b) => behind.has(b))) {
          behind.add(row.pid);
          grew = true;
        }
      }
    }
    if (behind.size - 1 >= n) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${n} statement(s) ever blocked behind backend ${holderPid}`);
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
    let decidePid = 0;

    // The mobile decide's order: CAS the approval_requests row (taking its
    // lock), then mirror onto the execution row, in one transaction.
    const { decided } = inLastSleep(async () => {
      let casDone!: () => void;
      const cas = new Promise<void>((resolve) => { casDone = resolve; });
      decideTx = getTestDb().transaction(async (tx) => {
        decidePid = await backendPid(tx);
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
      // The close-out is queued behind the decide's lock.
      await untilBlockedBehind(decidePid, 1);
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
    let holderPid = 0;
    const holder = getTestDb().transaction(async (tx) => {
      holderPid = await backendPid(tx);
      await tx.execute(sql`SELECT id FROM approval_requests WHERE id = ${requestId} FOR UPDATE`);
      locked();
      await held;
    });
    await requestLocked;
    let decideRun: Promise<{ httpStatus: number }> | undefined;
    try {
      const { decided } = inLastSleep(async () => {
        decideRun = mobileDecide(requestId);
        await untilBlockedBehind(holderPid, 1);
      }, 300);
      const waiting = waitForApproval(executionId, 150, undefined, {});
      await decided;
      // The decide, then the close-out, are queued behind the holder.
      await untilBlockedBehind(holderPid, 2);
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

  it('a chat click queued behind the close-out on the same request: no deadlock, the click is refused as expired', async () => {
    const warn = vi.spyOn(console, 'warn');
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const requestLocked = new Promise<void>((resolve) => { locked = resolve; });
    let holderPid = 0;
    const holder = getTestDb().transaction(async (tx) => {
      holderPid = await backendPid(tx);
      await tx.execute(sql`SELECT id FROM approval_requests WHERE id = ${requestId} FOR UPDATE`);
      locked();
      await held;
    });
    await requestLocked;
    let click: Promise<boolean> | undefined;
    try {
      // The close-out queues on the request first. A click that took the
      // execution row before the request would then deadlock with it.
      inLastSleep(async () => undefined, 50);
      const waiting = waitForApproval(executionId, 20, undefined, {});
      await untilBlockedBehind(holderPid, 1);
      click = chatApprove(executionId);
      await untilBlockedBehind(holderPid, 2);
      release();
      await holder;

      expect(await waiting).toBe(false);
      expect(await click).toBe(false);
    } finally {
      release();
      await holder.catch(() => undefined);
      await click?.catch(() => undefined);
    }
    expect(closeOutFailures(warn)).toEqual([]);
    expect(await asUser(() => getDecidedExecutionOutcome(executionId, sessionId))).toBe('expired');
    expect((await readRequest(requestId))!.status).toBe('expired');
  });
});

describe('a stop that beats an approval is recorded (#12084 review item 3)', () => {
  it('a zero budget after a mobile approve: the request reads approved-not-run, audited with the approver', async () => {
    const executionId = await seedExecution();
    const requestId = await seedMobileRequest(executionId);
    expect((await mobileDecide(requestId)).httpStatus).toBe(200);

    expect(await waitForApproval(executionId, 0, new AbortController().signal, {})).toBe(false);

    expect(await readRequest(requestId)).toEqual({
      status: 'denied',
      refusalReason: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
    });
    const audits = await stopAuditRows(executionId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ executionId, approvedBy: userId, approvalRequestIds: [requestId] });
  });

  it('a stop over an approved execution whose mobile request is still pending expires the request', async () => {
    // e.g. approved through another path while the mobile card was still open.
    const executionId = await seedExecution('approved');
    const requestId = await seedMobileRequest(executionId);
    const controller = new AbortController();
    controller.abort();

    expect(await waitForApproval(executionId, 60_000, controller.signal, {})).toBe(false);

    expect(await readRequest(requestId)).toEqual({ status: 'expired', refusalReason: null });
    // A mobile Approve now loses its CAS instead of being told approved.
    expect((await mobileDecide(requestId)).httpStatus).toBe(409);
  });

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
