import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  contracts, contractRenewalNotices, organizations, organizationUsers, partnerUsers, users
} from '../db/schema';
import { emitContractEvent } from './contractEvents';
import { sendInAppNotification } from './notificationSenders/inAppSender';
import { getEmailService } from './email';
import { buildContractRenewalEmail } from './contractRenewalTemplate';
import { duePeriodStartFor, extendTermPastDue, isWithinNoticeWindow } from './contractMath';
import { captureException } from './sentry';

const WEB_BASE = process.env.PUBLIC_APP_URL ?? '';

interface RenewalCandidate {
  id: string; orgId: string; partnerId: string; name: string;
  billingTiming: 'advance' | 'arrears'; intervalMonths: number;
  endDate: string | null; nextBillingAt: string | null;
  autoRenew: boolean; renewalTermMonths: number | null; renewalNoticeDays: number | null;
}

/** Resolve the MSP's notifiable users (active org users + active partner users with access). */
async function resolveMspRecipients(orgId: string, partnerId: string): Promise<{ userId: string; email: string }[]> {
  const orgUsersRows = await db.select({ userId: organizationUsers.userId, email: users.email })
    .from(organizationUsers).innerJoin(users, eq(organizationUsers.userId, users.id))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active')));
  const pUsersRows = await db.select({ userId: partnerUsers.userId, email: users.email })
    .from(partnerUsers).innerJoin(users, eq(partnerUsers.userId, users.id))
    .where(and(
      eq(partnerUsers.partnerId, partnerId), eq(users.status, 'active'),
      or(
        eq(partnerUsers.orgAccess, 'all'),
        and(eq(partnerUsers.orgAccess, 'selected'), sql`${orgId} = ANY(${partnerUsers.orgIds})`)
      )
    ));
  const byId = new Map<string, string>();
  for (const u of [...orgUsersRows, ...pUsersRows]) {
    if (u.email) byId.set(u.userId, u.email);
  }
  return [...byId.entries()].map(([userId, email]) => ({ userId, email }));
}

/** Claim a (contract, end_date, kind) notice slot. Returns true iff this caller won the claim. */
async function claimNotice(c: RenewalCandidate, endDate: string, kind: 'advance' | 'renewed'): Promise<boolean> {
  const rows = await db.insert(contractRenewalNotices)
    .values({ contractId: c.id, orgId: c.orgId, endDate, kind })
    .onConflictDoNothing({
      target: [contractRenewalNotices.contractId, contractRenewalNotices.endDate, contractRenewalNotices.kind]
    })
    .returning({ id: contractRenewalNotices.id });
  return rows.length > 0;
}

/** Best-effort dispatch: in-app to MSP users + email to MSP users. Never throws. */
async function dispatchNotice(c: RenewalCandidate, kind: 'advance' | 'renewed', endDate: string): Promise<void> {
  try {
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, c.orgId)).limit(1);
    const orgName = org?.name ?? 'your customer';
    const contractUrl = `${WEB_BASE}/contracts/${c.id}`;
    const summary = kind === 'advance'
      ? `Contract "${c.name}" for ${orgName} auto-renews on ${endDate}.`
      : `Contract "${c.name}" for ${orgName} auto-renewed through ${endDate}.`;

    await sendInAppNotification({
      alertId: `contract-renewal-${c.id}-${endDate}-${kind}`,
      alertName: kind === 'advance' ? 'Contract renewal upcoming' : 'Contract renewed',
      severity: 'info', message: summary, orgId: c.orgId, link: `/contracts/${c.id}`
    });

    const emailService = getEmailService();
    if (emailService) {
      const recipients = await resolveMspRecipients(c.orgId, c.partnerId);
      if (recipients.length > 0) {
        const tpl = buildContractRenewalEmail({
          kind, contractName: c.name, orgName, endDate, contractUrl,
          noticeDays: kind === 'advance' ? (c.renewalNoticeDays ?? undefined) : undefined
        });
        await emailService.sendEmail({ to: recipients.map((r) => r.email), subject: tpl.subject, html: tpl.html, text: tpl.text });
      }
    }
  } catch (err) {
    console.error('[ContractRenewal] notice dispatch failed', `contractId=${c.id}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Renewal pre-pass. Runs (inside a system DB context) BEFORE the billing sweep so an
 * about-to-expire auto-renew contract has its term extended before billing decides expiry.
 *  Pass A: advance notice for contracts inside their notice window (keyed on current endDate).
 *  Pass B: extend the term for contracts whose next billable period would expire, then
 *          emit contract.auto_renewed and claim a 'renewed' notice keyed on the NEW endDate.
 */
export async function runContractRenewalSweep(asOf: Date = new Date()): Promise<{ noticed: number; renewed: number }> {
  const today = asOf.toISOString().slice(0, 10);

  const candidates = await db.select({
    id: contracts.id, orgId: contracts.orgId, partnerId: contracts.partnerId, name: contracts.name,
    billingTiming: contracts.billingTiming, intervalMonths: contracts.intervalMonths,
    endDate: contracts.endDate, nextBillingAt: contracts.nextBillingAt,
    autoRenew: contracts.autoRenew, renewalTermMonths: contracts.renewalTermMonths, renewalNoticeDays: contracts.renewalNoticeDays
  }).from(contracts).where(and(eq(contracts.status, 'active' as never), eq(contracts.autoRenew, true), isNotNull(contracts.endDate)));

  let noticed = 0;
  let renewed = 0;

  for (const c of candidates as RenewalCandidate[]) {
    if (!c.endDate || c.renewalTermMonths == null) continue;

    // Pass A — advance notice (based on the CURRENT end_date).
    const noticeDays = c.renewalNoticeDays ?? 30;
    if (isWithinNoticeWindow(today, c.endDate, noticeDays)) {
      if (await claimNotice(c, c.endDate, 'advance')) {
        await dispatchNotice(c, 'advance', c.endDate);
        noticed++;
      }
    }

    // Pass B — extend if the next billable period would expire.
    // Only consider contracts whose billing sweep would run today (nextBillingAt <= today);
    // a future nextBillingAt means the billing sweep hasn't reached this contract yet.
    if (c.nextBillingAt && c.nextBillingAt <= today) {
      const duePeriodStart = duePeriodStartFor(c.billingTiming, c.nextBillingAt, c.intervalMonths);
      const { newEndDate, renewed: didRenew } = extendTermPastDue({ endDate: c.endDate, duePeriodStart, termMonths: c.renewalTermMonths });
      if (didRenew) {
        await db.update(contracts).set({ endDate: newEndDate, updatedAt: asOf }).where(eq(contracts.id, c.id));
        await emitContractEvent({ type: 'contract.auto_renewed', contractId: c.id, orgId: c.orgId, partnerId: c.partnerId });
        if (await claimNotice(c, newEndDate, 'renewed')) {
          await dispatchNotice({ ...c, endDate: newEndDate }, 'renewed', newEndDate);
        }
        renewed++;
      }
    }
  }

  return { noticed, renewed };
}
