import { eq, sql } from 'drizzle-orm';
import { db, withDbTransactionIfHeld } from '../../db';
import { partnerInboundDomains, partners, ticketMailboxConnections } from '../../db/schema';
import { getConfig } from '../../config/validate';
import { captureException } from '../sentry';
import { partnerInboundAddress } from './outboundThreading';
import type { NormalizedInboundEmail } from './types';

function inboundDomainOrNull(): string | null {
  try {
    return getConfig().TICKETS_INBOUND_DOMAIN?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The Reply-To ingest may store for `n` (email-first replies W1, Refs #8758), or
 * undefined. The normalizer already reduced it to exactly one valid address that
 * is not the mailbox the message arrived at (replyTo.ts). This is the loop guard
 * that needs the partner: an address that is one of our own would have the
 * ticket's customer mail delivered back into a ticket inbox. Dropped:
 *  - the message's own recipient or sender (the fallback is From anyway),
 *  - any address on the platform inbound domain (every partner's slug address),
 *  - the partner's configured inbound address (self-hosted override),
 *  - any address on a partner inbound domain,
 *  - any connected mailbox's address, of any partner.
 *
 * Runs inside processInboundEmail's work transaction, so the reads sit in a
 * savepoint and any failure fails closed to "no Reply-To" (the reply goes to
 * From, today's behaviour) instead of rolling back the ticket.
 */
export async function guardedReplyTo(n: NormalizedInboundEmail, partnerId: string): Promise<string | undefined> {
  const replyTo = n.replyTo?.trim().toLowerCase();
  if (!replyTo) return undefined;
  if (replyTo === n.to.trim().toLowerCase() || replyTo === n.from.trim().toLowerCase()) return undefined;
  const domain = replyTo.slice(replyTo.lastIndexOf('@') + 1);
  const inboundDomain = inboundDomainOrNull();
  if (inboundDomain && domain === inboundDomain) return undefined;

  try {
    const own = await withDbTransactionIfHeld(async () => {
      const partnerRows = await db
        .select({ slug: partners.slug, inboundLocalPart: partners.inboundLocalPart, settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, partnerId))
        .limit(1);
      const partner = partnerRows[0];
      if (partner?.slug) {
        const settings = partner.settings as { ticketing?: { inbound?: { address?: string } } } | null;
        const address = partnerInboundAddress(partner.inboundLocalPart ?? partner.slug, settings?.ticketing?.inbound?.address);
        if (address?.trim().toLowerCase() === replyTo) return true;
      }
      const inboundDomainRows = await db
        .select({ domain: partnerInboundDomains.domain })
        .from(partnerInboundDomains)
        .where(sql`lower(${partnerInboundDomains.domain}) = ${domain}`)
        .limit(1);
      if (inboundDomainRows.length > 0) return true;
      const mailboxRows = await db
        .select({ id: ticketMailboxConnections.id })
        .from(ticketMailboxConnections)
        .where(sql`lower(${ticketMailboxConnections.mailboxAddress}) = ${replyTo}`)
        .limit(1);
      return mailboxRows.length > 0;
    });
    return own ? undefined : replyTo;
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
}
