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

export async function emitAnomalyFeedback(options: {
  orgId: string;
  anomalyId: string;
  eventType: 'anomaly.dismissed' | 'anomaly.promoted' | 'anomaly.resolved';
  outcome: 'dismissed' | 'promoted' | 'resolved';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitFeedbackBestEffort({
    orgId: options.orgId,
    sourceType: 'anomaly',
    sourceId: options.anomalyId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  }, options.eventType);
}

export async function emitRcaFeedback(options: {
  orgId: string;
  rcaId: string;
  eventType: 'rca.helpful' | 'rca.not_helpful' | 'rca.edited' | 'rca.used_in_ticket';
  outcome: 'helpful' | 'not_helpful' | 'edited' | 'used_in_ticket';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitFeedbackBestEffort({
    orgId: options.orgId,
    sourceType: 'rca',
    sourceId: options.rcaId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  }, options.eventType);
}

export async function emitRemediationSuggestionFeedback(options: {
  orgId: string;
  suggestionId: string;
  eventType: 'suggestion.accepted' | 'suggestion.edited' | 'suggestion.rejected' | 'suggestion.executed' | 'suggestion.failed';
  outcome: 'accepted' | 'edited' | 'rejected' | 'executed' | 'failed';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitFeedbackBestEffort({
    orgId: options.orgId,
    sourceType: 'remediation',
    sourceId: options.suggestionId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  }, options.eventType);
}

export async function emitDeviceReliabilityFeedback(options: {
  orgId: string;
  deviceId: string;
  eventType: 'device.failure_confirmed' | 'device.replaced' | 'device.false_alarm';
  outcome: 'failure_confirmed' | 'replaced' | 'false_alarm';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitMlFeedbackEvent({
    orgId: options.orgId,
    sourceType: 'device',
    sourceId: options.deviceId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  });
}

export async function emitTicketTriageFeedback(options: {
  orgId: string;
  ticketId: string;
  eventType: 'ticket.category_changed' | 'ticket.priority_changed' | 'ticket.assignee_changed' | 'ticket.resolved' | 'ticket.reopened';
  outcome: 'category_changed' | 'priority_changed' | 'assignee_changed' | 'resolved' | 'reopened';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitFeedbackBestEffort({
    orgId: options.orgId,
    sourceType: 'ticket',
    sourceId: options.ticketId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  }, options.eventType);
}

export async function emitUserRiskFeedback(options: {
  orgId: string;
  userId: string;
  eventType: 'user_risk.true_positive' | 'user_risk.false_positive' | 'training.assigned' | 'training.completed';
  outcome: 'true_positive' | 'false_positive' | 'assigned' | 'completed';
  actorUserId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitMlFeedbackEvent({
    orgId: options.orgId,
    sourceType: 'user_risk',
    sourceId: options.userId,
    eventType: options.eventType,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: options.metadata ?? {},
    occurredAt: options.occurredAt ?? new Date(),
  });
}
