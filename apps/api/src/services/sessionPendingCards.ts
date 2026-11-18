import type { AiApprovalOutcome, AiPendingCardEvent } from '@breeze/shared/types/ai';
// Type-only: this leaf module is imported by both aiAgentSdk.ts and
// aiAgentSdkTools.ts, and aiAgentSdk.ts already imports aiAgentSdkTools.ts —
// a value import of either (or of the manager) from here would be a cycle.
import type { ActiveSession } from './streamingSessionManager';

/**
 * #9427: the authoritative set of cards a turn is blocked on, kept where each
 * wait lives. The event stream cannot say when a card is decided (a plan
 * rejection or timeout publishes nothing, and tool results carry no
 * executionId), so an attaching client reads this map instead of inferring
 * from replayed events.
 *
 * Keys: `approval:<executionId>` and `plan:<planId>`. Every publisher pairs
 * `publishPendingCard` with `resolvePendingCard` in a `finally` around the
 * wait, so approve, reject, timeout, settle and a thrown wait all remove it.
 */

/** Record the card, then publish it on the session's bus — in the same tick. */
export function publishPendingCard(session: ActiveSession, key: string, event: AiPendingCardEvent): void {
  // Hand-built sessions in older tests may lack the map.
  (session.pendingCards ??= new Map()).set(key, event);
  session.eventBus.publish(event);
}

/** The card's wait has ended, however it ended. Idempotent. */
export function resolvePendingCard(session: ActiveSession, key: string): void {
  session.pendingCards?.delete(key);
}

/**
 * #9431: resolve an approval card AND tell every listener on the session how
 * its wait ended. Without this a surface that did not make the decision (a
 * second window, a chat open while the user decides in Approvals or on
 * mobile) kept showing Approve / Deny until something else happened to clear
 * it. Publishes only when the card was still tracked, so a second resolve of
 * the same card is silent.
 */
export function resolveApprovalCard(session: ActiveSession, executionId: string, outcome: AiApprovalOutcome): void {
  const key = approvalCardKey(executionId);
  if (!session.pendingCards?.has(key)) return;
  session.pendingCards.delete(key);
  session.eventBus.publish({ type: 'approval_resolved', executionId, outcome });
}

export function approvalCardKey(executionId: string): string {
  return `approval:${executionId}`;
}

export function planCardKey(planId: string): string {
  return `plan:${planId}`;
}
