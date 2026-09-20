import { eq, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { alerts, userNotifications } from '../../db/schema';
import type { EscalationStep } from '../../routes/alerts/schemas';
import { partnerIdForOrg, type DbExecutor } from './railOwnership';
import { DeliveryWriteError, type RoutingOwner } from './routingRuleWrites';

export interface UserEscalationJob { type: 'escalation-user'; alertId: string; userId: string; escalationStep: number }
export function escalationOccurrences(steps: EscalationStep[]) {
  return steps.flatMap((step, index) => Array.from({ length: 1 + (step.repeat?.maxTimes ?? 0) }, (_, repeat) => ({
    ...step, escalationStep: repeat * 10 + index + 1,
    delayMs: (step.delayMinutes + repeat * (step.repeat?.everyMinutes ?? 0)) * 60000,
  })));
}
export async function listEscalationUsers(owner: RoutingOwner, executor: DbExecutor = db): Promise<Array<{ id: string; name: string }>> {
  const partner = owner.orgId ? await partnerIdForOrg(owner.orgId, executor) : owner.partnerId;
  const rows = await executor.execute<{ id: string; name: string }>(sql`
    SELECT DISTINCT u.id, u.name FROM users u WHERE u.status = 'active' AND (
      (${owner.orgId}::uuid IS NOT NULL AND EXISTS (
        SELECT 1 FROM organization_users ou WHERE ou.user_id = u.id AND ou.org_id = ${owner.orgId}::uuid
          AND ou.site_ids IS NULL AND ou.device_group_ids IS NULL
      )) OR EXISTS (
        SELECT 1 FROM partner_users pu WHERE pu.user_id = u.id AND pu.partner_id = ${partner}::uuid
          AND (pu.org_access = 'all' OR (${owner.orgId}::uuid IS NOT NULL
            AND pu.org_access = 'selected' AND ${owner.orgId}::uuid = ANY(pu.org_ids)))
      )) ORDER BY u.name, u.id
  `);
  return Array.from(rows);
}
export async function validateEscalationUsers(steps: EscalationStep[], owner: RoutingOwner, executor: DbExecutor = db) {
  const requested = [...new Set(steps.flatMap(step => step.userIds))];
  if (!requested.length) return;
  const available = new Set((await listEscalationUsers(owner, executor)).map(user => user.id));
  if (requested.some(id => !available.has(id))) throw new DeliveryWriteError(400, 'Escalation users are not available to this owner');
}
export async function processUserEscalation(data: UserEscalationJob, executor: DbExecutor = db): Promise<void> {
  assertInTransaction('processUserEscalation');
  const [alert] = await executor.select().from(alerts).where(eq(alerts.id, data.alertId)).limit(1).for('update');
  if (!alert || alert.status !== 'active') return;
  const eligible = await listEscalationUsers({ orgId: alert.orgId, partnerId: null }, executor);
  if (!eligible.some(user => user.id === data.userId)) return;
  await executor.insert(userNotifications).values({
    userId: data.userId, orgId: alert.orgId, type: 'alert', priority: 'urgent',
    title: alert.title, message: alert.message, link: `/alerts/${alert.id}`,
    metadata: { alertId: alert.id, escalationStep: data.escalationStep }, read: false,
    dedupeKey: `escalation:${alert.id}:${data.escalationStep}:${data.userId}`,
  }).onConflictDoNothing();
}
