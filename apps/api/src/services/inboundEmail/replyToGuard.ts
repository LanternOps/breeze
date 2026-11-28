import { eq, sql } from 'drizzle-orm';
import { db, withDbTransactionIfHeld } from '../../db';
import { partnerInboundDomains, partners, ticketMailboxConnections } from '../../db/schema';
import { getConfig } from '../../config/validate';
import { captureException } from '../sentry';
import { partnerInboundAddress } from './outboundThreading';
import { isSameMailbox } from './replyTo';
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
 * ticket's customer mail delivered back into a ticket inbox. "Equal to" means
 * the same mailbox: case-insensitive, and a `+tag` subaddress counts as the
 * mailbox it is delivered to (isSameMailbox). Dropped:
 *  - the message's own recipient, or its sender (the fallback is From anyway),
 *  - any address on the platform inbound domain (every partner's slug address),
 *  - the partner's configured inbound address (self-hosted override),
 *  - any address on a partner inbound domain,
 *  - any connected mailbox's address, of any partner. Only the address the
 *    mailbox was connected with is known here: its other aliases (Exchange
 *    proxy addresses, Gmail send-as aliases) are not stored, so a Reply-To
 *    naming one of those is not caught.
 *
 * Runs inside processInboundEmail's work transaction, so the reads sit in a
 * savepoint and any failure fails closed to "no Reply-To" (the reply goes to
 * From, today's behaviour) instead of rolling back the ticket.
 */
export async function guardedReplyTo(n: NormalizedInboundEmail, partnerId: string): Promise<string | undefined> {
  const replyTo = n.replyTo?.trim().toLowerCase();
  if (!replyTo) return undefined;
  if (isSameMailbox(replyTo, n.to) || replyTo === n.from.trim().toLowerCase()) return undefined;
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
        if (address && isSameMailbox(address, replyTo)) return true;
      }
      const inboundDomainRows = await db
        .select({ domain: partnerInboundDomains.domain })
        .from(partnerInboundDomains)
        .where(sql`lower(${partnerInboundDomains.domain}) = ${domain}`)
        .limit(1);
      if (inboundDomainRows.length > 0) return true;
      // Every connected mailbox on the Reply-To's domain, compared as mailboxes
      // so `support+tag@x` matches a `support@x` connection.
      const mailboxRows = await db
        .select({ mailboxAddress: ticketMailboxConnections.mailboxAddress })
        .from(ticketMailboxConnections)
        .where(sql`lower(split_part(${ticketMailboxConnections.mailboxAddress}, '@', 2)) = ${domain}`);
      return mailboxRows.some((row) => isSameMailbox(row.mailboxAddress, replyTo));
    });
    return own ? undefined : replyTo;
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined,
      { component: 'inbound_reply_to_guard', partnerId }, { fingerprint: ['inbound_reply_to_guard_failed'] });
    return undefined;
  }
}
