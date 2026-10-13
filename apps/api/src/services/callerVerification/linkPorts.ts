/**
 * SMS/email ("link tier") adapters for the W01 ports (#6354 W03).
 *
 *  - `linkAvailable`  a sender is configured AND the deployment's web origin
 *                     can build an HTTPS link.
 *  - `prepareLink`    inside W01 `start`'s transaction: seal the exact token
 *                     whose digest the row stores, and fix the on-screen
 *                     choice order. Never sends.
 *  - `deliverIfLink`  post-commit (publisher): hand an sms/email row to the
 *                     deliverer; returns false for any other method so the
 *                     workstation adapter (W02) stays separate.
 *
 * The deliverer is imported dynamically: service → ports → linkPorts →
 * deliverer → service would otherwise be an initialization cycle.
 */
import { eq } from 'drizzle-orm';
import { db, assertInTransaction, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { callerVerifications as v } from '../../db/schema/callerVerification';
import { getTwilioService } from '../twilio';
import { getEmailService } from '../email';
import type { VerificationRow } from './types';
import { hashLinkToken, linkUrl, sealLinkToken, storedChoices } from './linkChallenge';

const PROBE_TOKEN = 'A'.repeat(43);

let originWarned = false;

/** Test-only: re-arm the once-per-process misconfiguration log. */
export function __resetLinkOriginWarningForTests(): void {
  originWarned = false;
}

function appOriginUsable(): boolean {
  try {
    linkUrl(PROBE_TOKEN);
    return true;
  } catch {
    // Without this line an operator only sees SMS/email "method disabled".
    if (!originWarned) {
      originWarned = true;
      console.error('[callerVerification] PUBLIC_WEB_URL / PUBLIC_APP_URL is unset or not a bare https:// origin; '
        + 'the SMS/email link tier is disabled until it is fixed.');
    }
    return false;
  }
}

export function linkAvailable(method: 'sms' | 'email'): boolean {
  if (!appOriginUsable()) return false;
  if (method === 'email') return getEmailService() !== null;
  return !!getTwilioService('messaging')?.hasMessagingConfiguration();
}

export async function prepareLink(row: VerificationRow, token: string | null): Promise<void> {
  assertInTransaction('callerVerification.prepareLink');
  if (!token || !row.challengeTokenHash || hashLinkToken(token) !== row.challengeTokenHash) throw new Error('link_token_mismatch');
  await db.update(v).set({
    sealedLinkToken: sealLinkToken(row.id, token),
    challengeChoices: storedChoices(row.id, row.matchValue, row.decoyValues),
  }).where(eq(v.id, row.id));
}

export async function deliverIfLink(id: string): Promise<boolean> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db.select({ method: v.method }).from(v).where(eq(v.id, id)).limit(1),
    'callerVerification.link.method',
  ));
  if (row?.method !== 'sms' && row?.method !== 'email') return false;
  const { deliverLink } = await import('./deliverers/link');
  await deliverLink(id);
  return true;
}
