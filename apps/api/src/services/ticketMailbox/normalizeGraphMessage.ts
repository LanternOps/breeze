import type { GraphMessage } from './graphMailClient';
import type { NormalizedInboundEmail, SenderAuth } from '../inboundEmail/types';
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
 * tuned — safe because nothing is lost. Mail sent from inside the tenant is the
 * common case of this (authserv-id `mx.microsoft.com`, dmarc=none); graphSenderAuth
 * verifies it from Exchange's intra-tenant stamp instead (#8299).
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


/**
 * True only when the tenant's own Exchange says this message was sent from inside
 * the tenant: `X-MS-Exchange-Organization-AuthAs: Internal` AND
 * `X-MS-Exchange-Organization-MessageDirectionality: Originating` (#8299).
 *
 * Why this cannot be spoofed: per Microsoft's Exchange "header firewall"
 * documentation, Exchange removes every `X-MS-Exchange-Organization-*` header from
 * mail entering the organization from outside, then stamps its own. External mail
 * arrives as AuthAs=Anonymous / MessageDirectionality=Incoming; the intra-tenant
 * shape was observed on real tenant mail read through Graph (#8299). The `X-MS-Exchange-CrossTenant-*` headers are
 * deliberately NOT read: they describe the SENDING tenant, so another Microsoft
 * 365 tenant's mail can carry `CrossTenant-AuthAs: Internal`.
 *
 * Strict by design: both headers must be present, every instance of each must
 * equal the exact value Exchange writes (case-sensitive, after trimming
 * surrounding whitespace), and a duplicate with any other value fails the check. This is read only on the Microsoft 365 mailbox path, where
 * Graph returns the headers as the mailbox's own tenant stored them; the Gmail
 * and Mailgun normalizers never look at these headers.
 */
function isExchangeIntraTenant(headers: GraphMessage['internetMessageHeaders']): boolean {
  const allEqual = (name: string, expected: string): boolean => {
    const values = (headers ?? [])
      .filter((h) => h.name.toLowerCase() === name)
      .map((h) => h.value.trim());
    return values.length > 0 && values.every((v) => v === expected);
  };
  return allEqual('x-ms-exchange-organization-authas', 'Internal')
    && allEqual('x-ms-exchange-organization-messagedirectionality', 'Originating');
}

/**
 * Sender auth for a Microsoft 365 mailbox message. A trusted DMARC verdict wins in
 * both directions: a pass needs nothing more, and a fail is never overridden. When
 * there is no usable verdict (intra-tenant mail is unsigned, and EOP stamps
 * `mx.microsoft.com` rather than the mailbox domain, so trustedAuthResults is
 * empty), Exchange's intra-tenant stamp verifies the sender instead, so the R4
 * gate in inboundEmailService passes for the tenant's own staff without trusting
 * the From domain or the customer-domain list.
 */
function graphSenderAuth(
  headers: GraphMessage['internetMessageHeaders'], mailboxDomain: string,
): SenderAuth {
  const auth = buildSenderAuth(trustedAuthResults(headers, mailboxDomain));
  if (auth.verified || auth.dmarc === 'fail') return auth;
  if (!isExchangeIntraTenant(headers)) return auth;
  return { ...auth, verified: true, source: 'exchange-internal' };
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

  const senderAuth = graphSenderAuth(msg.internetMessageHeaders, mailboxDomain);

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
    senderAuth,
    // Metadata only across the queue — attachment bytes never go into Redis. The
    // inbound worker fetches them from Graph before processing when this is set
    // (services/ticketMailbox/fetchInboundAttachments.ts, #6688).
    attachments: [],
    hasAttachments: msg.hasAttachments === true,
    raw: {
      ccRecipients: msg.ccRecipients ?? [],
      graphConversationId: msg.conversationId,
      receivedDateTime: msg.receivedDateTime,
      // Audit trail for mail that passed the R4 gate on Exchange's intra-tenant stamp
      // rather than DMARC (#8299); absent for every other message.
      ...(senderAuth.source ? { senderAuthSource: senderAuth.source } : {}),
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
