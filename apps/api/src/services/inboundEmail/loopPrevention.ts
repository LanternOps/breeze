import type { NormalizedInboundEmail } from './types';

const SYSTEM_LOCALPARTS = ['no-reply', 'noreply', 'mailer-daemon', 'postmaster'];
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

/**
 * Synchronous loop-prevention rules (spec §5). Returns a reason string when an
 * autoresponse MUST be suppressed for this inbound mail, or null when it's safe
 * to autorespond. The Redis per-sender rate cap is applied separately (Task 6).
 *
 * @param inboundDomain TICKETS_INBOUND_DOMAIN (undefined when unconfigured)
 */
export function autoresponseSuppressionReason(
  n: NormalizedInboundEmail,
  inboundDomain: string | undefined,
): string | null {
  // (1) Auto-Submitted header present and not "no"
  if (n.autoSubmitted && n.autoSubmitted.trim().toLowerCase() !== 'no') {
    return 'auto-submitted';
  }
  // (2) Precedence: bulk / list / junk
  if (n.precedence && BULK_PRECEDENCE.has(n.precedence.trim().toLowerCase())) {
    return 'precedence';
  }
  const from = (n.from || '').trim().toLowerCase();
  const at = from.indexOf('@');
  const localPart = at >= 0 ? from.slice(0, at) : from;
  const senderDomain = at >= 0 ? from.slice(at + 1) : '';
  // (3) system local-parts (no-reply, mailer-daemon, postmaster, …)
  if (SYSTEM_LOCALPARTS.includes(localPart)) {
    return 'system-sender';
  }
  // (4) self-loop backstop: sender on our own inbound domain (PR3 autoresponse-time
  //     guard; PR1 also drops these at ingest — see "Self-loop boundary").
  if (inboundDomain && senderDomain === inboundDomain.trim().toLowerCase()) {
    return 'self-domain';
  }
  return null;
}

/**
 * The Message-ID shapes `outboundThreading.ts` generates, as a matcher.
 *
 * Generator (services/inboundEmail/outboundThreading.ts):
 *   ticketThreadAnchor(ticketId)          -> `<ticket-${ticketId}@${domain}>`
 *   commentMessageId(ticketId, commentId) -> `<ticket-${ticketId}-${commentId}@${domain}>`
 *
 * Both are `<ticket-` + an id run containing no `@`, `<`, `>` or whitespace,
 * then `@` + TICKETS_INBOUND_DOMAIN + `>`. The domain is regex-escaped, so its
 * dots are literal and `ticketsXexampleXcom` does not match.
 *
 * Only the message's OWN Message-ID is tested. In-Reply-To and References are
 * deliberately NOT: every genuine customer reply carries our anchor there, and
 * matching on them would drop exactly the mail this pipeline exists to receive.
 */
export function outboundMessageIdPattern(inboundDomain: string): RegExp {
  const domain = inboundDomain.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^<ticket-[^@<>\\s]+@${domain}>$`, 'i');
}

/**
 * Is this inbound message our OWN outbound mail, looping back? (spec §8.5)
 *
 * Two signals, both about the MESSAGE:
 *   - it carries X-Breeze-Outbound (every partner-lane message does);
 *   - its own Message-ID was minted by outboundThreading.ts.
 *
 * Forging the header only gets the forger's own mail ignored, so trusting it
 * from untrusted inbound is safe.
 *
 * What is deliberately NOT a signal: the SENDING DOMAIN or the identity
 * address. With a root sending domain every technician's address is on it, and
 * a technician may legitimately write in from the shared mailbox — suppressing
 * by domain would drop their mail. The existing sender-domain rule inside
 * `autoresponseSuppressionReason` stays scoped to TICKETS_INBOUND_DOMAIN, which
 * is ours and nobody else's.
 *
 * With no inbound domain configured (self-hosted without inbound email) the
 * Message-ID rule is inert — there is no anchor to have generated — but the
 * marker still applies.
 */
export function ownOutboundReason(
  n: NormalizedInboundEmail,
  inboundDomain: string | null | undefined,
): 'outbound-marker' | 'own-message-id' | null {
  if (n.outboundMarker && n.outboundMarker.trim() !== '') return 'outbound-marker';
  const domain = inboundDomain?.trim();
  if (!domain) return null;
  const messageId = n.messageId?.trim();
  if (messageId && outboundMessageIdPattern(domain).test(messageId)) return 'own-message-id';
  return null;
}
