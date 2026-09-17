import { assessTopologyDiagnosticRun } from './diagnosticHealth';
import { advanceTopologyHealthRevision } from './monitorOverlays';
import { and, eq } from 'drizzle-orm';

import {
  topologyDiagnosticResultSchema,
  type TopologyDiagnosticPlan,
  type TopologyDiagnosticResult,
  type TopologyDiagnosticRun,
  type TopologyDiagnosticStep,
} from '@breeze/shared';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { topologyDiagnosticRuns, topologyDiagnosticSteps } from '../../db/schema';
import { TopologyOperationError } from './operationErrors';

/**
 * The authenticated agent connection a result frame arrived on. Both transports
 * build this from the connection, never from the frame: an origin authenticated
 * through one agent connection cannot submit another origin's result.
 */
export type AuthenticatedTopologyProducer = {
  deviceId: string;
  agentId: string | null;
  /** The `device_commands` row this frame is answering. */
  commandId: string;
};

export type TopologyDiagnosticAcceptance = {
  accepted: boolean;
  /**
   * The evidence was retained but changed no health: the run had already
   * reached a terminal state, or this attempt's steps were already recorded.
   */
  historicalOnly: boolean;
};

export type TopologyDiagnosticSummary = {
  state: 'completed' | 'failed';
  assessment: TopologyDiagnosticRun['assessment'];
  coverage: TopologyDiagnosticRun['coverage'];
  reasons: string[];
};

const TERMINAL_RUN_STATES = ['completed', 'failed', 'cancelled', 'expired'];

/** Outcomes that are real measurement evidence rather than a missing answer. */
const MEASURED_FAILURES = new Set(['failed_check', 'timeout']);

/**
 * Deterministic run-level summary over the FIXED accepted plan.
 *
 * Task 19 replaces this with the shared `assessTopologyDiagnostic` used by the
 * graph health projection; the rules here are the subset the run row needs and
 * follow the same spec: measured failures are evidence, missing or unsupported
 * required evidence is `unknown`, and an orchestration failure is `failed`
 * rather than an unreachable target.
 */
export function summarizeTopologyDiagnosticRun(
  plan: Pick<TopologyDiagnosticPlan, 'steps'>,
  steps: TopologyDiagnosticStep[],
  options: { now?: Date } = {},
): TopologyDiagnosticSummary {
  // One assessor decides health for the run row and the graph projection, so
  // the two can never disagree about the same evidence.
  // Steps in an accepted frame are being received now; the agent cannot stamp that.
  const receivedAt = (options.now ?? new Date()).toISOString();
  const { summary } = assessTopologyDiagnosticRun(
    plan as TopologyDiagnosticPlan,
    steps.map((step) => ({ ...step, receivedAt: step.receivedAt ?? receivedAt })),
    options,
  );
  const assessment = summary.status;

  // Run coverage is about the required plan: an unsupported or indeterminate
  // step was answered but measured nothing, so it leaves coverage short.
  const byId = new Map(steps.map((step) => [step.id, step]));
  const required = plan.steps.filter((step) => step.required);
  const measured = required.filter((entry) => {
    const state = byId.get(entry.id)?.state;
    return state === 'succeeded' || (state !== undefined && MEASURED_FAILURES.has(state));
  });
  const coverage: TopologyDiagnosticSummary['coverage'] =
    required.length > 0 && measured.length === required.length
      ? 'complete'
      : measured.length > 0
        ? 'partial'
        : 'none';

  // `failed` is reserved for orchestration failure. An `unsupported` or
  // `skipped` step is a complete, honest agent answer that leaves coverage
  // short; only an indeterminate outcome (or no answer at all) means the run
  // itself did not execute.
  const state: TopologyDiagnosticSummary['state'] =
    steps.length === 0 || steps.every((step) => step.state === 'execution_error')
      ? 'failed'
      : 'completed';

  const reasons = [
    ...new Set([
      ...summary.reasons,
      ...steps
        .map((step) => step.reason)
        .filter((reason): reason is string => typeof reason === 'string'),
    ]),
  ].sort();

  return { state, assessment, coverage, reasons: reasons.slice(0, 64) };
}

/**
 * Transport adapter shared by the WebSocket and REST result paths. The producer
 * identity comes from the authenticated connection and the already-validated
 * command row — never from the frame.
 */
