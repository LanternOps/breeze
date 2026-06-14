import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';
import { getConfig } from '../../config/validate';
import { getRedis } from '../redis';
import { rateLimiter } from '../rate-limit';
import { emitTicketEvent } from '../ticketEvents';
import { captureException } from '../sentry';
import { autoresponseSuppressionReason } from './loopPrevention';
import type { NormalizedInboundEmail } from './types';

interface AutoresponseTicket {
  id: string;
  orgId: string;
  partnerId: string | null;
  internalNumber: string | null;
  subject: string;
}

const AUTORESPONSE_CAP_LIMIT = 1;
const AUTORESPONSE_CAP_WINDOW_SECONDS = 24 * 60 * 60; // 1 per sender per 24h

// Resolve TICKETS_INBOUND_DOMAIN defensively — mirrors inboundEmailService's
// inboundDomainOrNull(). `getConfig()` THROWS when config isn't initialized (e.g.
// the integration harness never calls validateConfig()), and a config read must
// NEVER poison ingestion: the autoresponder runs INSIDE processInboundEmail's work
// transaction, so a throw here would roll back ticket creation. Degrade to undefined
// (self-domain rule skipped) instead. A separate local copy (not an import from
// inboundEmailService) avoids a circular import — that module imports this one.
function inboundDomainOrUndefined(): string | undefined {
  try {
    return getConfig().TICKETS_INBOUND_DOMAIN;
  } catch {
    return undefined;
  }
}

async function autoresponderEnabled(partnerId: string): Promise<boolean> {
  const rows = await db.select({ settings: partners.settings })
    .from(partners).where(eq(partners.id, partnerId)).limit(1);
  const settings = rows[0]?.settings as
    | { ticketing?: { inbound?: { autoresponderEnabled?: boolean } } }
    | undefined;
  // Default ON when unset (spec §2 config default).
  return settings?.ticketing?.inbound?.autoresponderEnabled !== false;
}

// Per-sender sliding-window cap, best-effort. The cap check runs INSIDE
// processInboundEmail's system-context transaction (the autoresponder is called
// from createFromEmail). `rateLimiter` already fails CLOSED (denies) when Redis
// is null and swallows its own Redis errors — but we additionally wrap the whole
// call so that ANY unexpected throw (e.g. getRedis() itself blowing up) SUPPRESSES
// the autoresponse rather than propagating into — and rolling back — the work
// transaction. An autoresponse is best-effort; losing one must never undo ticket
// creation. Returns true to PROCEED, false to SUPPRESS.
async function capAllows(senderEmail: string): Promise<boolean> {
  try {
    const cap = await rateLimiter(
      getRedis(),
      `autoresponse:${senderEmail}`,
      AUTORESPONSE_CAP_LIMIT,
      AUTORESPONSE_CAP_WINDOW_SECONDS,
    );
    return cap.allowed;
  } catch (err) {
    // Fail CLOSED to no-autoresponse (suppress) on Redis error — never propagate
    // into the work tx. Capture for visibility, then deny.
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

/**
 * One-time acknowledgement gate (spec §5). Emits a `ticket.autoresponse` event
 * (handled by ticketNotifyWorker) only when ALL hold:
 *   - the ticket belongs to the resolved partner (spec §6 re-assertion),
 *   - the partner has autoresponder enabled (default true),
 *   - no loop-prevention rule fires (Auto-Submitted/Precedence/system-sender/self-domain),
 *   - the per-sender Redis cap (1 / 24h) has room.
 * Called ONLY on the created-for-known-sender path — never for quarantined,
 * ignored, or closed-continuation mail (spec §5: never autorespond to unknown).
 */
export async function maybeSendAutoresponse(
  n: NormalizedInboundEmail,
  partnerId: string,
  ticket: AutoresponseTicket,
): Promise<void> {
  // Spec §6: under system context there is no RLS net — re-assert the invariant
  // in app code. A mismatch is a wiring bug; fail loud, never autorespond across tenants.
  if (ticket.partnerId !== partnerId) {
    throw new Error(`partner mismatch — refusing autoresponse (ticket ${ticket.id} partnerId=${ticket.partnerId} resolved=${partnerId})`);
  }

  const reason = autoresponseSuppressionReason(n, inboundDomainOrUndefined());
  if (reason) {
    console.info('[InboundEmail] autoresponse suppressed', { reason, from: n.from, ticketId: ticket.id });
    return;
  }
  if (!(await autoresponderEnabled(partnerId))) {
    console.info('[InboundEmail] autoresponse suppressed', { reason: 'disabled', from: n.from, ticketId: ticket.id });
    return;
  }

  if (!(await capAllows(n.from))) {
    console.info('[InboundEmail] autoresponse suppressed', { reason: 'rate-capped', from: n.from, ticketId: ticket.id });
    return;
  }

  await emitTicketEvent({
    type: 'ticket.autoresponse',
    ticketId: ticket.id,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId,
    payload: {
      to: n.from,
      internalNumber: ticket.internalNumber,
      subject: ticket.subject,
    },
  });
}
