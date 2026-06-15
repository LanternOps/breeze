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
