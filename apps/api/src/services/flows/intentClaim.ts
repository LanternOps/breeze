/**
 * Tool catalog W04 (#5219), plan Task A5 / Decision 5 — the flow-aware
 * dispatch claim for an approved flow-origin action intent.
 *
 * `intentReleaseWorker.releaseApprovedIntent` takes THIS claim instead of the
 * plain `approved → executing` CAS for every `source = 'flow'` intent
 * (modelled on aiOperator/dispatchClaim.ts). A parked step can wait up to
 * FLOW_APPROVAL_TTL_HOURS for a human; by the time it is approved the flow may
 * have been disabled, edited and re-enabled, its tool re-discovered, its
 * approval scope reclassified or its delegator offboarded. Approving stale
 * work must never execute it (plan Review Focus "Approving stale work"): the
 * claim re-proves, under lock, that the run is still parked on exactly this
 * intent and that everything the approval covered still holds.
 *
 * ONE system transaction. LOCK ORDER run → intent, matching `disableFlow`
 * (versions.ts: flows → runs → intents). The intent is first read WITHOUT a
 * lock so a duplicate delivery (`lost_race`) returns before touching anything
 * else; then the run is locked FOR UPDATE, then the intent re-read FOR UPDATE
 * and re-checked. The flows row is read but never locked here, and a pause
 * (`pauseFlow`, which UPDATEs flows) runs only AFTER this transaction commits
 * — taking the flows lock while holding the run lock would AB-BA with
 * disableFlow.
 *
 * Outcomes (FlowClaimResult):
 *  - `claimed` — the intent is `executing`; nothing else was written.
 *  - `lost_race` — the intent is no longer `approved` (another dispatcher won,
 *    a duplicate delivery, a decision/cancel raced us) or its release lease
 *    passed (the expiry reaper owns it). NO writes, never a drift cancel.
 *  - `run_leased` — a runner slice holds an unexpired lease on the run right
 *    now (a spurious-wake slice, or the slice that minted this intent has not
 *    committed its park yet). NO writes: the claim never decides against run
 *    state another actor owns. The worker throws so BullMQ redelivers the
 *    release with backoff; if every attempt finds it leased the intent ages
 *    out at release_by and the reaper expires it (fail closed).
 *  - `run_terminal` — checked FIRST after locking: the run already finished
 *    (org merge, disable, cancel). The intent is cancelled; the run is NOT
 *    written (a terminal status is final).
 *  - `run_not_waiting` — the run is not parked on THIS intent (no matching
 *    `awaiting_approval` step). The intent is cancelled; the run is not
 *    written — whoever owns its current state (runner / reconciler) decides
 *    it, and the wake makes it look.
 *  - every other refusal cancels the intent (error_code `flow_drift`), closes
 *    the step and terminalizes the run:
 *      run_cancel_requested ⇒ step + run `cancelled` (`cancelled`);
 *      flow_not_enabled     ⇒ disabled flow: `cancelled` (`flow_disabled`),
 *                             otherwise `failed` (`drift`);
 *      publication_moved    ⇒ `failed` (`drift`);
 *      delegator_inactive   ⇒ `failed` (`delegator_inactive`) + pause the flow;
 *      tool_revision_changed | approval_scope_changed | pin_invalid
 *                           ⇒ `failed` (`drift`) + pause the flow `drift`
 *                             (spec §6.4: a drifted tool pauses the flow
 *                             instead of failing every later run).
 *  Every intent cancel publishes the terminal outbox, which wakes the run.
 */
import type { FlowPausedReason, FlowRunErrorCode, FlowStepErrorCode } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { checkGuardrails } from '../aiGuardrails';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';
import { captureException } from '../sentry';
import { flowStepPinSchema, type FlowStepPin } from '../flowValidator';
import type { ToolOwnerRef } from '../toolSources/resolver';
import * as store from './intentClaimStore';
import { publishFlowRunTerminalEvent, type FlowRunEventRef } from './runEvents';
import { assertDelegatorAuthority, pauseFlow } from './versions';

export type FlowClaimRefusalReason =
  | 'run_not_waiting'
  | 'flow_not_enabled'
  | 'publication_moved'
  | 'tool_revision_changed'
  | 'approval_scope_changed'
  | 'delegator_inactive'
  | 'run_cancel_requested'
  | 'pin_invalid';

export type FlowClaimResult =
  | { claimed: true; runId: string; chainDepth: number }
  | { claimed: false; reason: 'lost_race' }
  | { claimed: false; reason: 'run_leased' }
  | { claimed: false; reason: 'run_terminal' }
  | { claimed: false; reason: FlowClaimRefusalReason };

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'expired']);

/** Intent error_code for every refused flow claim (the reason rides on `result`). */
export const FLOW_CLAIM_INTENT_ERROR_CODE = 'flow_drift';

interface RunOutcome {
  status: 'failed' | 'cancelled';
  runErrorCode: FlowRunErrorCode;
  stepErrorCode: FlowStepErrorCode;
  error: string;
  pause: FlowPausedReason | null;
}

