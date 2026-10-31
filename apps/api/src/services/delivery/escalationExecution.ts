import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { publishEvent } from '../eventBus';
import { alerts, userNotifications } from '../../db/schema';
import type { EscalationStep } from './escalationSteps';
import { partnerIdForOrg, type DbExecutor } from './railOwnership';
import { DeliveryWriteError, type RoutingOwner } from './routingRuleWrites';

export interface UserEscalationJob { type: 'escalation-user'; alertId: string; userId: string; escalationStep: number }
/**
 * One job per escalation OCCURRENCE (#10565), enqueued beside that occurrence's
 * channel `send` and `escalation-user` jobs with the same delay. It is the only
 * producer of `alert.escalated`, so a step that pages several channels and
 * users still publishes one event.
 */
export interface EscalationEventJob { type: 'escalation-event'; alertId: string; escalationStep: number; escalationPolicyId: string }
export function escalationOccurrences(steps: EscalationStep[], originalIndexes?: number[], alertId?: string) {
  const occurrences: Array<Pick<EscalationStep, 'channelIds' | 'userIds'> & { escalationStep: number; delayMs: number }> = [];
  for (const [index, step] of steps.entries()) {
    for (let repeat = 0; repeat <= (step.renotify?.maxTimes ?? 0); repeat++) {
      if (occurrences.length === 50) {
        console.warn(`[NotificationDispatcher] Clamping escalation for alert ${alertId ?? 'unknown'} to 50 occurrences`);
        return occurrences;
      }
      occurrences.push({
        channelIds: step.channelIds, userIds: step.userIds,
        escalationStep: repeat * 10 + (originalIndexes?.[index] ?? index) + 1,
        delayMs: (step.delayMinutes + repeat * (step.renotify?.everyMinutes ?? 0)) * 60000,
      });
    }
  }
  return occurrences;
}
export interface EscalationUserOptions { includePartnerUsers?: boolean }

export async function listEscalationUsers(
  owner: RoutingOwner, executor: DbExecutor = db, { includePartnerUsers = true }: EscalationUserOptions = {},
): Promise<Array<{ id: string; name: string }>> {
  const partner = owner.orgId ? await partnerIdForOrg(owner.orgId, executor) : owner.partnerId;
  const rows = await executor.execute<{ id: string; name: string }>(sql`
    SELECT DISTINCT u.id, u.name FROM users u WHERE u.status = 'active' AND (
      (${owner.orgId}::uuid IS NOT NULL AND EXISTS (
        SELECT 1 FROM organization_users ou WHERE ou.user_id = u.id AND ou.org_id = ${owner.orgId}::uuid
          AND ou.site_ids IS NULL AND ou.device_group_ids IS NULL
      )) ${includePartnerUsers ? sql`OR EXISTS (
        SELECT 1 FROM partner_users pu WHERE pu.user_id = u.id AND pu.partner_id = ${partner}::uuid
          ${owner.orgId ? sql`AND (pu.org_access = 'all'
            OR (pu.org_access = 'selected' AND ${owner.orgId}::uuid = ANY(pu.org_ids)))` : sql``}
      )` : sql``}) ORDER BY u.name, u.id
  `);
  return Array.from(rows);
}
export async function validateEscalationUsers(
  steps: EscalationStep[], owner: RoutingOwner, executor: DbExecutor = db, options: EscalationUserOptions = {},
) {
  const requested = [...new Set(steps.flatMap(step => step.userIds))];
  if (!requested.length) return;
  const available = new Set((await listEscalationUsers(owner, executor, options)).map(user => user.id));
  if (requested.some(id => !available.has(id))) throw new DeliveryWriteError(400, 'Escalation users are not available to this owner');
}
export async function processUserEscalation(data: UserEscalationJob, executor: DbExecutor = db): Promise<void> {
  assertInTransaction('processUserEscalation');
  const [alert] = await executor.select().from(alerts).where(eq(alerts.id, data.alertId)).limit(1).for('update');
  if (!alert || alert.status !== 'active') {
    console.log(
      `[NotificationDispatcher] Skipping escalation step ${data.escalationStep} for alert ${data.alertId} `
      + `user ${data.userId} — ${alert ? `status is '${alert.status}', not 'active'` : 'alert not found'}`
    );
    return;
  }
  const eligible = await listEscalationUsers({ orgId: alert.orgId, partnerId: null }, executor);
  if (!eligible.some(user => user.id === data.userId)) {
    console.log(
      `[NotificationDispatcher] Skipping escalation step ${data.escalationStep} for alert ${data.alertId} `
      + `user ${data.userId} — user is not eligible`
    );
    return;
  }
  await executor.insert(userNotifications).values({
    userId: data.userId, orgId: alert.orgId, type: 'alert', priority: 'urgent',
    title: alert.title, message: alert.message, link: `/alerts/${alert.id}`,
    metadata: { alertId: alert.id, escalationStep: data.escalationStep }, read: false,
    dedupeKey: `escalation:${alert.id}:${data.escalationStep}:${data.userId}`,
  }).onConflictDoNothing();
}

/**
 * Stable event id for one (alert, escalation occurrence), shaped as a v5-style
 * UUID so the event bus accepts it. A BullMQ retry after a partial publish
 * reuses it, and webhook delivery dedupes on (webhook_id, event_id).
 */
export function escalationEventId(alertId: string, escalationStep: number): string {
  const h = createHash('sha1').update(`alert-escalated:${alertId}:${escalationStep}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Publish `alert.escalated` when an escalation occurrence fires. Same status
 * guard as the occurrence's sends (`processSendNotification`,
 * `processUserEscalation`): only an alert that is still `active` escalates.
 * Nothing is written, so there is no commit to wait for; a publish failure
 * throws so BullMQ retries the job under the same event id.
 *
 * `escalationStep` is the occurrence id: policy step position (1-10) plus 10
 * per renotify repeat. `policyStep` and `repeat` spell it out for consumers.
 */
export async function processEscalationEvent(data: EscalationEventJob, executor: DbExecutor = db): Promise<boolean> {
  const [alert] = await executor
    .select({ id: alerts.id, orgId: alerts.orgId, ruleId: alerts.ruleId, deviceId: alerts.deviceId, status: alerts.status })
    .from(alerts).where(eq(alerts.id, data.alertId)).limit(1);
  if (!alert || alert.status !== 'active') {
    console.log(
      `[NotificationDispatcher] Skipping alert.escalated for alert ${data.alertId} step ${data.escalationStep} — `
      + `${alert ? `status is '${alert.status}', not 'active'` : 'alert not found'}`
    );
    return false;
  }
  await publishEvent(
    'alert.escalated',
    alert.orgId,
    {
      alertId: alert.id,
      ruleId: alert.ruleId,
      deviceId: alert.deviceId,
      escalationPolicyId: data.escalationPolicyId,
      escalationStep: data.escalationStep,
      policyStep: ((data.escalationStep - 1) % 10) + 1,
      repeat: Math.floor((data.escalationStep - 1) / 10),
    },
    'notification-dispatcher',
    { eventId: escalationEventId(alert.id, data.escalationStep) }
  );
  return true;
}
