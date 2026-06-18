import type { MlFeedbackEventInput } from '@breeze/shared';
import { emitMlFeedbackEvent } from './mlFeedback';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function actorUserIdOrNull(actorUserId: string | null | undefined): string | null {
  return actorUserId && UUID_RE.test(actorUserId) ? actorUserId : null;
}

async function emitFeedbackBestEffort(input: MlFeedbackEventInput, logContext: string): Promise<void> {
  try {
    await emitMlFeedbackEvent(input);
  } catch (error) {
    console.error(`[MlFeedback] Failed to emit ${logContext}:`, error);
  }
}

export async function emitAlertStateFeedback(options: {
  orgId: string;
  alertId: string;
  eventType: 'alert.acknowledged' | 'alert.resolved' | 'alert.suppressed' | 'alert.dismissed' | 'alert.reopened';
  outcome: 'acknowledged' | 'resolved' | 'suppressed' | 'dismissed' | 'reopened';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitFeedbackBestEffort({
    orgId: options.orgId,
    sourceType: 'alert',
    sourceId: options.alertId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  }, options.eventType);
}

export async function emitCorrelationFeedback(options: {
  orgId: string;
  correlationId: string;
  eventType: 'correlation.accepted' | 'correlation.split' | 'correlation.merged' | 'correlation.dismissed';
  outcome: 'accepted' | 'split' | 'merged' | 'dismissed';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitFeedbackBestEffort({
    orgId: options.orgId,
    sourceType: 'correlation',
    sourceId: options.correlationId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  }, options.eventType);
}
