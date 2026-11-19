/**
 * Regression: the AI agent could not run ANY approval-gated tool on US prod
 * (every execute_command returned "Tool execution was rejected or timed out",
 * including read-only list_processes). Users had to manually flag the chat.
 *
 * Root cause: waitForApproval() (services/aiAgent.ts) polls ai_tool_executions
 * through the bare `db` pool. The AI Agent SDK runs its session OUTSIDE the
 * request's AsyncLocalStorage DB context (by design — the SDK query() is
 * wrapped in runOutsideDbContext in streamingSessionManager.ts, to avoid
 * holding a request txn open for the whole stream), so inside waitForApproval
 * the `db` proxy resolves to the unprivileged `breeze_app` role with NO
 * `breeze.*` GUCs. ai_tool_executions has forced RLS, so the SELECT matched
 * 0 rows and `if (!execution) return false` fired on the first poll — even
 * after the user clicked Approve (which flips the row to 'approved' via the
 * authenticated, context-bound /approvals route).
 *
 * Same silent-0-row class as #1375; the contextless-write guard doesn't cover
 * SELECT, so nothing surfaced in logs.
 *
 * These tests run against a real DB as `breeze_app` (forced RLS) and call
 * waitForApproval with NO ambient context, exactly as the SDK does. They fail
 * (RED) until waitForApproval establishes a system-scope context for its poll.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { inLastSleep } from './aiApprovalWaitFixtures';
import { db } from '../../db';
import { partners, organizations, users, approvalRequests } from '../../db/schema';
import { aiSessions, aiToolExecutions } from '../../db/schema/ai';
import {
  waitForApproval,
  AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
  type ApprovalWaitDetail,
} from '../../services/aiAgent';

let orgId: string;
let userId: string;
let sessionId: string;

beforeEach(async () => {
  // Seed on the superuser test connection (bypasses RLS). setup.ts TRUNCATEs
  // users/partners CASCADE per test, clearing the ai_* rows transitively.
  const tdb = getTestDb();
  const sfx = `${Date.now()}-${Math.floor(performance.now())}`;
  const [p] = await tdb
    .insert(partners)
    .values({ name: 'AI Approval RLS', slug: `ai-appr-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [o] = await tdb
    .insert(organizations)
    .values({ currencyCode: 'USD', partnerId: p!.id, name: 'AI Approval Org', slug: `ai-appr-org-${sfx}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [u] = await tdb
    .insert(users)
    .values({ partnerId: p!.id, email: `ai-appr-${sfx}@test.local`, name: 'Approver', status: 'active' })
    .returning({ id: users.id });
  userId = u!.id;
  const [s] = await tdb
    .insert(aiSessions)
    .values({ orgId, userId, type: 'general', model: 'claude-sonnet-5-5' })
    .returning({ id: aiSessions.id });
  sessionId = s!.id;
});

async function seedExecution(
  status: 'pending' | 'approved' | 'rejected',
  errorMessage: string | null = null,
): Promise<string> {
  const tdb = getTestDb();
  const [row] = await tdb
    .insert(aiToolExecutions)
    .values({
      sessionId,
      toolName: 'execute_command',
      toolInput: { deviceId: 'd', commandType: 'kill_process' },
      status,
      errorMessage,
    })
    .returning({ id: aiToolExecutions.id });
  return row!.id;
}

async function readRow(executionId: string) {
  const [row] = await getTestDb()
    .select({ status: aiToolExecutions.status, errorMessage: aiToolExecutions.errorMessage })
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.id, executionId));
  return row;
}

describe('waitForApproval — polls ai_tool_executions with RLS context (SDK path)', () => {
  // Self-defense against a vacuous environment. The "approved → true" assertion
  // below only proves the fix if forced RLS is actually filtering — i.e. the app
  // `db` pool is the non-bypass `breeze_app` role. On a misconfigured BYPASSRLS
  // connection (e.g. a fresh worktree missing the .env.test symlink) the poll
  // would find the row and pass even with the fix reverted. This probe makes
  // that misconfiguration fail loudly instead: a contextless bare-pool read
  // MUST be hidden by RLS.
  it('forced RLS actually hides the row from a contextless bare-pool read', async () => {
    const executionId = await seedExecution('approved');
    const rows = await db
      .select({ id: aiToolExecutions.id })
      .from(aiToolExecutions)
      .where(eq(aiToolExecutions.id, executionId));
    expect(rows).toHaveLength(0);
  });

  it('returns true for an approved execution when called with no ambient DB context', async () => {
    const executionId = await seedExecution('approved');

    // No withDbAccessContext wrapper — mirrors the SDK session loop, which runs
    // outside the request context. Before the fix this resolved to breeze_app
    // with no GUC, saw 0 rows under forced RLS, and returned false.
    const approved = await waitForApproval(executionId, 5_000);

    expect(approved).toBe(true);
  });

  it('returns false for a rejected execution (genuine reject, not a 0-row miss)', async () => {
    const executionId = await seedExecution('rejected');
    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 5_000, undefined, detail);
    expect(approved).toBe(false);
    // #12079: a denial is not an expiry.
    expect(detail.expired).toBeUndefined();
  });

  it('reports a row closed by the approval-expiry reaper as expired, not approved (#12079)', async () => {
    const executionId = await seedExecution('rejected', 'Approval request expired');
    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 5_000, undefined, detail);
    expect(approved).toBe(false);
    expect(detail.expired).toBe(true);
  });

  it('closes a still-pending row when the wait was already settled, without calling it expired (#12084)', async () => {
    const executionId = await seedExecution('pending');
    const controller = new AbortController();
    controller.abort();
    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 5_000, controller.signal, detail);
    expect(approved).toBe(false);
    expect(detail.expired).toBeUndefined();
    const after = await readRow(executionId);
    expect(after).toEqual({ status: 'rejected', errorMessage: 'Approval wait ended before a decision was made' });
  });

  it('marks a never-approved execution rejected on timeout (the wrapped timeout write)', async () => {
    // The timeout-path UPDATE was the same silent-0-row class as the SELECT:
    // pre-fix it ran on the bare pool and matched 0 rows under RLS, leaving the
    // row stuck 'pending'. With the wrap it must now flip to 'rejected'. Short
    // timeout so the poll exhausts quickly; assert on terminal row state (read
    // back on the superuser conn) rather than tight timing.
    const executionId = await seedExecution('pending');

    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 250, undefined, detail);
    expect(approved).toBe(false);
    // #12079: the card says it expired; the row still says not approved.
    expect(detail.expired).toBe(true);

    const [after] = await getTestDb()
      .select({ status: aiToolExecutions.status, errorMessage: aiToolExecutions.errorMessage })
      .from(aiToolExecutions)
      .where(eq(aiToolExecutions.id, executionId));
    expect(after!.status).toBe('rejected');
    expect(after!.errorMessage).toBe('Approval timed out');
  });
});

describe('waitForApproval — a decision made before the close-out wins (#12084)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function approveRow(executionId: string) {
    await getTestDb()
      .update(aiToolExecutions)
      .set({ status: 'approved', approvedBy: userId, approvedAt: new Date() })
      .where(eq(aiToolExecutions.id, executionId));
  }

  async function denyRow(executionId: string) {
    await getTestDb()
      .update(aiToolExecutions)
      .set({ status: 'rejected', approvedBy: userId, approvedAt: new Date() })
      .where(eq(aiToolExecutions.id, executionId));
  }

  it('an Approve in the last sleep before the timeout is honoured, not overwritten as timed out', async () => {
    const executionId = await seedExecution('pending');
    const { decided } = inLastSleep(() => approveRow(executionId), 400);

    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 200, undefined, detail);
    await decided;

    // The click was answered 200 approved and audited; the wait agrees and the
    // caller runs the action. The stored row is still the approval.
    expect(approved).toBe(true);
    expect(detail.expired).toBeUndefined();
    expect(await readRow(executionId)).toEqual({ status: 'approved', errorMessage: null });
  });

  it('a Deny in the last sleep before the timeout reads as denied, not expired', async () => {
    const executionId = await seedExecution('pending');
    const { decided } = inLastSleep(() => denyRow(executionId), 400);

    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 200, undefined, detail);
    await decided;

    expect(approved).toBe(false);
    expect(detail.expired).toBeUndefined();
    expect(detail.denied).toBe(true);
    expect(await readRow(executionId)).toEqual({ status: 'rejected', errorMessage: null });
  });

  it('an Approve still committing when the close-out runs is honoured (row lock, not a stale read)', async () => {
    const executionId = await seedExecution('pending');
    let releaseApproval!: () => void;
    const approvalHeld = new Promise<void>((resolve) => { releaseApproval = resolve; });
    let approvalTx: Promise<void> | undefined;
    const { decided } = inLastSleep(async () => {
      let updated!: () => void;
      const rowLocked = new Promise<void>((resolve) => { updated = resolve; });
      // The approve request's transaction has written the row but not
      // committed yet when the wait reaches its close-out.
      approvalTx = getTestDb().transaction(async (tx) => {
        await tx
          .update(aiToolExecutions)
          .set({ status: 'approved', approvedBy: userId, approvedAt: new Date() })
          .where(eq(aiToolExecutions.id, executionId));
        updated();
        await approvalHeld;
      });
      await rowLocked;
    }, 300);

    const waiting = waitForApproval(executionId, 150, undefined, {});
    await decided;
    // Wait until the close-out is actually blocked on the row lock, then
    // commit the approval.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await getTestDb().execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
      );
      if ((rows as unknown as Array<{ n: number }>)[0]!.n > 0) break;
      if (Date.now() > deadline) throw new Error('the close-out never blocked on the row lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    releaseApproval();
    await approvalTx;

    expect(await waiting).toBe(true);
    expect(await readRow(executionId)).toEqual({ status: 'approved', errorMessage: null });
  });

  it('an Approve that lands just before a settle (interrupt / stop / new message) does not run, and the row says why', async () => {
    const executionId = await seedExecution('pending');
    const controller = new AbortController();
    const { decided } = inLastSleep(async () => {
      await approveRow(executionId);
      controller.abort();
    }, 50);

    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 60_000, controller.signal, detail);
    await decided;

    // The stop wins. The row is not left 'approved' for an action that never
    // ran; it records that it was approved and the turn stopped.
    expect(approved).toBe(false);
    expect(detail).toEqual({});
    expect(await readRow(executionId)).toEqual({
      status: 'rejected',
      errorMessage: AI_APPROVAL_STOPPED_AFTER_APPROVAL_MESSAGE,
    });
  });

  it('a Deny that lands just before a settle reads as denied', async () => {
    const executionId = await seedExecution('pending');
    const controller = new AbortController();
    const { decided } = inLastSleep(async () => {
      await denyRow(executionId);
      controller.abort();
    }, 50);

    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 60_000, controller.signal, detail);
    await decided;

    expect(approved).toBe(false);
    expect(detail).toEqual({ denied: true });
    expect(await readRow(executionId)).toEqual({ status: 'rejected', errorMessage: null });
  });

  it('the timeout close-out expires the linked mobile approval request in the same transaction', async () => {
    const executionId = await seedExecution('pending');
    const [request] = await getTestDb()
      .insert(approvalRequests)
      .values({
        userId,
        executionId,
        requestingClientLabel: 'Breeze AI',
        actionLabel: 'Run a command',
        actionToolName: 'execute_command',
        riskTier: 'medium',
        riskSummary: 'test',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      } as never)
      .returning({ id: approvalRequests.id });
    const { decided } = inLastSleep(async () => undefined, 400);

    const approved = await waitForApproval(executionId, 200, undefined, {});
    await decided;

    expect(approved).toBe(false);
    // A mobile Approve after this point loses its CAS on approval_requests
    // ("already decided") instead of being told "approved" for an action
    // that will not run.
    const [after] = await getTestDb()
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, request!.id));
    expect(after!.status).toBe('expired');
  });

  it('with no decision, the timeout still closes the row as timed out (nothing runs)', async () => {
    const executionId = await seedExecution('pending');
    const { decided } = inLastSleep(async () => undefined, 400);

    const detail: ApprovalWaitDetail = {};
    const approved = await waitForApproval(executionId, 200, undefined, detail);
    await decided;

    expect(approved).toBe(false);
    expect(detail.expired).toBe(true);
    expect(await readRow(executionId)).toEqual({ status: 'rejected', errorMessage: 'Approval timed out' });
  });
});
