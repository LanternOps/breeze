/**
 * The planning snapshot: the frozen facts a recipe's `buildPlan` reads
 * (Recipe Library W06 R1a-0, plan Amendment A.3 refinement 1 and A.4 "Seal
 * semantics").
 *
 * A recipe that declares `planningSnapshotStepKey` gets its plan facts from
 * ONE envelope `{ version: 1, capturedAt, facts }` written into that step
 * row's `checkpoint.planningSnapshot`, and the task checkpoint carries
 * `planningSnapshot: { stepId, digest }`. The writer is the recipe's own
 * discover advancer (R1a); this module only seals and loads.
 *
 * THE SEAL IS UNCHANGED. The plan's effect seal is still the six projected
 * fields of `buildPlan(input, facts)`; the facts are never sealed directly.
 * The digest here is integrity metadata over the stored facts, computed with
 * the same canonicalizer and hash as `argumentDigest` — there is no second
 * canonicalizer.
 *
 * FAIL CLOSED, NEVER `{}`. Every way the snapshot can be absent, foreign,
 * unsettled, malformed or altered is a typed failure. The caller decides
 * fail-vs-hand-off from whether an approval exists; it never substitutes
 * empty facts for a recipe that declared a snapshot.
 *
 * TENANCY. The read runs in system scope (RLS bypassed), so the explicit
 * `org_id` + `task_id` + `id` predicates ARE the isolation, and the returned
 * row is re-checked against them before it is trusted.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { TaskCheckpoint } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorTaskSteps } from '../../db/schema/aiOperatorTaskGraph';
import type { AiOperatorTaskRow } from '../../db/schema/aiOperatorTasks';
import { canonicalizeArguments, computeArgumentDigest } from '../actionIntents/canonicalize';
import type { DiscoveryFacts, RecipeDefinition } from './recipes/types';

export const PLANNING_SNAPSHOT_VERSION = 1 as const;

export interface PlanningSnapshotEnvelope {
  version: typeof PLANNING_SNAPSHOT_VERSION;
  capturedAt: string;
  facts: DiscoveryFacts;
}

const planningSnapshotEnvelopeSchema = z.object({
  version: z.literal(PLANNING_SNAPSHOT_VERSION),
  capturedAt: z.string().datetime(),
  facts: z.record(z.string(), z.unknown()),
}).strict();

function factsDigest(facts: DiscoveryFacts): string {
  return computeArgumentDigest(canonicalizeArguments(facts as Record<string, unknown>));
}

/**
 * Pure. Seal `facts` into an envelope and its digest. The facts are
 * normalized through JSON first, so the envelope holds exactly what a jsonb
 * column will hand back and the digest is computed over that — a `Date` or an
 * `undefined` member cannot make a stored snapshot fail its own digest.
 */
export function sealPlanningSnapshot(
  facts: DiscoveryFacts,
  capturedAt: Date,
): { envelope: PlanningSnapshotEnvelope; digest: string } {
  const stored = JSON.parse(JSON.stringify(facts)) as DiscoveryFacts;
  return {
    envelope: { version: PLANNING_SNAPSHOT_VERSION, capturedAt: capturedAt.toISOString(), facts: stored },
    digest: factsDigest(stored),
  };
}

export type PlanningSnapshotFailureReason =
  | 'snapshot_required' | 'snapshot_unexpected' | 'snapshot_missing' | 'snapshot_wrong_step'
  | 'snapshot_not_settled' | 'snapshot_malformed' | 'snapshot_digest_mismatch';

export type PlanningSnapshotLoad =
  | { ok: true; facts: DiscoveryFacts }
  | { ok: false; reason: PlanningSnapshotFailureReason; detail: string };

const fail = (reason: PlanningSnapshotFailureReason, detail: string): PlanningSnapshotLoad => ({ ok: false, reason, detail });

/**
 * The facts `buildPlan` must be called with for this task.
 *
 * - Recipe declares no snapshot step AND the checkpoint carries none: `{}`,
 *   exactly today's behaviour, with no read.
 * - Any disagreement, or any row/envelope/digest failure: a typed failure.
 *
 * Reads `ai_operator_task_steps` by `(org_id, task_id, id)` under
 * `withSystemDbAccessContext`. Throws only on I/O, so the wake retries.
 */
export async function loadPlanningFacts(
  task: Pick<AiOperatorTaskRow, 'id' | 'orgId'>,
  recipe: RecipeDefinition<never>,
  checkpoint: TaskCheckpoint,
): Promise<PlanningSnapshotLoad> {
  const stepKey = recipe.planningSnapshotStepKey;
  const ref = checkpoint.planningSnapshot;
  if (stepKey === undefined && ref === undefined) return { ok: true, facts: {} };
  if (stepKey === undefined) {
    return fail('snapshot_unexpected', `the checkpoint carries a planning snapshot but workflow '${recipe.key}' declares no snapshot step`);
  }
  if (ref === undefined) {
    return fail('snapshot_required', `workflow '${recipe.key}' plans from step '${stepKey}' but the task has no planning snapshot`);
  }

  const row = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [found] = await db
      .select({
        id: aiOperatorTaskSteps.id,
        orgId: aiOperatorTaskSteps.orgId,
        taskId: aiOperatorTaskSteps.taskId,
        stepKey: aiOperatorTaskSteps.stepKey,
        state: aiOperatorTaskSteps.state,
        checkpoint: aiOperatorTaskSteps.checkpoint,
      })
      .from(aiOperatorTaskSteps)
      .where(and(
        eq(aiOperatorTaskSteps.orgId, task.orgId),
        eq(aiOperatorTaskSteps.taskId, task.id),
        eq(aiOperatorTaskSteps.id, ref.stepId),
      ))
      .limit(1);
    return found ?? null;
  }));

  // Re-checked in code as well as in SQL: a row from another task or org is
  // never trusted, whatever returned it.
  if (!row || row.orgId !== task.orgId || row.taskId !== task.id || row.id !== ref.stepId) {
    return fail('snapshot_missing', `planning snapshot step ${ref.stepId} is not a step of this task`);
  }
  if (row.stepKey !== stepKey) {
    return fail('snapshot_wrong_step', `planning snapshot step ${ref.stepId} is '${row.stepKey}', not '${stepKey}'`);
  }
  if (row.state !== 'succeeded') {
    return fail('snapshot_not_settled', `planning snapshot step '${stepKey}' is ${row.state}, not succeeded`);
  }
  const envelope = planningSnapshotEnvelopeSchema.safeParse(
    (row.checkpoint as Record<string, unknown> | null)?.planningSnapshot,
  );
  if (!envelope.success) {
    return fail('snapshot_malformed', `planning snapshot on step '${stepKey}' does not parse: ${
      envelope.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ').slice(0, 300)}`);
  }
  let digest: string;
  try {
    digest = factsDigest(envelope.data.facts);
  } catch (err) {
    return fail('snapshot_malformed', `planning snapshot facts cannot be canonicalized: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (digest !== ref.digest) {
    return fail('snapshot_digest_mismatch', `planning snapshot on step '${stepKey}' no longer matches its recorded digest`);
  }
  return { ok: true, facts: envelope.data.facts };
}
