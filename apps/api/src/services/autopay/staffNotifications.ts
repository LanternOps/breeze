import { and, eq, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizationUsers, partnerUsers, users, partners, userNotifications } from '../../db/schema';
import { getEmailService } from '../email';
import { escapeHtml } from '../emailLayout';
import type { Tx } from './types';
export interface AutopayStaffNotice {
  orgId: string; partnerId: string;
  event: 'autopay.enrolled' | 'autopay.stopped' | 'autopay.needs_attention';
  dedupeKey: string; message: string;
}
/** Insert in the lifecycle caller's transaction so rollback/commit includes staff visibility. */
export async function enqueueAutopayStaffNotifications(db: Tx, input: AutopayStaffNotice): Promise<void> {
  const local = await db.select({ userId: organizationUsers.userId }).from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId,input.orgId),eq(users.status,'active')));
  const partnerStaff = await db.select({ userId: partnerUsers.userId }).from(partnerUsers)
    .innerJoin(users,eq(users.id,partnerUsers.userId))
    .where(and(eq(partnerUsers.partnerId,input.partnerId),eq(users.status,'active'),or(
      eq(partnerUsers.orgAccess,'all'),
      and(eq(partnerUsers.orgAccess,'selected'),sql`${input.orgId} = ANY(${partnerUsers.orgIds})`))));
  const ids = [...new Set([...local,...partnerStaff].map((row) => row.userId))];
  if (ids.length) await db.insert(userNotifications).values(ids.map((userId) => ({
    userId, orgId: input.orgId, type: 'billing' as const,
    priority: input.event === 'autopay.needs_attention' ? 'high' as const : 'normal' as const,
    title: input.event === 'autopay.enrolled' ? 'Automatic payments enabled'
      : input.event === 'autopay.stopped' ? 'Automatic payments stopped' : 'Automatic payments need attention',
    message: input.message, link: '/billing/autopay', metadata: { event: input.event },
    dedupeKey: `${input.dedupeKey}:${userId}`, read: false,
  }))).onConflictDoNothing();
}

/** Call only after checking the committed lifecycle state, outside its held context. */
export async function sendAutopayStaffEmail(input: AutopayStaffNotice): Promise<void> {
  const email = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [partner] = await db.select({ billingEmail: partners.billingEmail }).from(partners)
      .where(eq(partners.id,input.partnerId)).limit(1);
    return partner?.billingEmail;
  }));
  if (!email) return;
  const service = getEmailService();
  if (!service) throw new Error('Staff email transport is unavailable');
  await runOutsideDbContext(() => service.sendEmail({ to: email, purpose: 'staff.autopay',
    subject: 'Automatic payments update', html: `<p>${escapeHtml(input.message)}</p>`, text: input.message }));
}

/** Compatibility adapter for callers that already run after commit. */
export async function notifyAutopayStaff(input: AutopayStaffNotice): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(() => enqueueAutopayStaffNotifications(db, input)));
  await sendAutopayStaffEmail(input);
}
