/**
 * Wisp W07 Task 5 — the post-run dispatch of an assessment's recorded
 * `request_specialist` calls (Wisp design §7.5).
 *
 * The outcome tool is validate-only: during the run the post-tool hook only
 * captures each call into `outcome.assessment.specialistRequests`. After the
 * model's turn, `executeAgentRun` calls this right after `finalizeAssessment`
 * and before `finishRun`, and the deterministic coordinator decides each
 * request in call order:
 *
 *   - ordinal i → requestId = deriveRequestId(run.id, i), so a retried
 *     finalizer re-sends the SAME ids and the coordinator dedupes;
 *   - i ≥ MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT → `too_many_requests`
 *     without calling the coordinator;
 *   - a throw for one request is reported and recorded `dispatch_failed`; it
 *     never stops the others and never fails the run.
 *
 * The results land on `outcome.assessment.specialistResults` twice: in memory
 * (so `finishRun`, which serializes `result.outcome`, writes them with the rest
 * of the outcome) and as a targeted jsonb merge of just that key onto the run
 * row in system context (so they survive a `finishRun` that loses its CAS to a
 * reaper after children were already admitted). Dark unless `wispEnabled()`.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { RequestSpecialistInput, SpecialistRequestResult } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { wispEnabled } from '../../config/env';
import { captureException } from '../sentry';
import type { LoopResult, RunContext } from '../aiAgents/runLoopTypes';
import { deriveRequestId, requestSpecialist, type RequestSpecialistResult } from './coordinator';
import { MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT } from './specialistPolicy';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** Never spawn children under a run another executor, the reaper or a cancel already moved on. */
async function isRunStillRunning(runId: string, orgId: string): Promise<boolean> {
  return inSystemDbContext(async () => {
    const [row] = await db.select({ status: aiAgentRuns.status }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.orgId, orgId)))
      .limit(1);
    return row?.status === 'running';
  });
}

/** Narrow the coordinator's union to the persisted shape (drops e.g. a bulk-reply `report`). */
function toResult(
  requestId: string,
  req: RequestSpecialistInput,
  r: RequestSpecialistResult,
): SpecialistRequestResult {
  const base = { requestId, kind: req.kind };
  if ('admitted' in r) {
    return {
      ...base,
      admitted: true,
      ...(r.runId ? { runId: r.runId } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}),
    };
  }
  if ('needsApproval' in r) return { ...base, needsApproval: true, intentId: r.intentId };
  return { ...base, refused: r.refused, ...(r.detail ? { detail: r.detail } : {}) };
}

export async function dispatchSpecialistRequests(ctx: RunContext, result: LoopResult): Promise<void> {
  const { run } = ctx;
  const grantId = run.grantId;
  const grantRevisionId = run.grantRevisionId;
  if (run.profile !== 'assessment' || !grantId || !grantRevisionId) return;
  if (!wispEnabled()) return;
  const assessment = result.outcome.assessment;
  const requests = assessment?.specialistRequests ?? [];
  if (!assessment || requests.length === 0) return;
  if (!(await isRunStillRunning(run.id, run.orgId))) {
    console.warn('[wispSpecialistDispatch] skipped — run left `running` first', { runId: run.id });
    return;
  }

  const results: SpecialistRequestResult[] = [];
  for (const [i, req] of requests.entries()) {
    const requestId = deriveRequestId(run.id, i);
    if (i >= MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT) {
      results.push({ requestId, kind: req.kind, refused: 'too_many_requests' });
      continue;
    }
    try {
      const decided = await requestSpecialist(
        { grantId, grantRevisionId, orgId: run.orgId, kind: req.kind, params: req.params, requestedByRunId: run.id },
        { requester: { kind: 'run' }, requestId, reason: req.reason },
      );
      results.push(toResult(requestId, req, decided));
    } catch (error) {
      console.error('[wispSpecialistDispatch] specialist request failed', { runId: run.id, requestId, kind: req.kind, error });
      captureException(error, undefined, {
        service: 'wisp', operation: 'dispatchSpecialistRequests', runId: run.id, kind: req.kind,
      });
      results.push({ requestId, kind: req.kind, refused: 'dispatch_failed' });
    }
  }

  assessment.specialistResults = results;

  try {
    const payload = JSON.stringify(results);
    await inSystemDbContext(() => db.update(aiAgentRuns)
      .set({
        outcome: sql`jsonb_set(
          coalesce(${aiAgentRuns.outcome}, '{}'::jsonb),
          '{assessment}',
          coalesce(${aiAgentRuns.outcome} -> 'assessment', '{}'::jsonb)
            || jsonb_build_object('specialistResults', ${payload}::jsonb),
          true
        )`,
      })
      .where(and(eq(aiAgentRuns.id, run.id), eq(aiAgentRuns.orgId, run.orgId))));
  } catch (error) {
    // finishRun still writes the in-memory copy; only the CAS-lost case loses them.
    console.error('[wispSpecialistDispatch] failed to persist specialistResults', { runId: run.id, error });
    captureException(error, undefined, { service: 'wisp', operation: 'dispatchSpecialistRequests.persist', runId: run.id });
  }
}