export async function ingestTopologyDiagnosticCommandResult(input: {
  commandType: string;
  deviceId: string;
  agentId: string | null;
  commandId: string;
  result: unknown;
}): Promise<TopologyDiagnosticAcceptance | null> {
  if (input.commandType !== 'network_diagnostic') return null;
  const frame = topologyDiagnosticResultSchema.safeParse(input.result);
  if (!frame.success) {
    // The critical-result validator already rejected a malformed frame before
    // the row went terminal; reaching here means the two disagree, which is a
    // defect worth surfacing rather than a result worth storing.
    throw new TopologyOperationError(
      'diagnostic_result_invalid',
      400,
      'Diagnostic result failed structural validation after acceptance',
    );
  }
  return acceptTopologyDiagnosticResult(
    { deviceId: input.deviceId, agentId: input.agentId, commandId: input.commandId },
    frame.data,
  );
}

const unauthorized = (message: string) =>
  new TopologyOperationError('diagnostic_result_unauthorized', 403, message);

/**
 * Accept one agent result frame.
 *
 * Every identity in the frame is checked against the run the SERVER pinned:
 * the digest is an integrity seal, so a frame that re-points its run, attempt,
 * command or plan is refused rather than stored under someone else's run. Step
 * evidence is inserted with the `(run, attempt, step)` uniqueness the schema
 * already enforces, so a redelivery can never overwrite a recorded outcome.
 */
export async function acceptTopologyDiagnosticResult(
  producer: AuthenticatedTopologyProducer,
  result: TopologyDiagnosticResult,
): Promise<TopologyDiagnosticAcceptance> {
  const frame = topologyDiagnosticResultSchema.parse(result);
  if (frame.commandId !== producer.commandId) {
    throw unauthorized('Diagnostic result does not answer the delivered command');
  }

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [run] = await db
        .select()
        .from(topologyDiagnosticRuns)
        .where(eq(topologyDiagnosticRuns.id, frame.runId))
        .limit(1);
      if (
        !run ||
        run.commandId !== frame.commandId ||
        run.attemptId !== frame.attemptId ||
        run.planDigest !== frame.planDigest
      ) {
        throw unauthorized('Diagnostic result does not match its accepted run');
      }
      if (run.originSnapshot.deviceId !== producer.deviceId) {
        throw unauthorized('Diagnostic result was submitted by another origin');
      }

      const plan = run.plan as TopologyDiagnosticPlan;
      const planStepIds = new Set(plan.steps.map((step) => step.id));
      if (frame.steps.some((step) => !planStepIds.has(step.id))) {
        throw unauthorized('Diagnostic result reports a step outside its accepted plan');
      }

      const alreadyTerminal = TERMINAL_RUN_STATES.includes(run.state);
      const now = new Date();
      const stored = await db
        .insert(topologyDiagnosticSteps)
        .values(
          frame.steps.map((step) => ({
            orgId: run.orgId,
            siteId: run.siteId,
            runId: run.id,
            attemptId: frame.attemptId,
            stepId: step.id,
            commandId: frame.commandId,
            state: step.state,
            result: step,
            historicalOnly: alreadyTerminal,
          })),
        )
        .onConflictDoNothing({
          target: [
            topologyDiagnosticSteps.runId,
            topologyDiagnosticSteps.attemptId,
            topologyDiagnosticSteps.stepId,
          ],
        })
        .returning({ id: topologyDiagnosticSteps.id });

      // A frame that changed nothing is late evidence, not a new outcome.
      if (alreadyTerminal || stored.length === 0) {
        return { accepted: true, historicalOnly: true };
      }

      const summary = summarizeTopologyDiagnosticRun(plan, frame.steps, { now });
      await db
        .update(topologyDiagnosticRuns)
        .set({
          state: summary.state,
          assessment: summary.assessment,
          coverage: summary.coverage,
          reasons: summary.reasons,
          startedAt: run.startedAt ?? now,
          finishedAt: now,
          updatedAt: now,
          ...(summary.state === 'failed' ? { failureReason: 'orchestration_failed' } : {}),
        })
        .where(
          and(
            eq(topologyDiagnosticRuns.id, run.id),
            eq(topologyDiagnosticRuns.state, run.state),
          ),
        );
      // Health moved; structure and layout did not.
      await advanceTopologyHealthRevision(db, { orgId: run.orgId, siteId: run.siteId });
      return { accepted: true, historicalOnly: false };
    }, 'topology diagnostic result acceptance'),
  );
}
