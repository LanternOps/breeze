import { eq } from 'drizzle-orm';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { agreementRequests, contractTemplates } from '../db/schema/contractDocuments';
import { organizations, partners } from '../db/schema/orgs';
import { users } from '../db/schema/users';
import { BODY_PARA, getEmailService, type EmailTemplate } from './email';
import { escapeHtml, renderButton, renderLayout } from './emailLayout';
import { captureException } from './sentry';
import { emitAgreementEvent } from './agreementEvents';

/**
 * Close the loop on an agreement-request outcome (#9075 W2b, spec §3.6):
 * email the MSP staff member who created the request when the client signs or
 * declines. Cloned from notifyQuoteOutcome (services/quoteOutcomeNotify.ts).
 *
 * `source` keeps attribution honest: only a 'customer' outcome emails; an
 * MSP-recorded one does not (the actor already knows). Both publish the
 * `agreement.signed|declined` bus event (services/agreementEvents.ts).
 *
 * Recipient: the request creator's email; fallback the partner billing inbox;
 * neither → warn and skip. Callers dispatch this UNAWAITED, post-commit —
 * failures are logged + captured, never thrown at the client whose response
 * already committed. The DB reads run in one short system context that closes
 * BEFORE the SMTP call, so no pooled connection is pinned across the network
 * round-trip (#1105 class).
 */
export async function notifyAgreementOutcome(input: {
  requestId: string;
  outcome: 'signed' | 'declined';
  source: 'customer' | 'msp';
  signerName?: string | null;
}): Promise<void> {
  try {
    // Phase 1 — everything that touches the database, in one short context.
    const prepared = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [req] = await db
        .select({
          orgId: agreementRequests.orgId,
          createdBy: agreementRequests.createdBy,
          label: agreementRequests.label,
          declineReason: agreementRequests.declineReason,
          templateName: contractTemplates.name,
          orgName: organizations.name,
          partnerId: organizations.partnerId,
        })
        .from(agreementRequests)
        .innerJoin(organizations, eq(organizations.id, agreementRequests.orgId))
        .leftJoin(contractTemplates, eq(contractTemplates.id, agreementRequests.templateId))
        .where(eq(agreementRequests.id, input.requestId))
        .limit(1);
      if (!req) return null;

      // The bus event fires for BOTH sources (an integration must see an
      // MSP-recorded signature too); only a customer outcome emails (#9075 W3b).
      // Deferred to the context's exit so a Redis round-trip never pins this
      // pooled connection (and never delays the email below).
      runAfterDbContextCommit('agreement-outcome.emit', () => emitAgreementEvent({
        type: input.outcome === 'signed' ? 'agreement.signed' : 'agreement.declined',
        requestId: input.requestId,
        orgId: req.orgId,
        partnerId: req.partnerId,
        origin: input.source === 'customer' ? 'customer' : 'on_behalf',
      }));
      if (input.source !== 'customer') return null; // no email for an MSP-recorded outcome

      // Creator first; partner billing inbox as the fallback so the news lands
      // somewhere even when the creator is gone or the request was system-made.
      let recipient: string | null = null;
      if (req.createdBy) {
        const [creator] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.createdBy)).limit(1);
        recipient = creator?.email?.trim() || null;
      }
      if (!recipient) {
        const [partner] = await db.select({ billingEmail: partners.billingEmail }).from(partners).where(eq(partners.id, req.partnerId)).limit(1);
        recipient = partner?.billingEmail?.trim() || null;
      }
      if (!recipient) {
        console.warn('[agreementOutcomeNotify] no recipient for agreement outcome', { requestId: input.requestId, outcome: input.outcome });
        return null;
      }
      return {
        recipient,
        agreementName: req.label?.trim() || req.templateName?.trim() || 'Agreement',
        orgName: req.orgName?.trim() || 'A customer',
        declineReason: req.declineReason,
      };
    }));
    if (!prepared) return;

    // Phase 2 — the SMTP round trip, with no DB context held open underneath.
    const emailService = getEmailService();
    if (!emailService) {
      console.warn('[agreementOutcomeNotify] Email not configured — outcome notice not sent', { requestId: input.requestId, outcome: input.outcome });
      return;
    }

    const webBase = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
    const template = buildAgreementOutcomeTemplate({
      outcome: input.outcome,
      agreementName: prepared.agreementName,
      orgName: prepared.orgName,
      signerName: input.signerName ?? null,
      declineReason: input.outcome === 'declined' ? prepared.declineReason : null,
      agreementsUrl: webBase ? `${webBase}/agreements/signed` : null,
    });
    // INTERNAL notice to MSP staff, never customer-facing (mailPurposes §8.2) —
    // platform sender.
    await emailService.sendEmail({
      to: prepared.recipient,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'staff.agreement_outcome',
    });
  } catch (err) {
    console.error('[agreementOutcomeNotify] failed', { requestId: input.requestId, outcome: input.outcome }, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

export interface AgreementOutcomeEmailParams {
  outcome: 'signed' | 'declined';
  /** The request label, else the template name. */
  agreementName: string;
  orgName: string;
  signerName: string | null;
  declineReason: string | null;
  /** Deep link to Signed agreements; null when no web base is configured. */
  agreementsUrl: string | null;
}

export function buildAgreementOutcomeTemplate(params: AgreementOutcomeEmailParams): EmailTemplate {
  const verb = params.outcome;
  // Header-safe: a staff-authored label must not carry a line break into Subject.
  const subject = `Agreement ${params.agreementName} ${verb} — ${params.orgName}`.replace(/[\r\n]+/g, ' ');
  const who = params.signerName?.trim() ? `${params.signerName.trim()} at ${params.orgName}` : params.orgName;
  const reason = params.outcome === 'declined' ? params.declineReason?.trim() : undefined;
  const reasonBlock = reason
    ? `<p style="${BODY_PARA}">Their note:</p>
       <blockquote style="margin: 0 0 12px; padding: 10px 14px; border-left: 3px solid #d1d5db; font-size: 14px; line-height: 1.55; color: #374151;">${escapeHtml(reason).replace(/\r?\n/g, '<br>')}</blockquote>`
    : '';
  const signedLine = params.outcome === 'signed'
    ? `<p style="${BODY_PARA}">The signed agreement has been filed, and a copy is being emailed to the signer.</p>`
    : '';
  const body = `
      <p style="${BODY_PARA}">${escapeHtml(who)} has <strong>${verb}</strong> the agreement <strong>${escapeHtml(params.agreementName)}</strong>.</p>
      ${reasonBlock}
      ${signedLine}
      ${params.agreementsUrl ? renderButton('View signed agreements', params.agreementsUrl) : ''}
  `;
  const html = renderLayout({
    title: subject,
    preheader: `${params.orgName} ${verb} ${params.agreementName}.`,
    heading: `Agreement ${verb}`,
    body,
  });
  const text = [
    `${who} has ${verb} the agreement ${params.agreementName}.`,
    reason ? `Their note: ${reason}` : null,
    params.outcome === 'signed' ? 'The signed agreement has been filed, and a copy is being emailed to the signer.' : null,
    params.agreementsUrl ? `View signed agreements: ${params.agreementsUrl}` : null,
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
