import { createHash } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { db, runAfterDbContextExit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, organizations, organizationUsers, partnerUsers, users, partners, userNotifications } from '../../db/schema';
import { getEmailService } from '../email';
import { getRedis } from '../redis';
import { escapeHtml } from '../emailLayout';
import type { Tx } from './types';
export interface AutopayStaffNotice {
  orgId: string; partnerId: string; invoiceId?: string; partnerOnly?: boolean;
  event: 'autopay.enrolled' | 'autopay.method_updated' | 'autopay.stopped' | 'autopay.needs_attention' | 'autopay.skipped'
    | 'payment.failed_final' | 'payment.ach_returned' | 'payment.unapplied' | 'payment.disputed';
  dedupeKey: string; message: string;
}
const TITLE_MAX = 255;
function eventTitle(event: AutopayStaffNotice['event']): string {
  return event === 'autopay.enrolled' ? 'Automatic payments enabled'
    : event === 'autopay.method_updated' ? 'Payment method updated'
    : event === 'autopay.skipped' ? 'Automatic payment skipped'
    : event === 'autopay.stopped' ? 'Automatic payments stopped'
    : event === 'payment.disputed' ? 'Payment disputed' : 'Payment needs attention';
}
/** Staff must see which client a notice is about (D-13). Bounded to the title column. */
function namedTitle(event: AutopayStaffNotice['event'], orgName: string | null): string {
  // A title doubles as an email subject: keep it on one line.
  const title = orgName ? `${eventTitle(event)}: ${orgName.replace(/[\r\n]+/g, ' ')}` : eventTitle(event);
  const chars = Array.from(title);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : title;
}
async function orgName(db: Tx, orgId: string): Promise<string | null> {
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org?.name ?? null;
}
/** Staff read invoices by number; callers pass the id and never put it in the message (P-17). */
async function invoiceNumber(db: Tx, input: AutopayStaffNotice): Promise<string | null> {
  if (!input.invoiceId) return null;
  const [invoice] = await db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, input.orgId))).limit(1);
  return invoice?.invoiceNumber ?? null;
}
/** Insert in the lifecycle caller's transaction so rollback/commit includes staff visibility. */
export async function enqueueAutopayStaffNotifications(db: Tx, input: AutopayStaffNotice): Promise<void> {
  const local = input.partnerOnly ? [] : await db.select({ userId: organizationUsers.userId }).from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId,input.orgId),eq(users.status,'active')));
  const partnerStaff = await db.select({ userId: partnerUsers.userId }).from(partnerUsers)
    .innerJoin(users,eq(users.id,partnerUsers.userId))
    .where(and(eq(partnerUsers.partnerId,input.partnerId),eq(users.status,'active'),or(
      eq(partnerUsers.orgAccess,'all'),
      and(eq(partnerUsers.orgAccess,'selected'),sql`${input.orgId} = ANY(${partnerUsers.orgIds})`))));
  const urgent = input.event === 'autopay.needs_attention' || input.event.startsWith('payment.');
  const ids = [...new Set([...local,...partnerStaff].map((row) => row.userId))];
  if (!ids.length) return;
  const name = await orgName(db, input.orgId);
  const number = await invoiceNumber(db, input);
  const named = name && !input.message.includes(name) ? `${name}: ${input.message}` : input.message;
  const message = number ? `${named} Invoice ${number}.` : named;
  await db.insert(userNotifications).values(ids.map((userId) => ({
    userId, orgId: input.orgId, type: 'billing' as const,
    priority: urgent ? 'high' as const : 'normal' as const,
    title: namedTitle(input.event, name),
    message, link: input.invoiceId ? `/billing/invoices/${input.invoiceId}` : '/billing/autopay', metadata: { event: input.event },
    dedupeKey: `${input.dedupeKey}:${userId}`, read: false,
  }))).onConflictDoNothing();
}

