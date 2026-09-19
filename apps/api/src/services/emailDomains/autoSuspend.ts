import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerSendingDomains, partners } from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLogAsync } from '../auditService';
import { sendOpsAlert } from '../opsAlerts';
import { getEmailDomainsConfig } from './config';
import { STATS_WINDOW_DAYS, loadPartnerSendingWindowStats } from './deliveryStats';
import { suspendSendingDomain } from './sendingDomainService';
import { sendSendingDomainStatusEmail } from './statusMail';

/**
 * Automatic suspension on poor deliverability (spec §9.3).
 *
 * Two independent rules over the trailing STATS_WINDOW_DAYS days:
 *
 *   1. bounce rate STRICTLY above the configured fraction, over at least
 *      `minMessages` messages. "At least" and "strictly above" are both
 *      deliberate: a partner sitting exactly on the published threshold has not
 *      crossed it, and a rate computed over a handful of messages is noise.
 *   2. `complaints` or more spam complaints, regardless of volume. A complaint
 *      is a human pressing "this is spam"; three of them is not a rate.
 *
 * Both thresholds sit well inside Resend's ACCOUNT-wide limits (bounce < 4%,
 * spam < 0.08%) because many partners share the one partner-lane account: one
 * partner must be stopped long before it can pause the account for everyone.
 *
 * On self-hosted this is OFF unless the operator sets a threshold
 * (services/emailDomains/config.ts) — the same reasoning as the unlimited
 * self-hosted send cap.
 *
 * Unsuspension is always manual (a platform admin, spec §9.1). Nothing here
 * ever clears a suspension.
 *
 * DB CONTEXT: every read runs in a short system transaction; the suspension
 * writes go through sendingDomainService, which opens its own. The notices and
 * the ops alert make network round trips and therefore run with NO pooled
 * connection held (#1105).
 */

export type AutoSuspensionOutcome =
  | 'disabled'
  | 'no_active_domains'
  | 'below_thresholds'
  | 'suspended_bounce_rate'
  | 'suspended_complaints';

export interface AutoSuspensionResult {
  outcome: AutoSuspensionOutcome;
  suspendedDomainIds: string[];
}

/**
 * Statuses that can still put mail on the partner lane (spec §5.2). A row that
 * is already `suspended`, `failed`, `removing`, `provisioning` or `pending` is
 * not sending, so suspending it would be noise — and filtering here is what
 * makes a repeat evaluation an exact no-op.
 */
const SENDABLE_STATUSES = ['verified', 'at_risk'] as const;

interface ActiveDomainRow {
  id: string;
  domain: string;
  createdBy: string | null;
  partnerName: string;
}

export async function evaluateAutoSuspension(partnerId: string): Promise<AutoSuspensionResult> {
  const cfg = getEmailDomainsConfig().autoSuspend;
  if (!cfg.enabled) return { outcome: 'disabled', suspendedDomainIds: [] };

  const rows = await withSystemDbAccessContext(() => db
    .select({
      id: partnerSendingDomains.id,
      domain: partnerSendingDomains.domain,
      createdBy: partnerSendingDomains.createdBy,
      partnerName: partners.name,
    })
    .from(partnerSendingDomains)
    .innerJoin(partners, eq(partners.id, partnerSendingDomains.partnerId))
    .where(and(
      eq(partnerSendingDomains.partnerId, partnerId),
      inArray(partnerSendingDomains.status, [...SENDABLE_STATUSES]),
    ))
    .orderBy(partnerSendingDomains.createdAt), 'emailDomainsAutoSuspendLoad') as ActiveDomainRow[];

  if (rows.length === 0) return { outcome: 'no_active_domains', suspendedDomainIds: [] };

  const stats = await loadPartnerSendingWindowStats(partnerId);

  const rateBreached = stats.messages >= cfg.minMessages && stats.bounceRate > cfg.bounceRate;
  const complaintsBreached = stats.complained >= cfg.complaints;
  if (!rateBreached && !complaintsBreached) {
    return { outcome: 'below_thresholds', suspendedDomainIds: [] };
  }

  // Complaints win the label when both fire: a human marking mail as spam is
  // the stronger statement, and the ops alert reads better for it.
  const outcome: AutoSuspensionOutcome = complaintsBreached ? 'suspended_complaints' : 'suspended_bounce_rate';
  const reasonLine = complaintsBreached
    ? `${stats.complained} spam complaints in ${STATS_WINDOW_DAYS} days (threshold ${cfg.complaints})`
    : `bounce rate ${(stats.bounceRate * 100).toFixed(2)}% over ${stats.messages} messages in ${STATS_WINDOW_DAYS} days (threshold ${(cfg.bounceRate * 100).toFixed(2)}%, min ${cfg.minMessages})`;

  const suspendedDomainIds: string[] = [];
  for (const row of rows) {
    try {
      await suspendSendingDomain(row.id, 'abuse_auto');
    } catch (err) {
      // One domain refusing to suspend must not leave the others sending.
      console.error(
        `[emailDomains/autoSuspend] failed to suspend ${row.id} (${row.domain}):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    suspendedDomainIds.push(row.id);

    await withSystemDbAccessContext(() => createAuditLogAsync({
      orgId: null,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'partner_sending_domain.auto_suspended',
      resourceType: 'partner_sending_domain',
      resourceId: row.id,
      resourceName: row.domain,
      details: {
        partnerId,
        outcome,
        reason: reasonLine,
        windowDays: STATS_WINDOW_DAYS,
        messages: stats.messages,
        bounced: stats.bounced,
        complained: stats.complained,
        thresholds: { bounceRate: cfg.bounceRate, minMessages: cfg.minMessages, complaints: cfg.complaints },
      },
      result: 'success',
    }), 'emailDomainsAutoSuspendAudit');

    // OUTSIDE any DB context: a transport round trip, and it must never turn a
    // correct suspension into a thrown job that retries the whole evaluation.
    try {
      await sendSendingDomainStatusEmail({
        partnerId,
        domain: row.domain,
        event: 'suspended',
        statusReason: 'abuse_auto',
        createdBy: row.createdBy,
      });
    } catch (err) {
      console.error(
        `[emailDomains/autoSuspend] status mail failed for ${row.domain}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (suspendedDomainIds.length > 0) {
    // ONE alert for the partner, not one per domain: the operator is being told
    // about an account, and N pages for one account is how an alert channel
    // gets muted.
    const partnerName = rows[0]!.partnerName;
    try {
      await sendOpsAlert({
        title: `Sending domains auto-suspended: ${partnerName}`,
        body: [
          `Partner: ${partnerName}`,
          `Partner id: ${partnerId}`,
          `Reason: ${reasonLine}`,
          `Domains suspended (${suspendedDomainIds.length}): ${rows.filter((r) => suspendedDomainIds.includes(r.id)).map((r) => r.domain).join(', ')}`,
          `Window totals: sent=${stats.sent} delivered=${stats.delivered} bounced=${stats.bounced} complained=${stats.complained} failed=${stats.failed} suppressed=${stats.suppressed}`,
          'Unsuspending is manual: /admin/sending-domains (platform admin + MFA).',
        ].join('\n'),
      });
    } catch (err) {
      console.error('[emailDomains/autoSuspend] ops alert failed:', err instanceof Error ? err.message : err);
    }
  }

  return { outcome, suspendedDomainIds };
}
