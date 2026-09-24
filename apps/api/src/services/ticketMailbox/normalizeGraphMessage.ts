import type { GraphMessage } from './graphMailClient';
import type { NormalizedInboundEmail } from '../inboundEmail/types';
import { BREEZE_OUTBOUND_HEADER } from '../emailDomains/outboundMarker';
import { htmlToText } from '../inboundEmail/htmlToText';
import { buildSenderAuth } from '../inboundEmail/authenticationResults';

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
    },
  };
}
