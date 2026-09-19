import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerUsers, roles, users } from '../../db/schema';
import { BODY_PARA, MUTED_PARA, getEmailService, supportFooter, type EmailTemplate } from '../email';
import { escapeHtml, renderButton, renderLayout } from '../emailLayout';
import { captureException } from '../sentry';

export type SendingDomainStatusEvent = 'verified' | 'at_risk' | 'failed' | 'suspended' | 'auto_removed';

export interface SendingDomainStatusMailInput {
  partnerId: string;
  domain: string;
  event: SendingDomainStatusEvent;
  /** Machine code from partner_sending_domains.status_reason (spec §3.1). */
  statusReason?: string | null;
  /** users.id of whoever added the domain; may be null after a user delete. */
  createdBy?: string | null;
  /** Absolute link to the settings tab; omitted when PUBLIC_APP_URL is unset. */
  appUrl?: string | null;
}

const HEADLINE: Record<SendingDomainStatusEvent, string> = {
  verified: 'Sending domain verified',
  at_risk: 'Sending domain at risk',
  failed: 'Sending domain could not be verified',
  suspended: 'Sending domain suspended',
  auto_removed: 'Sending domain removed',
};

const LEAD: Record<SendingDomainStatusEvent, (domain: string) => string> = {
  verified: (d) => `${d} is verified. Mail for the streams you have configured now sends from it.`,
  at_risk: (d) => `We can no longer see the DNS records for ${d}. Mail still sends for now, but the provider will fail the domain if the records stay missing.`,
  failed: (d) => `${d} could not be verified and is not sending any mail.`,
  suspended: (d) => `${d} has been suspended by Breeze. Mail for its streams is sending from the Breeze address instead.`,
  auto_removed: (d) => `${d} was removed after staying unverified past the retry window. You can add it again once its DNS records are in place.`,
};

/** status_reason codes (spec §3.1) rendered for a human. Unknown codes are omitted rather than leaked raw. */
const REASON_TEXT: Record<string, string> = {
  provider_conflict: 'The domain is already registered with Breeze or our email provider.',
  provider_rejected: 'Our email provider refused the domain.',
  quota_exhausted: 'Our email provider is at its domain limit. Support has been alerted.',
  dns_not_detected: 'The DNS records were not detected in time.',
  dns_removed: 'The DNS records were removed after the domain had verified.',
  platform_suspended: 'A Breeze administrator suspended the domain.',
  abuse_auto: 'Automatic suspension after a deliverability problem.',
  failed_expired: 'The domain stayed unverified past the retry window.',
  user_removed: 'Removed at your request.',
};

/**
 * Same idiom as `buildQuoteOutcomeTemplate` (services/email.ts): compute
 * subject/preheader/body, run every interpolated value through `escapeHtml`,
 * build the HTML through the shared `renderLayout` shell (never a hand-written
 * one), and assemble the text arm by filtering nulls out of a line list.
 * Breeze-branded — this goes TO the MSP, not to their customer.
 */
export function buildSendingDomainStatusTemplate(input: SendingDomainStatusMailInput): EmailTemplate {
  const subject = `${HEADLINE[input.event]}: ${input.domain}`;
  const lead = LEAD[input.event](input.domain);
  const reason = input.statusReason ? REASON_TEXT[input.statusReason] : undefined;

  const body = `
      <p style="${BODY_PARA}">${escapeHtml(lead)}</p>
      ${reason ? `<p style="${BODY_PARA}">${escapeHtml(reason)}</p>` : ''}
      ${input.appUrl ? renderButton('Open sending domains', input.appUrl) : ''}
      <p style="${MUTED_PARA}">You are receiving this because you added this domain, or you administer this Breeze account.</p>
  `;

  const html = renderLayout({
    title: subject,
    preheader: lead,
    heading: HEADLINE[input.event],
    body,
    footer: supportFooter(undefined, 'Need help? Contact'),
  });

  const text = [
    lead,
    reason ?? null,
    input.appUrl ? `Open sending domains: ${input.appUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

/**
 * Recipients: the user who added the domain plus the partner's admins
 * (spec §6.3). Runs in SYSTEM scope — `partner_users` / `users` are partner-axis
 * and this is called from the worker, which has no tenant context at all.
 *
 * The `roles.name = 'Partner Admin'` join is duplicated rather than shared: the
 * same query already exists at `routes/auth/accountDeletion.ts:62-98` and
 * `services/tenantOffboarding.ts:1767-1783`, and extracting a helper would mean
 * editing two unrelated files inside a tenancy-surface PR. If a third caller
 * appears after this one, extract all four together.
 */
async function resolveRecipients(input: SendingDomainStatusMailInput): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const out: string[] = [];
    if (input.createdBy) {
      const creator = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, input.createdBy), eq(users.status, 'active')))
        .limit(1);
      const email = creator[0]?.email?.trim();
      if (email) out.push(email);
    }
    const admins = await db
      .select({ email: users.email })
      .from(partnerUsers)
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
      .where(and(
        eq(partnerUsers.partnerId, input.partnerId),
        eq(roles.name, 'Partner Admin'),
        eq(users.status, 'active'),
      ));
    for (const row of admins) {
      const email = row.email?.trim();
      if (email) out.push(email);
    }
    return [...new Set(out)];
  }, 'sendingDomainStatusMailRecipients');
}

/**
 * Fire the status notice. Returns the number of addresses it went to.
 *
 * NEVER throws: this is called after a status transition has already been
 * committed, and a bounced notice must not turn a correct transition into a
 * failed job that retries the provider call.
 */
export async function sendSendingDomainStatusEmail(input: SendingDomainStatusMailInput): Promise<number> {
  const email = getEmailService();
  if (!email) return 0;
  try {
    const to = await resolveRecipients(input);
    if (to.length === 0) return 0;
    const template = buildSendingDomainStatusTemplate(input);
    // The DB context above has closed; the transport round trip runs with no
    // pooled connection held (#1105).
    await email.sendEmail({
      to,
      purpose: 'staff.sending_domain_status',
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return to.length;
  } catch (err) {
    console.error('[SendingDomains] status email failed:', err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return 0;
  }
}
