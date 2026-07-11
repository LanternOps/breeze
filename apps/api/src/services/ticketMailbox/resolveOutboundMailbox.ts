import { and, desc, eq } from 'drizzle-orm';
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

export async function resolveOutboundMailbox(
  ticketId: string,
  partnerId: string | null
): Promise<OutboundMailbox | null> {
  if (!partnerId) return null;

  const conn = await db.select({
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
    )).limit(1);

  const connectedMailbox = conn[0];
  if (!connectedMailbox?.tenantId) return null;

  const inbound = await db.select({ providerMessageId: ticketEmailInbound.providerMessageId })
    .from(ticketEmailInbound)
    .where(and(
      eq(ticketEmailInbound.ticketId, ticketId),
      eq(ticketEmailInbound.provider, 'm365'),
    ))
    .orderBy(desc(ticketEmailInbound.createdAt))
    .limit(1);

  return {
    tenantId: connectedMailbox.tenantId,
    mailbox: connectedMailbox.mailboxAddress,
    originalMessageId: inbound[0]?.providerMessageId ?? null,
  };
}
