/**
 * The `alert.triggered` outbox envelope (#10926), shared by every alert
 * creator that stages one: `createAlert` / `createSourcedAlert` in
 * `alertService.ts`, and the automation / flow `create_alert` writer in
 * `alertCreation.ts` (#11348). `subjectAlertOutbox.ts` reads it back and
 * publishes it after the writing transaction commits.
 *
 * A LEAF module (the flow frame only), so a creator and its unit test can use
 * the real envelope without loading the alert engine.
 */
import { currentFlowExecutionFrame } from './flows/flowExecutionContext';

/**
 * The transactional outbox envelope staged on an alert's own row (W03 for
 * subject alerts; every `createAlert` / `createSourcedAlert` alert since
 * #10926). `alerts.context._subjectDispatch` (or `_subjectResolutionDispatch`
 * for a subject recovery) IS the outbox: no separate table, no in-memory
 * callback list. `subjectAlertOutbox.ts` reads it back only after the writing
 * transaction has committed.
 */
export interface SubjectAlertDispatch {
  eventId: string;
  eventType: 'alert.triggered' | 'alert.resolved';
  publisher?: string;
  siteId: string | null | undefined;
  cooldownMinutes: number;
  payload: Record<string, unknown>;
  /** Fixed at staging so a republished event keeps its original time. */
  occurredAt?: string;
  /**
   * #10926 — on a failed publish keep the row and retry later, instead of the
   * W03 subject compensation (delete the row and let the next sweep re-raise).
   */
  retryOnPublishFailure?: boolean;
  failedAttempts?: number;
  leaseToken?: string;
  leaseUntil?: string;
  /**
   * #11348 — the flow step that staged this alert (Decision 14): its run id
   * and chain depth, always together. An inline publish took them from the
   * step's flow execution frame; the outbox publishes after COMMIT, outside
   * that frame, so it sends them as the `flowRunId` / `flowChainDepth` publish
   * options instead. The flow event trigger reads them to stop loops. Absent
   * when no flow step raised the alert.
   */
  flow?: { runId: string; chainDepth: number };
  /**
   * #11348 — `false` when the creator applies no rule noise controls (cooldown,
   * flap state) to this alert, so the outbox records none after publishing.
   * The automation `create_alert` alert is one: its synthetic rule is shared
   * and every action is its own subject. Absent means the default effects.
   */
  noiseControls?: false;
}

/**
 * #10926 — the `alert.triggered` outbox envelope for a legacy, sourced or
 * automation-style alert. The creator writes it in the SAME insert as the row,
 * then calls `scheduleStagedAlertDispatch`; the event goes out only after the
 * outermost transaction commits (`subjectAlertOutbox.ts`).
 *
 * Publishing inline, as these paths used to, ran the `notification-dispatcher`
 * subscriber before COMMIT: `process-alert` read the row on another connection,
 * found nothing and returned without sending, so rule, monitor and sourced
 * alerts never notified anyone. The envelope is durable, so a crash after
 * COMMIT or a failed publish is retried by the next drain instead of leaving an
 * active alert that is never announced (the row every creator's dedupe would
 * skip forever, #5241 / #5325).
 *
 * The current flow execution frame, if any, is captured here: the creator is
 * still inside the flow step that caused the alert, the outbox will not be.
 */
export function stagedTriggerDispatch(opts: {
  alertId: string;
  payload: Record<string, unknown>;
  publisher: string;
  siteId: string | null | undefined;
  cooldownMinutes: number;
  noiseControls?: false;
}): SubjectAlertDispatch {
  const frame = currentFlowExecutionFrame();
  return {
    eventId: opts.alertId,
    eventType: 'alert.triggered',
    publisher: opts.publisher,
    siteId: opts.siteId,
    cooldownMinutes: opts.cooldownMinutes,
    payload: opts.payload,
    occurredAt: new Date().toISOString(),
    retryOnPublishFailure: true,
    ...(frame ? { flow: { runId: frame.runId, chainDepth: frame.chainDepth } } : {}),
    ...(opts.noiseControls === false ? { noiseControls: false as const } : {}),
  };
}
