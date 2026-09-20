import { eq, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { alerts, userNotifications } from '../../db/schema';
import type { EscalationStep } from '../../routes/alerts/schemas';
import { partnerIdForOrg, type DbExecutor } from './railOwnership';
import { DeliveryWriteError, type RoutingOwner } from './routingRuleWrites';

export interface UserEscalationJob { type: 'escalation-user'; alertId: string; userId: string; escalationStep: number }
export function escalationOccurrences(steps: EscalationStep[], originalIndexes?: number[], alertId?: string) {
  const occurrences: Array<EscalationStep & { escalationStep: number; delayMs: number }> = [];
  for (const [index, step] of steps.entries()) {
    for (let repeat = 0; repeat <= (step.repeat?.maxTimes ?? 0); repeat++) {
      if (occurrences.length === 50) {
        console.warn(`[NotificationDispatcher] Clamping escalation for alert ${alertId ?? 'unknown'} to 50 occurrences`);
        return occurrences;
      }
      occurrences.push({
        ...step, escalationStep: repeat * 10 + (originalIndexes?.[index] ?? index) + 1,
        delayMs: (step.delayMinutes + repeat * (step.repeat?.everyMinutes ?? 0)) * 60000,
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
