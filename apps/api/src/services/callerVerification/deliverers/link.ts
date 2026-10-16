/**
 * Post-commit SMS/email link delivery (#6354 W03).
 *
 * Called by the row-backed publisher through `callerVerificationPorts.deliver`
 * after the verification row committed. Shape:
 *   short system read → provider I/O with no DB context → short system write
 * so no pooled connection is held across Twilio/SMTP.
 *
 * Outcomes:
 *  - provider accepted → `link_sent` audit only; status stays `pending`
 *    (acceptance is never approval);
 *  - provider refused / no transport / destination changed / sealed material
 *    unusable → `applyDecision({kind:'undeliverable'})`, whose CAS writes the
 *    `undeliverable` audit;
 *  - `delivery_published_at` is stamped right after acceptance and BEFORE the
 *    audit write; an audit failure is logged + reported, never thrown, so a
 *    send is never repeated because of it.
 *
 * At-least-once only across a crash between provider acceptance and the mark:
 * that re-sends the SAME sealed token; a new token is never minted on retry.
 * Neither the token nor the URL is ever logged or audited.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { callerVerifications as v } from '../../../db/schema/callerVerification';
import { getTwilioService } from '../../twilio';
import { buildCallerVerificationTemplate, getEmailService } from '../../email';
import { applyDecision } from '../service';
import { recordEffect } from '../effects';
import { captureException } from '../../sentry';
import { loadLinkDelivery, type LinkDelivery } from '../publicLookup';
import { hashLinkToken, linkUrl, openLinkToken } from '../linkChallenge';

type FailureReason = 'sms_failed' | 'email_failed';

/**
 * A fault that will fail EVERY link (bad key material, no transport) — not a
 * per-recipient refusal — goes to Sentry with a fixed message, never the
 * token, URL or provider text.
 */
function reportSystemic(code: string, verificationId: string): void {
  captureException(new Error(`caller verification link delivery: ${code}`), undefined, { verificationId, code });
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Returns null on provider acceptance, else the undeliverable reason. */
async function send(row: LinkDelivery): Promise<FailureReason | null> {
  const failed: FailureReason = row.method === 'sms' ? 'sms_failed' : 'email_failed';
  if (!row.destination) {
    console.warn('[callerVerification] link destination changed since start; marking undeliverable', { verificationId: row.id });
    return failed;
  }
  let url: string;
  try {
    if (!row.sealedLinkToken) throw new Error('link_not_prepared');
    const token = openLinkToken(row.id, row.sealedLinkToken);
    if (hashLinkToken(token) !== row.challengeTokenHash) throw new Error('link_token_mismatch');
    url = linkUrl(token);
  } catch (err) {
    // Message is one of our own fixed codes (never token material).
    const code = err instanceof Error ? err.message : 'unknown';
    console.error('[callerVerification] link material unusable; marking undeliverable', { verificationId: row.id, error: code });
    reportSystemic(code === 'app_url_invalid' ? code : 'link_material_unusable', row.id);
    return failed;
  }
  try {
    if (row.method === 'sms') {
      const twilio = getTwilioService('messaging');
      if (!twilio) {
        console.error('[callerVerification] SMS link: Twilio messaging not configured', { verificationId: row.id });
        reportSystemic('sms_transport_unconfigured', row.id);
        return failed;
      }
      const result = await twilio.sendSmsMessage(row.destination,
        `${row.technicianLabel} from ${row.partnerName} wants to ${row.requestLabel}. Review: ${url} `
        + 'If you are not sure, hang up and call them on the number you already have.');
      if (!result.success) {
        console.error('[callerVerification] SMS link refused by provider', { verificationId: row.id, userError: result.isUserError ?? false });
        return failed;
      }
      return null;
    }
    const email = getEmailService();
    if (!email) {
      console.error('[callerVerification] email link: no email transport configured', { verificationId: row.id });
      reportSystemic('email_transport_unconfigured', row.id);
      return failed;
    }
    await email.sendEmail({
      to: row.destination,
      ...buildCallerVerificationTemplate({ partnerName: row.partnerName, technicianLabel: row.technicianLabel, requestLabel: row.requestLabel, url }),
      purpose: 'security.caller_verification_link',
      partnerId: row.partnerId,
      partnerName: row.partnerName,
    });
    return null;
  } catch (err) {
    // Provider errors can echo the request; log the error class only.
    console.error('[callerVerification] link delivery failed', { verificationId: row.id, method: row.method, error: errorName(err) });
    return failed;
  }
}

export async function deliverLink(verificationId: string): Promise<void> {
  return runOutsideDbContext(async () => {
    const row = await withSystemDbAccessContext(() => loadLinkDelivery(verificationId), 'callerVerification.link.load');
    if (!row) return;
    const reason = await send(row);
    if (reason) {
      // Opens its own short system transaction (no ambient context here).
      await applyDecision({ verificationId: row.id, decision: { kind: 'undeliverable', reason } });
      return;
    }
    // The send happened: stamp the "sent" marker BEFORE the audit write so a
    // later failure can never cause the same message to be sent again. A
    // failed stamp is reported, not thrown — the publisher stamps the row
    // itself right after this returns.
    try {
      await withSystemDbAccessContext(
        () => db.update(v).set({ deliveryPublishedAt: new Date() }).where(eq(v.id, row.id)),
        'callerVerification.link.mark',
      );
    } catch (err) {
      console.error('[callerVerification] link sent but delivery mark failed', { verificationId: row.id, error: errorName(err) });
      captureException(err instanceof Error ? err : new Error(errorName(err)), undefined, { verificationId: row.id, code: 'link_mark_failed' });
    }
    // Audit is best-effort after the fact: the delivery already happened, so a
    // failure here is logged + tagged and never thrown (a throw would make the
    // publisher re-send).
    try {
      await withSystemDbAccessContext(async () => {
        const [current] = await db.select().from(v).where(eq(v.id, row.id)).limit(1);
        if (current) await recordEffect(current, 'link_sent');
      }, 'callerVerification.link.audit');
    } catch (err) {
      console.error('[callerVerification] link sent but link_sent audit failed', { verificationId: row.id, error: errorName(err) });
      captureException(err instanceof Error ? err : new Error(errorName(err)), undefined, { verificationId: row.id, code: 'link_sent_audit_failed' });
    }
  });
}
