import type { GraphMessage } from './graphMailClient';
import type { NormalizedInboundEmail } from '../inboundEmail/types';
import { BREEZE_OUTBOUND_HEADER } from '../emailDomains/outboundMarker';
import { htmlToText } from '../inboundEmail/htmlToText';
import { buildSenderAuth } from '../inboundEmail/authenticationResults';
import { MAX_BODY_BYTES } from './normalizeGmailMessage';

function header(headers: GraphMessage['internetMessageHeaders'], name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}



/**
 * Return the value of the Authentication-Results header we can TRUST, or '' if none.
 *
 * Graph's `internetMessageHeaders` returns the full header set, which can include an
 * `Authentication-Results` line a malicious sender put into their OWN message
 * (e.g. `Authentication-Results: anything; dmarc=pass`). Exchange Online stamps a
 * GENUINE header whose authserv-id is the receiving (accepted) domain. So — mirroring
 * the mailgun normalizer's authserv-id check — trust ONLY a header whose authserv-id
 * matches the support mailbox's own domain; ignore foreign/absent authserv-id headers.
 * Unmatched → '' → all verdicts 'unknown' → verified=false → the R4 gate quarantines
 * (never drops) for manual review. NOTE: if a tenant's EOP stamps a different
 * authserv-id than the mailbox domain, genuine mail will quarantine until this is
 * tuned — safe because nothing is lost.
 */
function trustedAuthResults(
  headers: GraphMessage['internetMessageHeaders'], mailboxDomain: string,
): string {
  if (!mailboxDomain) return '';
  for (const h of headers ?? []) {
    if (h.name.toLowerCase() !== 'authentication-results') continue;
    const authservId = (h.value.split(';')[0] ?? '').trim().split(/\s+/)[0]?.toLowerCase();
    if (authservId === mailboxDomain) return h.value;
  }
  return '';
}



/** jsonb cannot store U+0000; drop it from strings persisted in `raw`. */
function stripNul(value: string): string {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
}

/**
 * Bound the body persisted in `raw` to MAX_BODY_BYTES of UTF-8, the same 1 MiB
 * limit the Gmail normalizer applies, so an oversized message cannot write an
 * unbounded row into ticket_email_inbound. A code point cut at the boundary is
 * dropped rather than stored as a replacement character.
 */
function capBodyBytes(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_BODY_BYTES) return value;
  return Buffer.from(value, 'utf8').subarray(0, MAX_BODY_BYTES).toString('utf8').replace(/\uFFFD$/, '');
}

/** Pure mapping: Graph message -> the pipeline's NormalizedInboundEmail. */
export function normalizeGraphMessage(
  msg: GraphMessage,
  partnerId: string,
  mailboxAddress: string,
): NormalizedInboundEmail {
  const fromAddr = msg.from?.emailAddress?.address?.trim().toLowerCase() ?? '';
  const mailboxDomain = mailboxAddress.split('@')[1]?.trim().toLowerCase() ?? '';
  const references = header(msg.internetMessageHeaders, 'References')?.trim().split(/\s+/).filter(Boolean);
  const contentType = msg.body?.contentType?.toLowerCase();
  const html = contentType === 'html' ? msg.body?.content : undefined;
  // The pipeline only reads `text` (ticket description / inbound comment), so an
  // HTML body must be converted in full — `bodyPreview` is Graph's ~255-char
  // excerpt and is only a fallback when the HTML carries no visible text (#6687).
  const text = contentType === 'text'
    ? (msg.body?.content ?? '')
    : (html ? htmlToText(html) : '') || (msg.bodyPreview ?? '');

  return {
    provider: 'm365',
    providerMessageId: msg.id,
    resolvedPartnerId: partnerId,
    to: mailboxAddress.trim().toLowerCase(),
    from: fromAddr,
    fromName: msg.from?.emailAddress?.name,
    subject: msg.subject ?? '',
    text,
    html,
    messageId: msg.internetMessageId,
    inReplyTo: header(msg.internetMessageHeaders, 'In-Reply-To'),
    references,
    autoSubmitted: header(msg.internetMessageHeaders, 'Auto-Submitted'),
    precedence: header(msg.internetMessageHeaders, 'Precedence'),
    outboundMarker: header(msg.internetMessageHeaders, BREEZE_OUTBOUND_HEADER),
    // Loop/bounce signals (ingest-level loop suppression).
    returnPath: header(msg.internetMessageHeaders, 'Return-Path'),
    xLoop: header(msg.internetMessageHeaders, 'X-Loop'),
    senderAuth: buildSenderAuth(trustedAuthResults(msg.internetMessageHeaders, mailboxDomain)),
    // Metadata only across the queue — attachment bytes never go into Redis. The
    // inbound worker fetches them from Graph before processing when this is set
    // (services/ticketMailbox/fetchInboundAttachments.ts, #6688).
    attachments: [],
    hasAttachments: msg.hasAttachments === true,
    raw: {
      ccRecipients: msg.ccRecipients ?? [],
      graphConversationId: msg.conversationId,
      receivedDateTime: msg.receivedDateTime,
      // Persist the normalized body + sender name under the same neutral keys the
      // Gmail normalizer writes. ticket_email_inbound has no body column, and the
      // review queue's "convert to ticket" rebuilds the description and submitter
      // name from `raw` (convertEmailInbound). Without them a quarantined Microsoft
      // 365 message converted to a ticket with only its subject (#8299). U+0000 is
      // removed because Postgres jsonb rejects it, which would turn a quarantine
      // into a failed insert. The stored body is capped at 1 MiB like Gmail's.
      bodyText: capBodyBytes(stripNul(text)),
      fromName: msg.from?.emailAddress?.name ? stripNul(msg.from.emailAddress.name) : null,
    },
  };
}
