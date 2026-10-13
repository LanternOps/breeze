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
 *  - a failing DB write propagates so the publisher retries the row.
 *
 * At-least-once: a crash between provider acceptance and the publisher's mark
 * re-sends the SAME sealed token; a new token is never minted on retry.
 * Neither the token nor the URL is ever logged or audited.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { callerVerifications as v } from '../../../db/schema/callerVerification';
import { getTwilioService } from '../../twilio';
import { buildCallerVerificationTemplate, getEmailService } from '../../email';
import { applyDecision } from '../service';
import { recordEffect } from '../effects';
import { loadLinkDelivery, type LinkDelivery } from '../publicLookup';
import { hashLinkToken, linkUrl, openLinkToken } from '../linkChallenge';

type FailureReason = 'sms_failed' | 'email_failed';

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
    console.error('[callerVerification] link material unusable; marking undeliverable', {
      verificationId: row.id, error: err instanceof Error ? err.message : 'unknown',
    });
    return failed;
  }
  try {
    if (row.method === 'sms') {
      const twilio = getTwilioService('messaging');
      if (!twilio) {
        console.error('[callerVerification] SMS link: Twilio messaging not configured', { verificationId: row.id });
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
    await withSystemDbAccessContext(async () => {
      const [current] = await db.select().from(v).where(eq(v.id, row.id)).limit(1);
      if (current) await recordEffect(current, 'link_sent');
    }, 'callerVerification.link.audit');
  });
}
