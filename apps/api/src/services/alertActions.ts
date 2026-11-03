import { db } from '../db';
import { alerts } from '../db/schema';
import { buildAcknowledgeAlertCas } from './alertService';
import { publishEvent } from './eventBus';
import { emitAlertStateFeedback } from './mlFeedbackEmitters';

export type AlertActor =
  | { kind: 'user'; userId: string }
  | { kind: 'partner_service_principal'; principalId: string };

/**
 * Acknowledge ONE alert under the caller's ambient database access context.
 *
 * The UPDATE is the compare-and-swap (#4101, `buildAcknowledgeAlertCas`): a
 * caller that read the alert as active and then lost a race to a resolve must
 * not stamp `acknowledged` over the resolution. Only the winner publishes the
 * event and (for a person) the ML feedback; a loser gets `changed: false` and
 * owns nothing. A user acknowledge publishes exactly the payload the staff
 * route always has (v1 webhook bodies are that payload byte for byte); a
 * service principal's adds `acknowledgedByPrincipalId` with `acknowledgedBy`
 * null.
 */
export async function acknowledgeAlert(
  alertId: string,
  actor: AlertActor,
): Promise<{ changed: true; alert: typeof alerts.$inferSelect } | { changed: false; alert: null }> {
  const acknowledgedAt = new Date();
  const [alert] = await db.update(alerts).set({
    status: 'acknowledged',
    acknowledgedAt,
    acknowledgedBy: actor.kind === 'user' ? actor.userId : null,
    acknowledgedByPrincipalId: actor.kind === 'partner_service_principal' ? actor.principalId : null,
  }).where(buildAcknowledgeAlertCas(alertId)).returning();
  if (!alert) return { changed: false, alert: null };

  try {
    const payload = { alertId: alert.id, ruleId: alert.ruleId, deviceId: alert.deviceId };
    if (actor.kind === 'user') {
      await publishEvent('alert.acknowledged', alert.orgId,
        { ...payload, acknowledgedBy: actor.userId }, 'alerts-route', { userId: actor.userId });
    } else {
      await publishEvent('alert.acknowledged', alert.orgId,
        { ...payload, acknowledgedBy: null, acknowledgedByPrincipalId: actor.principalId }, 'partner-api');
    }
  } catch (error) {
    console.error('[AlertActions] Failed to publish alert.acknowledged event:', error);
  }

  // A machine mirroring a PSA is not human feedback on alert quality.
  if (actor.kind === 'user') {
    await emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: alert.id,
      eventType: 'alert.acknowledged',
      outcome: 'acknowledged',
      actorUserId: actor.userId,
      occurredAt: acknowledgedAt,
      metadata: { source: 'alerts.route', previousStatus: 'active' },
    });
  }
  return { changed: true, alert };
}
