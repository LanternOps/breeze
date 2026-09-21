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
 * Ingest-level LOOP/BOUNCE suppression (distinct from autoresponse suppression).
 * Returns a reason when this message must NOT create or append to a ticket at
 * all — because it is a mail loop or a bounce, not a support request — or null
 * when it should flow through normally.
 *
 * Deliberately NARROW. Legitimate automated senders that MSPs want as tickets
 * (copiers, monitoring, backup-failure reports) arrive as `Auto-Submitted:
 * auto-generated` from `no-reply@` addresses and OFTEN set
 * `X-Auto-Response-Suppress: All` (it means "do not auto-REPLY to me", not "I am
 * a loop"). A genuine request can also arrive via a customer distribution list
 * (`List-Id`). Suppressing on those would silently drop real support mail, so
 * they are NOT ticket-suppression signals here — they only ever gate our own
 * auto-REPLY. Only three unambiguous loop/bounce signals suppress creation:
 *
 *   - Auto-Submitted: auto-replied — an automatic REPLY to our mail (RFC 3834).
 *     `auto-generated` (a device notification) is explicitly NOT suppressed.
 *   - a null Return-Path (exactly `<>`) — a bounce / non-delivery report.
 *   - X-Loop present — the sender is explicitly guarding against a mail loop.
 *
 * The broader set (Precedence: bulk, system local-parts, self-domain) stays in
 * `autoresponseSuppressionReason`: it only withholds our auto-REPLY, while still
 * letting the mail become a ticket — correct for device/notification senders.
 */
/**
 * The Auto-Submitted keyword (RFC 3834 §5.1), lowercased, or null. Strips leading
 * CFWS — whitespace and parenthesized comments, iterated to handle a leading
 * comment before the keyword and simple nesting — then returns the keyword as a
 * whole token, delimited by whitespace, `;` (parameters) or `(` (a trailing
 * comment). Compared EXACTLY by the caller, so `auto-replied2`/`auto-replied.x`
 * are their own tokens and do not match the `auto-replied` keyword.
 */
function autoSubmittedKeyword(raw: string | undefined): string | null {
  if (!raw) return null;
  let v = raw.toLowerCase();
  // Strip leading whitespace and comments until neither remains. The comment
  // pattern consumes one level of nesting; iterating handles a few more.
  for (let prev = ''; v !== prev; ) {
    prev = v;
    v = v.replace(/^\s+/, '').replace(/^\((?:[^()]|\([^()]*\))*\)/, '');
  }
  const token = v.match(/^[^\s;(]+/)?.[0];
  return token && token.length > 0 ? token : null;
}

export function ticketCreationLoopReason(n: NormalizedInboundEmail): string | null {
  // RFC 3834 §5.1: the keyword may be preceded by CFWS (leading whitespace and
  // parenthesized comments, e.g. `(vacation) auto-replied`) and followed by
  // optional `; params` or trailing CFWS. Strip leading comments/whitespace, then
  // take the whole keyword token up to the first delimiter (space, `;`, `(`) and
  // compare it EXACTLY — so `auto-replied (vacation)`, `(a (nested)) auto-replied`
  // and `auto-replied; x=y` all match, while `auto-replied2` / `auto-replied.foo`
  // do NOT (they are different tokens, not the `auto-replied` keyword).
  const autoSubmitted = autoSubmittedKeyword(n.autoSubmitted);
  if (autoSubmitted === 'auto-replied') return 'auto-replied';

  // A true null return path is EXACTLY `<>` (optionally whitespace) — an empty
  // envelope sender, i.e. a bounce. Absent (undefined) is not a null path (many
  // legit messages omit Return-Path at the API boundary), and an empty string is
  // NOT treated as `<>` — providers surface a real bounce as the literal `<>`,
  // and treating `''` as a bounce risks a false positive on a stripped header.
  if (n.returnPath != null && n.returnPath.trim() === '<>') return 'null-return-path';

  if (n.xLoop && n.xLoop.trim() !== '') return 'x-loop';

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
