import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  contracts, contractRenewalNotices, organizations, organizationUsers, partnerUsers, users
} from '../db/schema';
import { emitContractEvent } from './contractEvents';
import { sendInAppNotification } from './notificationSenders/inAppSender';
import { getEmailService } from './email';
import { buildContractRenewalEmail } from './contractRenewalTemplate';
import { extendTermThrough, isAutoRenewing, isWithinNoticeWindow } from './contractMath';
import { captureException } from './sentry';
import { buildAutomationEligibleOrgPredicate } from './tenantStatus';

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
        // To MSP staff, not the customer (spec §8.2) — platform sender.
        await emailService.sendEmail({ to: recipients.map((r) => r.email), subject: tpl.subject, html: tpl.html, text: tpl.text, purpose: 'staff.contract_renewal' });
      }
    }
  } catch (err) {
    console.error('[ContractRenewal] notice dispatch failed', `contractId=${c.id}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Renewal pre-pass. Runs (inside a system DB context) BEFORE the billing sweep so an
 * auto-renew contract whose term has ended is extended before billing bills the next period.
 *  Pass A: advance notice for contracts inside their notice window (keyed on current endDate).
 *  Pass B: on/after end_date, extend the term by whole renewal terms (#9243), then
 *          emit contract.auto_renewed and claim a 'renewed' notice keyed on the NEW endDate.
 */
export async function runContractRenewalSweep(asOf: Date = new Date()): Promise<{ noticed: number; renewed: number }> {
  const today = asOf.toISOString().slice(0, 10);

  const candidates = await db.select({
    id: contracts.id, orgId: contracts.orgId, partnerId: contracts.partnerId, name: contracts.name,
    billingTiming: contracts.billingTiming, intervalMonths: contracts.intervalMonths,
    endDate: contracts.endDate, nextBillingAt: contracts.nextBillingAt,
    autoRenew: contracts.autoRenew, renewalTermMonths: contracts.renewalTermMonths, renewalNoticeDays: contracts.renewalNoticeDays
  }).from(contracts).where(and(
    eq(contracts.status, 'active' as never),
    eq(contracts.autoRenew, true),
    isNotNull(contracts.endDate),
    // Org-lifecycle Wave 4: an ARCHIVED/purging/merging tenant must not have
    // its contract term silently extended (or its MSP emailed about a renewal)
    // while the org is hidden and counting down to erasure.
    buildAutomationEligibleOrgPredicate(contracts.orgId),
  ));

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

    // Pass B — renew once the term has ended (#9243): on end_date itself, the date
    // the advance notice promised. Not earlier: generateDueInvoice leaves an
    // auto-renewing contract active after its final invoice, with its pointer at
    // the next period, so it waits for this pass instead of expiring. Billing runs
    // after this pass in the same job, so the period starting on end_date bills
    // under the renewed term (see extendTermThrough for the invariant).
    if (!isAutoRenewing(c)) continue;
    const { newEndDate, renewed: didRenew } = extendTermThrough({ endDate: c.endDate, asOfISO: today, termMonths: c.renewalTermMonths });
    if (!didRenew) continue;
    // Conditional on everything the decision read. The candidate list was read
    // unlocked, so a pause, cancel, auto-renew opt-out or end-date edit that
    // committed since must win. In that case zero rows match and nothing is
    // emitted or noticed.
    const updated = await db.update(contracts).set({ endDate: newEndDate, updatedAt: asOf }).where(and(
      eq(contracts.id, c.id),
      eq(contracts.status, 'active' as never),
      eq(contracts.autoRenew, true),
      eq(contracts.endDate, c.endDate),
      eq(contracts.renewalTermMonths, c.renewalTermMonths),
    )).returning({ id: contracts.id });
    if (updated.length === 0) {
      console.info('[ContractRenewal] renewal skipped: contract changed since the sweep read it (paused/cancelled/opted out/end date edited)', `contractId=${c.id}`);
      continue;
    }
    await emitContractEvent({ type: 'contract.auto_renewed', contractId: c.id, orgId: c.orgId, partnerId: c.partnerId });
    if (await claimNotice(c, newEndDate, 'renewed')) {
      await dispatchNotice({ ...c, endDate: newEndDate }, 'renewed', newEndDate);
    }
    renewed++;
  }

  return { noticed, renewed };
}