/** Call only after checking the committed lifecycle state, outside its held context. */
export async function sendAutopayStaffEmail(input: AutopayStaffNotice): Promise<void> {
  const recipient = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [partner] = await db.select({ billingEmail: partners.billingEmail }).from(partners)
      .where(eq(partners.id,input.partnerId)).limit(1);
    if (!partner?.billingEmail) return null;
    return { email: partner.billingEmail, name: await orgName(db, input.orgId), number: await invoiceNumber(db, input) };
  }));
  if (!recipient) return;
  const { email, name, number } = recipient;
  const service = getEmailService();
  if (!service) throw new Error('Staff email transport is unavailable');
  const claim = await claimStaffEmail(input);
  if (!claim) return;
  try {
    await runOutsideDbContext(() => service.sendEmail({ to: email, purpose: 'staff.autopay',
      subject: namedTitle(input.event, name),
      html: `${name ? `<p><strong>Client:</strong> ${escapeHtml(name)}</p>` : ''}${number ? `<p><strong>Invoice:</strong> ${escapeHtml(number)}</p>` : ''}<p>${escapeHtml(input.message)}</p>`,
      text: [name ? `Client: ${name}` : '', number ? `Invoice: ${number}` : ''].filter(Boolean).join('\n') + (name || number ? '\n\n' : '') + input.message }));
  } catch (error) {
    // A failed send must not burn the key: release it so the next occurrence can send (F3).
    await claim.release().catch(releaseError => console.error('[autopay] staff email claim release failed',
      { orgId: input.orgId, dedupeKey: input.dedupeKey, error: releaseError instanceof Error ? releaseError.message : String(releaseError) }));
    throw error;
  }
}

/** Seconds a Redis claim holds for an org with no autopay enrollment row. */
const STAFF_EMAIL_CLAIM_TTL_SECONDS = 30 * 86_400;
type StaffEmailClaim = { release: () => Promise<void> };
/** At most one staff email per dedupe key, taken before sending and released if the send
 * fails. Durable on the org's autopay enrollment row (every autopay event has one). An org
 * with none, such as a pay-link card dispute (F1), claims a Redis slot instead; when Redis
 * cannot answer the email is sent anyway, as the lane alerts do (partnerLaneSend.ts): a
 * duplicate staff email is a nuisance, a dropped dispute or failure notice is not. */
async function claimStaffEmail(input: AutopayStaffNotice): Promise<StaffEmailClaim | null> {
  const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
  const claimed = await system(() => db.execute(sql`
    UPDATE org_autopay_enrollments SET staff_email_dedupe_keys=array_append(staff_email_dedupe_keys,${input.dedupeKey})
    WHERE org_id=${input.orgId}::uuid AND partner_id=${input.partnerId}::uuid
      AND NOT (${input.dedupeKey}=ANY(staff_email_dedupe_keys)) RETURNING id`));
  if (Array.from(claimed).length) return { release: async () => { await system(() => db.execute(sql`
    UPDATE org_autopay_enrollments SET staff_email_dedupe_keys=array_remove(staff_email_dedupe_keys,${input.dedupeKey})
    WHERE org_id=${input.orgId}::uuid AND partner_id=${input.partnerId}::uuid`)); } };
  const enrolled = await system(() => db.execute(sql`SELECT id FROM org_autopay_enrollments
    WHERE org_id=${input.orgId}::uuid AND partner_id=${input.partnerId}::uuid LIMIT 1`));
  if (Array.from(enrolled).length) return null; // already claimed: sent before
  const tags = { orgId: input.orgId, partnerId: input.partnerId, event: input.event, dedupeKey: input.dedupeKey };
  console.info('[autopay] staff email for an org with no autopay enrollment: claiming in Redis', tags);
  const key = `autopay:staff-email:${input.orgId}:${createHash('sha256').update(input.dedupeKey).digest('hex')}`;
  try {
    const redis = getRedis();
    if (redis) {
      if (await redis.set(key, '1', 'EX', STAFF_EMAIL_CLAIM_TTL_SECONDS, 'NX') !== 'OK') return null;
      return { release: async () => { await redis.del(key); } };
    }
  } catch { /* fall through: send without a claim */ }
  console.warn('[autopay] staff email could not be deduplicated (Redis unavailable); sending anyway', tags);
  return { release: async () => {} };
}

/** Needs-attention found on a collection path (S-1): in-app in the caller's transaction and
 * the partner billing email once that context exits. Only for observed conditions that stay
 * true if the caller rolls back (missing consent, a method collection cannot use). The email
 * claims emailDedupeKey (default dedupeKey), so a condition that recurs on every run, or that
 * reaches several invoices at once, emails once while each invoice keeps its in-app notice. */
export async function enqueueAutopayStaffAttention(db: Tx, input: AutopayStaffNotice & { emailDedupeKey?: string }): Promise<void> {
  const { emailDedupeKey, ...notice } = input;
  await enqueueAutopayStaffNotifications(db, notice);
  runAfterDbContextExit('autopay.staffAttentionEmail', () => sendAutopayStaffEmail({ ...notice, dedupeKey: emailDedupeKey ?? notice.dedupeKey }));
}

/** Compatibility adapter for callers that already run after commit. */
export async function notifyAutopayStaff(input: AutopayStaffNotice): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(() => enqueueAutopayStaffNotifications(db, input)));
  await sendAutopayStaffEmail(input);
}
