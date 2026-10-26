/**
 * Tool catalog W04 (#5219), plan Task A8 — what a finished flow run tells the
 * rest of the platform.
 *
 *  - `flow.run.completed` / `flow.run.failed` (spec §6.5 step 7) with
 *    `{ flowId, runId, chainDepth, status }`, published AFTER the terminal
 *    write committed. `expired` is published as `flow.run.failed` (the run
 *    did not do its work; `status` says why). `cancelled` publishes nothing:
 *    a human or the platform stopped it on purpose and nothing went wrong.
 *    The run's own id and depth ride on the metadata (Decision 14), so an
 *    event flow listening for `flow.run.*` inherits `chainDepth + 1` and never
 *    re-triggers the flow that produced the event.
 *  - the delegator's in-app notification for an `unknown_outcome` run (a
 *    mutation that may or may not have happened). Pauses notify through
 *    `pauseFlow` itself; this covers the one terminal state that needs a
 *    human without pausing the flow.
 *
 * Both are best effort: the run is already terminal, so a failure here is
 * reported, never thrown into the caller's state machine.
 *
 * Known gap (W05 follow-up): a terminal event whose publish fails is LOST —
 * there is no outbox and no reconciler republish, so an event flow chained on
 * `flow.run.*` silently never fires for that run. Until the outbox lands the
 * failure is at least loud and findable: an error log naming the run, flow
 * and org, and a fingerprinted capture tagged with the same ids.
 */
import type { FlowRunTerminalStatus } from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { publishEvent } from '../eventBus';
import { captureException } from '../sentry';
import { createNotification } from '../userNotifications';

export interface FlowRunEventRef {
  id: string;
  orgId: string;
  flowId: string;
  chainDepth: number;
}

export async function publishFlowRunTerminalEvent(run: FlowRunEventRef, status: FlowRunTerminalStatus): Promise<void> {
  if (status === 'cancelled') return;
  const type = status === 'completed' ? 'flow.run.completed' : 'flow.run.failed';
  try {
    await publishEvent(
      type,
      run.orgId,
      { flowId: run.flowId, runId: run.id, chainDepth: run.chainDepth, status },
      'flow-runner',
      { flowRunId: run.id, flowChainDepth: run.chainDepth },
    );
  } catch (err) {
    console.error(
      `[FlowRunner] failed to publish ${type}; the event is lost (run=${run.id} flow=${run.flowId} org=${run.orgId} status=${status})`,
      err,
    );
    captureException(
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      { org_id: run.orgId, flow_id: run.flowId, flow_run_id: run.id, flow_site: 'runEvents.publish_terminal' },
      { fingerprint: ['flow', 'runEvents.publish_terminal'] },
    );
  }
}

export async function notifyFlowRunUnknownOutcome(input: {
  delegatorUserId: string | null;
  orgId: string;
  flowId: string;
  flowName: string;
  runId: string;
  stepId: string;
}): Promise<void> {
  const userId = input.delegatorUserId;
  if (!userId) return;
  try {
    // Cross-user insert: its own system context (see createNotification).
    await runOutsideDbContext(() => withSystemDbAccessContext(() => createNotification({
      userId,
      orgId: input.orgId,
      type: 'automation',
      priority: 'high',
      title: 'Flow run needs review',
      message: `${input.flowName}: step ${input.stepId} may or may not have taken effect, so the run was stopped instead of retrying it. Check the target and the run before running it again.`,
      link: `/flows/runs/${input.runId}`,
      metadata: { flowId: input.flowId, runId: input.runId, stepId: input.stepId, reason: 'unknown_outcome' },
      dedupeKey: `flow-run-unknown:${input.runId}`,
    }), 'flows.runEvents.notifyUnknownOutcome'));
  } catch (err) {
    console.error(`[FlowRunner] unknown-outcome notification failed (run=${input.runId} flow=${input.flowId} org=${input.orgId})`, err);
    captureException(
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      { org_id: input.orgId, flow_id: input.flowId, flow_run_id: input.runId, flow_site: 'runEvents.notify_unknown_outcome' },
      { fingerprint: ['flow', 'runEvents.notify_unknown_outcome'] },
    );
  }
}
