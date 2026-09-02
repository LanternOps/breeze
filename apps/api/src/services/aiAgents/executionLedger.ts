/**
 * The execution ledger (AI agents wave 4a, Task 1).
 *
 * Every agent run gets exactly one `ai_sessions` row (`type: 'agent'`), and
 * every ALLOWED tool call within that run gets a real `ai_tool_executions`
 * row — replacing the `'(inline)'` placeholder `runLoop.ts` has written since
 * wave 3. This module is pure persistence: it has no opinion on whether a
 * call was allowed. Authorization is decided entirely by
 * `checkAgentGuardrails` before any of these functions are ever called — see
 * `runLoop.ts`'s pre-tool-use hook. A ledger write failing must never block a
 * tool call; the caller (Task 2) is responsible for treating these functions
 * as best-effort.
 *
 * Tool OUTPUT is deliberately not persisted here: `ai_tool_executions.tool_output`
 * stays NULL. Redaction rules for what is safe to store land with Part B's
 * closed operation manifest — storing raw outputs now would put unredacted
 * command results into a table with no redaction contract yet.
 *
 * All writes run in a SYSTEM db context (matching the pattern already used by
 * `runService.transitionRunStatus`): `ai_tool_executions` has no `org_id` of
 * its own (tenancy is derived through `session_id → ai_sessions`, registered
 * as such in `rls-coverage.integration.test.ts`), so an ambient request
 * context would be the wrong scope to write these rows under even when one is
 * open, and the run loop generally holds none at all (see the DB-context note
 * atop `runLoop.ts`).
 */
import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { aiSessions, aiToolExecutions } from '../../db/schema/ai';
import { aiAgentRuns } from '../../db/schema/aiAgents';

/**
 * Same skip-if-already-system shape as `runService.inSystemDbContext` /
 * `runLoop.inSystemDbContext`: a bare system wrapper is a no-op inside an
 * ambient request context (so exit first), and re-entering from an
 * already-system context would take a SECOND pooled connection while the
 * first is still held.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

export interface CreateAgentRunSessionArgs {
  runId: string;
  agentId: string;
  orgId: string;
  deviceId: string | null;
  model: string;
  /** The run's policy-snapshot `maxTurnsPerRun`; `ai_sessions.max_turns` has no meaningful default for an agent run. */
  maxTurns: number;
}

/**
 * Creates the run's `ai_sessions` row and CAS-links it onto
 * `ai_agent_runs.session_id` (`WHERE session_id IS NULL`).
 *
 * The CAS exists because a crashed run can be re-delivered by the queue
 * (`executeAgentRun`'s own `transitionRunStatus(runId, 'queued', 'running')`
 * CAS is the first line of defense, but a run already in `running` when the
 * process died is re-entered by a reaper, not by that CAS) — a second call for
 * the same run must not orphan a second session row. On a CAS miss the
 * just-inserted session is immediately closed (nothing will ever write to it)
 * and the run's EXISTING session id is returned instead, so ledger rows from
 * this attempt land where a reviewer already expects them.
 */
export async function createAgentRunSession(args: CreateAgentRunSessionArgs): Promise<string> {
  return inSystemDbContext(async () => {
    const [inserted] = await db
      .insert(aiSessions)
      .values({
        orgId: args.orgId,
        deviceId: args.deviceId,
        agentId: args.agentId,
        type: 'agent',
        model: args.model,
        maxTurns: args.maxTurns,
        status: 'active',
      })
      .returning({ id: aiSessions.id });
    if (!inserted) throw new Error('createAgentRunSession: ai_sessions insert returned no row');
    const sessionId = inserted.id;

    const cas = await db
      .update(aiAgentRuns)
      .set({ sessionId })
      .where(and(eq(aiAgentRuns.id, args.runId), isNull(aiAgentRuns.sessionId)))
      .returning({ id: aiAgentRuns.id });

    if (cas.length > 0) return sessionId;

    console.warn('[executionLedger] session CAS missed — a session already exists for this run', {
      runId: args.runId, orphanedSessionId: sessionId,
    });

    // ai_sessions has no terminal-outcome column (status is only
    // 'active'|'closed'|'expired' — 2026-09-02 baseline). The orphan is simply
    // closed, matching the existing close-on-done convention elsewhere in the
    // codebase (e.g. routes/clientAi/sessions.ts).
    await db.update(aiSessions).set({ status: 'closed' }).where(eq(aiSessions.id, sessionId));

    const [existing] = await db
      .select({ sessionId: aiAgentRuns.sessionId })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, args.runId))
      .limit(1);

    if (!existing?.sessionId) {
      // Unreachable barring a concurrent hard-delete of the run row: the CAS
      // predicate `session_id IS NULL` returned zero rows, which means the
      // column is non-null right now. Thrown loudly rather than silently
      // falling back to the orphan, which would defeat the whole CAS.
      throw new Error(
        `createAgentRunSession: CAS miss for run ${args.runId} but no existing session id was found`,
      );
    }
    return existing.sessionId;
  });
}

export interface StartToolExecutionArgs {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** Inserts an in-flight `ai_tool_executions` row for an ALLOWED tool call. */
export async function startToolExecution(args: StartToolExecutionArgs): Promise<string> {
  return inSystemDbContext(async () => {
    const [inserted] = await db
      .insert(aiToolExecutions)
      .values({
        sessionId: args.sessionId,
        toolName: args.toolName,
        toolInput: args.toolInput,
        status: 'executing',
      })
      .returning({ id: aiToolExecutions.id });
    if (!inserted) throw new Error('startToolExecution: ai_tool_executions insert returned no row');
    return inserted.id;
  });
}

export interface CompleteToolExecutionArgs {
  executionId: string;
  isError: boolean;
  durationMs: number;
}

/** Terminal-marks a tool-execution row. `tool_output` is deliberately never written — see module docstring. */
export async function completeToolExecution(args: CompleteToolExecutionArgs): Promise<void> {
  await inSystemDbContext(async () => {
    await db
      .update(aiToolExecutions)
      .set({
        status: args.isError ? 'failed' : 'completed',
        durationMs: args.durationMs,
        completedAt: new Date(),
      })
      .where(eq(aiToolExecutions.id, args.executionId));
  });
}

/**
 * Terminal-marks every execution still `executing` for this session. Called
 * once at run finish so a process that died mid-tool-call (or a bug in the
 * pre/post hook pairing) never leaves a row stuck in-flight forever. Returns
 * the number of rows reconciled, for logging.
 */
export async function reconcileHungExecutions(sessionId: string): Promise<number> {
  return inSystemDbContext(async () => {
    const rows = await db
      .update(aiToolExecutions)
      .set({
        status: 'failed',
        errorMessage: 'run finished with execution unresolved',
        completedAt: new Date(),
      })
      .where(and(eq(aiToolExecutions.sessionId, sessionId), eq(aiToolExecutions.status, 'executing')))
      .returning({ id: aiToolExecutions.id });
    return rows.length;
  });
}

/**
 * Closes the run's session. `status` reflects the RUN's outcome for callers
 * and future logging, but `ai_sessions.status` only ever lands on `'closed'`
 * here — the enum has no completed/failed distinction, and that distinction
 * already lives durably on `ai_agent_runs.status`.
 */
export async function closeAgentRunSession(
  sessionId: string,
  status: 'completed' | 'failed',
): Promise<void> {
  console.info('[executionLedger] closing agent run session', { sessionId, runOutcome: status });
  await inSystemDbContext(async () => {
    await db.update(aiSessions).set({ status: 'closed' }).where(eq(aiSessions.id, sessionId));
  });
}
