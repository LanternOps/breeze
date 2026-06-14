import { getConfig } from '../../config/validate';

function domain(): string | undefined {
  return getConfig().TICKETS_INBOUND_DOMAIN;
}

/** The conversation thread anchor — stored as tickets.email_thread_key and used
 *  as In-Reply-To/References on every outbound message for the ticket. */
export function ticketThreadAnchor(ticketId: string): string | null {
  const d = domain();
  return d ? `<ticket-${ticketId}@${d}>` : null;
}

/** Deterministic Message-ID for one outbound comment reply. */
export function commentMessageId(ticketId: string, commentId: string): string | null {
  const d = domain();
  return d ? `<ticket-${ticketId}-${commentId}@${d}>` : null;
}

/**
 * The partner's inbound (Reply-To) address. Spec §2: the address is a derived
 * default ({slug}@TICKETS_INBOUND_DOMAIN), OVERRIDABLE for self-hosted via
 * partners.settings.ticketing.inbound.address. The override wins (and is used
 * even when no platform domain is configured); a blank/whitespace override is
 * ignored. Must match what PR1's resolvePartnerByRecipient accepts as inbound.
 */
export function partnerInboundAddress(
  partnerSlug: string,
  configuredOverride: string | undefined,
): string | null {
  const override = configuredOverride?.trim();
  if (override) return override;
  const d = domain();
  return d ? `${partnerSlug}@${d}` : null;
}

/** Threading header set. With a commentId → a reply (In-Reply-To/References =
 *  anchor); without → the autoresponse (Message-ID = anchor, no In-Reply-To). */
export function buildThreadingHeaders(args: { ticketId: string; commentId?: string }): Record<string, string> {
  const anchor = ticketThreadAnchor(args.ticketId);
  if (!anchor) return {};
  if (!args.commentId) {
    return { 'Message-ID': anchor };
  }
  const mid = commentMessageId(args.ticketId, args.commentId);
  return {
    'Message-ID': mid ?? anchor,
    'In-Reply-To': anchor,
    References: anchor,
  };
}
