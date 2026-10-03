import { and, eq, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizationUsers, partnerUsers, users, partners, userNotifications } from '../../db/schema';
import { getEmailService } from '../email';
import { escapeHtml } from '../emailLayout';
import type { Tx } from './types';
export interface AutopayStaffNotice {
  orgId: string; partnerId: string; invoiceId?: string;
  event: 'autopay.enrolled' | 'autopay.stopped' | 'autopay.needs_attention' | 'autopay.skipped'
    | 'payment.failed_final' | 'payment.ach_returned' | 'payment.unapplied';
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
  const urgent = input.event === 'autopay.needs_attention' || input.event.startsWith('payment.');
  const ids = [...new Set([...local,...partnerStaff].map((row) => row.userId))];
  if (ids.length) await db.insert(userNotifications).values(ids.map((userId) => ({
    userId, orgId: input.orgId, type: 'billing' as const,
    priority: urgent ? 'high' as const : 'normal' as const,
    title: input.event === 'autopay.enrolled' ? 'Automatic payments enabled'
      : input.event === 'autopay.skipped' ? 'Automatic payment skipped'
      : input.event === 'autopay.stopped' ? 'Automatic payments stopped' : 'Payment needs attention',
    message: input.message, link: input.invoiceId ? `/billing/invoices/${input.invoiceId}` : '/billing/autopay', metadata: { event: input.event },
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
  const claimed = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
    UPDATE org_autopay_enrollments SET staff_email_dedupe_keys=array_append(staff_email_dedupe_keys,${input.dedupeKey})
    WHERE org_id=${input.orgId}::uuid AND partner_id=${input.partnerId}::uuid
      AND NOT (${input.dedupeKey}=ANY(staff_email_dedupe_keys)) RETURNING id`)));
  if (!Array.from(claimed).length) return;
  await runOutsideDbContext(() => service.sendEmail({ to: email, purpose: 'staff.autopay',
    subject: 'Automatic payments update', html: `<p>${escapeHtml(input.message)}</p>`, text: input.message }));
}

/** Compatibility adapter for callers that already run after commit. */
export async function notifyAutopayStaff(input: AutopayStaffNotice): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(() => enqueueAutopayStaffNotifications(db, input)));
  await sendAutopayStaffEmail(input);
}