const REFUSAL_TEXT: Record<FlowClaimRefusalReason | 'run_terminal', string> = {
  run_terminal: 'The run had already finished when the step was approved.',
  run_not_waiting: 'The run was no longer waiting on this approval.',
  run_cancel_requested: 'The run was cancelled while the step waited for approval.',
  flow_not_enabled: 'The flow is no longer enabled.',
  publication_moved: 'The flow was re-published while the step waited for approval; the approved step no longer matches.',
  delegator_inactive: 'The person who enabled the flow no longer has the access it delegates.',
  tool_revision_changed: "The step's external tool changed since the flow was enabled.",
  approval_scope_changed: "The step's approval requirement changed since the flow was enabled.",
  pin_invalid: "The flow's enable-time step record could not be read.",
};

function runOutcomeFor(reason: FlowClaimRefusalReason, flowStatus: string | null): RunOutcome | null {
  const error = REFUSAL_TEXT[reason];
  switch (reason) {
    case 'run_not_waiting':
      return null;
    case 'run_cancel_requested':
      return { status: 'cancelled', runErrorCode: 'cancelled', stepErrorCode: 'cancelled', error, pause: null };
    case 'flow_not_enabled':
      return flowStatus === 'disabled'
        ? { status: 'cancelled', runErrorCode: 'flow_disabled', stepErrorCode: 'cancelled', error, pause: null }
        : { status: 'failed', runErrorCode: 'drift', stepErrorCode: 'drift', error, pause: null };
    case 'publication_moved':
      return { status: 'failed', runErrorCode: 'drift', stepErrorCode: 'drift', error, pause: null };
    case 'delegator_inactive':
      return { status: 'failed', runErrorCode: 'delegator_inactive', stepErrorCode: 'drift', error, pause: 'delegator_inactive' };
    case 'tool_revision_changed':
    case 'approval_scope_changed':
    case 'pin_invalid':
      return { status: 'failed', runErrorCode: 'drift', stepErrorCode: 'drift', error, pause: 'drift' };
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled flow claim refusal ${String(exhaustive)}`);
    }
  }
}

/** Pins come back from jsonb and decide unattended Tier-3 execution: parse, never trust. */
function pinForStep(stepPins: unknown, stepId: string): FlowStepPin | null {
  if (!Array.isArray(stepPins)) return null;
  for (const raw of stepPins) {
    const parsed = flowStepPinSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (parsed.data.stepId === stepId) return parsed.data;
  }
  return null;
}

/** The tenant-tool half of drift: same tool row, same revision, still usable. */
async function tenantStepStillPinned(intent: store.ClaimIntentRow, pin: FlowStepPin): Promise<boolean> {
  if (pin.source !== 'tenant') return false;
  if (pin.tenantToolId !== intent.toolSourceToolId || pin.tenantRevision !== intent.toolRevision) return false;
  const live = await store.loadTenantToolLive(pin.tenantToolId);
  return !!live && live.enabled && !live.removedAt && live.sourceStatus === 'active' && live.revision === pin.tenantRevision;
}

/** The core-tool half: the live classification of the STORED arguments still equals the pin and the intent. */
function coreStepStillPinned(intent: store.ClaimIntentRow, pin: FlowStepPin): boolean {
  if (pin.source !== 'core' || pin.tool !== intent.actionName) return false;
  const check = checkGuardrails(intent.actionName, intent.arguments);
  if (!check.allowed || check.tier >= 4 || check.tier > pin.tier) return false;
  const liveScope = check.tier === 3 ? (check.approvalScope ?? 'four_eyes') : null;
  return liveScope === pin.approvalScope && intent.approvalScope === pin.approvalScope;
}

type Decision =
  | { kind: 'result'; result: FlowClaimResult }
  | {
      kind: 'refused';
      result: FlowClaimResult;
      pause: { flowId: string; reason: FlowPausedReason } | null;
      /** The run this refusal FAILED (not cancelled), when the terminal write actually landed. */
      failedRun: FlowRunEventRef | null;
    };

export async function claimFlowLinkedIntentForDispatch(intentId: string): Promise<FlowClaimResult> {
  const decision = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<Decision> => {
    const lostRace: Decision = { kind: 'result', result: { claimed: false, reason: 'lost_race' } };

    // 1. Unlocked pre-read: a duplicate delivery returns before ANY lock or write.
    const pre = await store.loadIntentForClaim(intentId, { lock: false });
    if (!pre || pre.status !== 'approved') return lostRace;
    if (!pre.requestingFlowRunId) {
      throw new Error(`claimFlowLinkedIntentForDispatch: intent ${intentId} is not flow-originated`);
    }

    // 2. Lock order run → intent (disableFlow's order).
    const run = await store.lockRunForClaim(pre.requestingFlowRunId, pre.orgId);
    const intent = await store.loadIntentForClaim(intentId, { lock: true });
    if (!intent || intent.status !== 'approved' || !intent.releaseLive) return lostRace;
    const runId = pre.requestingFlowRunId;

    const refuse = async (
      reason: FlowClaimRefusalReason | 'run_terminal',
      ctx: { stepRowId: string | null; flowId: string | null; flowStatus: string | null },
    ): Promise<Decision> => {
      const cancelled = await store.casIntentApprovedToCancelled(intent.id, FLOW_CLAIM_INTENT_ERROR_CODE, {
        flowClaimRefusal: reason,
        error: REFUSAL_TEXT[reason],
      });
      // Unreachable under the intent lock, but never write run state for an
      // intent this transaction did not actually end.
      if (!cancelled) return lostRace;
      const outcome = reason === 'run_terminal' ? null : runOutcomeFor(reason, ctx.flowStatus);
      let failedRun: FlowRunEventRef | null = null;
      if (outcome) {
        if (ctx.stepRowId) {
          await store.closeStepForRefusal(ctx.stepRowId, { status: outcome.status, errorCode: outcome.stepErrorCode, error: outcome.error });
        }
        const ended = await store.terminalizeRunForRefusal(runId, { status: outcome.status, errorCode: outcome.runErrorCode, error: outcome.error });
        if (ended && outcome.status === 'failed' && run) {
          failedRun = { id: run.id, orgId: run.orgId, flowId: run.flowId, chainDepth: run.chainDepth };
        }
      }
      await publishIntentTerminalOutbox(
        db,
        { id: intent.id, orgId: intent.orgId, taskId: intent.taskId, requestingFlowRunId: runId },
        'intent_cancelled',
      );
      return {
        kind: 'refused',
        result: { claimed: false, reason },
        pause: outcome?.pause && ctx.flowId ? { flowId: ctx.flowId, reason: outcome.pause } : null,
        failedRun,
      };
    };

    // 3. Run state, run_terminal FIRST (the composite FK makes a missing run
    //    unreachable; treat it as finished).
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
      return refuse('run_terminal', { stepRowId: null, flowId: null, flowStatus: null });
    }
    if (run.leaseLive) return { kind: 'result', result: { claimed: false, reason: 'run_leased' } };

    const step = await store.lockStepForIntent(run.id, intent.id);
    const stepCtx = { stepRowId: step && (step.status === 'awaiting_approval' || step.status === 'running') ? step.id : null, flowId: run.flowId, flowStatus: null as string | null };
    if (run.cancelRequestedAt) return refuse('run_cancel_requested', stepCtx);
    if (run.status !== 'awaiting_approval' || !step || step.status !== 'awaiting_approval') {
      return refuse('run_not_waiting', stepCtx);
    }

    // 4. The flow is still enabled and its LIVE publication is the run's.
    const flow = await store.loadFlowForClaim(run.flowId);
    stepCtx.flowStatus = flow?.status ?? null;
    if (!flow || flow.status !== 'enabled' || flow.enabledPublicationSeq === null) {
      return refuse('flow_not_enabled', stepCtx);
    }
    const publication = await store.loadPublicationBySeq(flow.id, flow.enabledPublicationSeq);
    if (!publication || publication.id !== run.flowVersionId) return refuse('publication_moved', stepCtx);

    // 5. The delegator still holds what they delegated (Decision 7), resolved
    //    in the flow OWNER's scope.
    const ownerPartnerId = flow.orgId ? await store.loadOrgPartnerId(flow.orgId) : flow.partnerId;
    const owner: ToolOwnerRef | null = ownerPartnerId ? { orgId: flow.orgId, partnerId: ownerPartnerId } : null;
    if (!owner || !(await assertDelegatorAuthority(publication, owner))) return refuse('delegator_inactive', stepCtx);

    // 6. The approved step still matches its enable-time pin.
    const pin = pinForStep(publication.stepPins, step.stepId);
    if (!pin) return refuse('pin_invalid', stepCtx);
    if (intent.toolSourceToolId) {
      if (!(await tenantStepStillPinned(intent, pin))) return refuse('tool_revision_changed', stepCtx);
    } else if (!coreStepStillPinned(intent, pin)) {
      return refuse('approval_scope_changed', stepCtx);
    }

    // 7. The claim.
    if (!(await store.casIntentApprovedToExecuting(intent.id))) return lostRace;
    return { kind: 'result', result: { claimed: true, runId: run.id, chainDepth: run.chainDepth } };
  }, 'flows.claimFlowLinkedIntentForDispatch'));

  // After commit, outside the run/intent locks (see header). Idempotent. A
  // failure is reported, not thrown: the refusal already committed, a retried
  // release would only find `lost_race`, and the next slice of any run of
  // this flow re-checks the delegator and pauses it (Task A8 step 2).
  // The run this claim failed is terminal before the wake reaches the runner,
  // which then returns at its terminal check — so the claim, not the runner,
  // publishes flow.run.failed (after commit; best effort, runEvents.ts).
  if (decision.kind === 'refused' && decision.failedRun) {
    await publishFlowRunTerminalEvent(decision.failedRun, 'failed');
  }
  if (decision.kind === 'refused' && decision.pause) {
    try {
      await pauseFlow(decision.pause.flowId, decision.pause.reason);
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error(`[flows] pause after refused dispatch claim failed (flow=${decision.pause.flowId})`, err);
    }
  }
  return decision.result;
}
