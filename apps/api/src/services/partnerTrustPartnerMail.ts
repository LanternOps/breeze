// apps/api/src/services/partnerTrustPartnerMail.ts
import { and, eq } from 'drizzle-orm';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners, users } from '../db/schema';
import { BODY_PARA, MUTED_PARA, getEmailService, supportFooter, type EmailTemplate } from './email';
import { escapeHtml, renderButton, renderLayout } from './emailLayout';
import { listActivePartnerAdmins } from './partnerAdminRecipients';
import { captureException } from './sentry';

/**
 * Breeze → partner admins, about the partner's own trust review (#8713).
 *
 * Same idiom as services/emailDomains/statusMail.ts: compute subject /
 * preheader / body, run every interpolated value through `escapeHtml`, build
 * the HTML through the shared `renderLayout` shell, assemble the text arm from
 * a line list. Breeze-branded and on the platform lane — this goes TO the MSP,
 * not to their customer, and must never be partner-editable (so it does not
 * live in services/emailTemplates/).
 *
 * Partner-facing trust mail is exactly these two notices. Both senders are
 * inert unless PARTNER_TRUST_MODE is `enforce`, and both NEVER throw: they run
 * after a trust write or an accepted request has already landed, and a
 * bounced notice must not undo either.
 */

export const GETTING_STARTED_DOCS_URL = 'https://docs.breezermm.com/getting-started/quickstart/';

const WHY_REVIEW = "You're receiving this because you requested the review or administer this Breeze account.";
const WHY_APPROVED = "You're receiving this because you administer this Breeze account.";

export function buildTrustReviewReceivedTemplate(input: { partnerName: string; meetingUrl: string | null }): EmailTemplate {
  const subject = 'We received your review request';
  const heading = 'Review request received';
  const preheader = "We'll follow up by email.";
  const lead = `We received your request to review ${input.partnerName}. We'll follow up by email once the review is complete.`;
  const meanwhile = 'You can keep using Breeze in the meantime. Remote control and script execution stay paused while the review is open.';

  const body = `
      <p style="${BODY_PARA}">${escapeHtml(lead)}</p>
      <p style="${BODY_PARA}">${escapeHtml(meanwhile)}</p>
      ${input.meetingUrl ? renderButton('Book a call', input.meetingUrl) : ''}
      <p style="${MUTED_PARA}">${escapeHtml(WHY_REVIEW)}</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading,
    body,
    footer: supportFooter(undefined, 'Need help? Contact'),
  });
  const text = [
    lead,
    meanwhile,
    input.meetingUrl ? `Book a call: ${input.meetingUrl}` : null,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

export function buildTrustApprovedTemplate(input: { partnerName: string; appUrl: string | null; docsUrl?: string }): EmailTemplate {
  const docsUrl = input.docsUrl ?? GETTING_STARTED_DOCS_URL;
  const subject = 'Your Breeze account is approved';
  const heading = 'Account approved';
  const preheader = 'Remote control and script execution are now enabled.';
  const lead = `${input.partnerName} has been reviewed and approved.`;
  // Mirrors GatedCapability in user words. Update this sentence when a
  // capability is added to the gate; there is no generated list.
  const enabled = 'Remote control, script execution and Trust Center page publishing are now enabled. The probation limits on agent enrollment, installer links and custom sending domains are lifted.';
  const docs = 'New to Breeze? Start with the getting-started guide:';

  const body = `
      <p style="${BODY_PARA}">${escapeHtml(lead)}</p>
      <p style="${BODY_PARA}">${escapeHtml(enabled)}</p>
      ${input.appUrl ? renderButton('Open Breeze', input.appUrl) : ''}
      <p style="${BODY_PARA}">${escapeHtml(docs)} <a href="${escapeHtml(docsUrl)}">${escapeHtml(docsUrl)}</a></p>
      <p style="${MUTED_PARA}">${escapeHtml(WHY_APPROVED)}</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading,
    body,
    footer: supportFooter(undefined, 'Need help? Contact'),
  });
  const text = [
    lead,
    enabled,
    input.appUrl ? `Open Breeze: ${input.appUrl}` : null,
    `${docs} ${docsUrl}`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

// Same PUBLIC_APP_URL / DASHBOARD_URL precedence as the other web-app deep
// links (services/quoteOutcomeNotify.ts, partnerTrustEvidenceCard.ts). The
// button is optional, so an unset value is `null`, never a throw.
function appBaseUrl(): string | null {
  const value = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || '').trim();
  return value ? value.replace(/\/+$/, '') : null;
}

