import { getConfig } from '../../config/validate';

// Resolve TICKETS_INBOUND_DOMAIN defensively. These helpers run on the notify-worker
// path (handleTicketEvent) where an uninitialized config would make getConfig() throw
// — and a config read must never crash threading. Degrade to undefined (threading off:
// no headers, null Reply-To) instead, mirroring inboundEmailService's
// inboundDomainOrNull / autoresponder's inboundDomainOrUndefined.
function domain(): string | undefined {
  try {
    return getConfig().TICKETS_INBOUND_DOMAIN;
  } catch {
    return undefined;
  }
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
 * The partner's inbound (Reply-To) address. The address is a derived default
 * ({localPart}@TICKETS_INBOUND_DOMAIN, where localPart is the partner's
 * inbound_local_part or, when unset, its slug), OVERRIDABLE for self-hosted via
 * partners.settings.ticketing.inbound.address. The override wins (even with no
 * platform domain configured); a blank/whitespace override is ignored.
 *
 * NOTE: the override is emitted VERBATIM as Reply-To — the resolver does NOT
 * validate it. For inbound replies to thread back, the operator MUST register
 * the override's domain in `partner_inbound_domains` (or use the derived
 * {localPart}@TICKETS_INBOUND_DOMAIN form). Replies sent to an UNregistered
 * override domain resolve to no partner and are dropped as `ignored`. This is
 * an operator constraint, not a code invariant enforced here.
 */
export function partnerInboundAddress(
  localPart: string,
  configuredOverride: string | undefined,
): string | null {
  const override = configuredOverride?.trim();
  if (override) return override;
  const d = domain();
  return d ? `${localPart}@${d}` : null;
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
