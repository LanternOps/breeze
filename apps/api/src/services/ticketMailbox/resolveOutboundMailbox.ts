import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { ticketEmailInbound } from '../../db/schema/emailInbound';
import {
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
} from '../../db/schema/ticketMailbox';

export interface OutboundMailbox {
  tenantId: string;
  mailbox: string;
  originalMessageId: string | null;
}

// More connected mailboxes than this is not a real partner; the cap only
// bounds the read.
const MAX_CONNECTIONS = 50;

// Partners already told (once per process) that a ticket with no inbound
// message was sent from the oldest of several mailboxes.
const warnedMultiMailbox = new Set<string>();

/**
 * The connected Microsoft 365 mailbox customer mail for this ticket leaves
 * from, and the message to thread on (email-first replies W1, Refs #8758).
 *
 * Never pairs a mailbox with a message that lives in another mailbox:
 *  (a) the ticket's newest m365 inbound row names the mailbox that received it
 *      (`to_address`, set to the connection's mailbox_address at ingest). Reply
 *      from that mailbox, threaded on that row's message;
 *  (b) no m365 inbound row (portal, technician, alert or API ticket): the only
 *      connected mailbox, or with several the oldest (`created_at, id`), as new
 *      mail with no thread;
 *  (c) the receiving mailbox is no longer connected: null, so the mail goes on
 *      the platform/partner lane rather than from a mailbox the customer did
 *      not write to.
 * Connections are read only through the tenant-ownership inner join, which a
 * Gmail connection never has (decision 9).
 */
export async function resolveOutboundMailbox(
  ticketId: string,
  partnerId: string | null
): Promise<OutboundMailbox | null> {
  if (!partnerId) return null;

  const connections = await db.select({
    tenantId: ticketMailboxConnections.tenantId,
    mailboxAddress: ticketMailboxConnections.mailboxAddress,
  }).from(ticketMailboxConnections)
    .innerJoin(
      ticketMailboxTenantOwnerships,
      and(
        eq(ticketMailboxTenantOwnerships.tenantId, ticketMailboxConnections.tenantId),
        eq(ticketMailboxTenantOwnerships.partnerId, ticketMailboxConnections.partnerId),
      ),
    )
    .where(and(
      eq(ticketMailboxConnections.partnerId, partnerId),
      eq(ticketMailboxConnections.status, 'connected'),
    ))
    .orderBy(asc(ticketMailboxConnections.createdAt), asc(ticketMailboxConnections.id))
    .limit(MAX_CONNECTIONS);

  const usable = connections.filter((c): c is { tenantId: string; mailboxAddress: string } => !!c.tenantId);
  if (usable.length === 0) return null;

  const inbound = await db.select({
    providerMessageId: ticketEmailInbound.providerMessageId,
    toAddress: ticketEmailInbound.toAddress,
  })
    .from(ticketEmailInbound)
    .where(and(
      eq(ticketEmailInbound.ticketId, ticketId),
      eq(ticketEmailInbound.partnerId, partnerId),
      eq(ticketEmailInbound.provider, 'm365'),
    ))
    .orderBy(desc(ticketEmailInbound.createdAt), desc(ticketEmailInbound.id))
    .limit(1);

  const latest = inbound[0];
  if (latest) {
    const receivedAt = latest.toAddress?.trim().toLowerCase();
    if (!receivedAt) return null;
    const receiving = usable.find((c) => c.mailboxAddress.trim().toLowerCase() === receivedAt);
    if (!receiving) return null;
    return { tenantId: receiving.tenantId, mailbox: receiving.mailboxAddress, originalMessageId: latest.providerMessageId };
  }

  if (usable.length > 1 && !warnedMultiMailbox.has(partnerId)) {
    warnedMultiMailbox.add(partnerId);
    console.warn(
      `[resolveOutboundMailbox] ${usable.length} connected mailboxes and no inbound message on the ticket; `
      + `sending from the oldest connection (partner ${partnerId})`,
    );
  }
  const oldest = usable[0]!;
  return { tenantId: oldest.tenantId, mailbox: oldest.mailboxAddress, originalMessageId: null };
}