function meetingUrl(): string | null {
  const value = process.env.PARTNER_MEETING_URL?.trim();
  return value || null;
}

interface MailContext {
  partnerName: string;
  trustState: string;
  requesterEmail: string | null;
}

/**
 * One system-scope round trip for the partner row (name + status) and, when
 * asked, the requester's address. Returns null unless the partner exists and
 * is `active`. Runs outside any ambient request context first: `setTrustState`
 * is reached from admin request handlers as well as from the worker, and
 * `withSystemDbAccessContext` alone short-circuits when a context already
 * exists (see partnerTrustEvidenceCard.buildEvidenceCard).
 */
async function loadMailContext(partnerId: string, requestedByUserId?: string): Promise<MailContext | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [partner] = await db
      .select({ name: partners.name, status: partners.status, trustState: partners.trustState })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    if (!partner || partner.status !== 'active') return null;

    let requesterEmail: string | null = null;
    if (requestedByUserId) {
      const [requester] = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, requestedByUserId), eq(users.status, 'active')))
        .limit(1);
      requesterEmail = requester?.email?.trim() || null;
    }
    return { partnerName: partner.name, trustState: partner.trustState, requesterEmail };
  }, 'partnerTrustPartnerMail.context'));
}

function dedupe(addresses: Array<string | null>): string[] {
  return [...new Set(addresses.filter((a): a is string => Boolean(a)))];
}

function reportFailure(which: string, err: unknown): 0 {
  console.error(`[PartnerTrust] ${which} email failed:`, err instanceof Error ? err.message : err);
  captureException(err instanceof Error ? err : new Error(String(err)));
  return 0;
}

/** Returns the number of addresses it went to; 0 when skipped or failed. Never throws. */
export async function sendTrustReviewReceivedEmail(input: { partnerId: string; requestedByUserId: string }): Promise<number> {
  const email = getEmailService();
  if (!email) return 0;
  if (partnerTrustMode() !== 'enforce') return 0;
  try {
    const context = await loadMailContext(input.partnerId, input.requestedByUserId);
    if (!context) return 0;
    // Already trusted (approved while the request was in flight, or a stale
    // click): "we'll email you when it's done" would contradict reality.
    if (context.trustState === 'trusted') return 0;
    const admins = await listActivePartnerAdmins(input.partnerId);
    const to = dedupe([context.requesterEmail, ...admins.map((admin) => admin.email)]);
    if (to.length === 0) return 0;
    const template = buildTrustReviewReceivedTemplate({ partnerName: context.partnerName, meetingUrl: meetingUrl() });
    // loadMailContext and listActivePartnerAdmins run in their own system
    // contexts, which have closed here. Callers defer this send until the
    // request transaction has ended (runAfterDbContextCommit/Exit), so the
    // transport round trip holds no pooled connection (#1105).
    await email.sendEmail({
      to,
      purpose: 'account.trust_review_received',
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return to.length;
  } catch (err) {
    return reportFailure('review-received', err);
  }
}

/** Returns the number of addresses it went to; 0 when skipped or failed. Never throws. */
export async function sendTrustApprovedEmail(input: { partnerId: string }): Promise<number> {
  const email = getEmailService();
  if (!email) return 0;
  if (partnerTrustMode() !== 'enforce') return 0;
  try {
    const context = await loadMailContext(input.partnerId);
    if (!context) return 0;
    const admins = await listActivePartnerAdmins(input.partnerId);
    const to = dedupe(admins.map((admin) => admin.email));
    if (to.length === 0) return 0;
    const template = buildTrustApprovedTemplate({ partnerName: context.partnerName, appUrl: appBaseUrl() });
    await email.sendEmail({
      to,
      purpose: 'account.trust_approved',
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return to.length;
  } catch (err) {
    return reportFailure('approved', err);
  }
}
