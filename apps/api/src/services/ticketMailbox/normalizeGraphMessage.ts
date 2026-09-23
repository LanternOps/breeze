import sanitizeHtml from 'sanitize-html';
import type { GraphMessage } from './graphMailClient';
import type { NormalizedInboundEmail, SenderAuth, SenderAuthVerdict } from '../inboundEmail/types';
import { BREEZE_OUTBOUND_HEADER } from '../emailDomains/outboundMarker';

function header(headers: GraphMessage['internetMessageHeaders'], name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

// Mirror mailgun.ts normalizeVerdict: map a raw mechanism token -> SenderAuthVerdict.
function normalizeVerdict(raw: string | undefined): SenderAuthVerdict {
  const v = raw?.trim().toLowerCase();
  if (v === 'pass') return 'pass';
  if (v === 'fail' || v === 'softfail' || v === 'permerror' || v === 'temperror') return 'fail';
  if (v === 'neutral') return 'neutral';
  if (v === 'none') return 'none';
  return 'unknown';
}

function mechanism(authResults: string | undefined, name: string): string | undefined {
  if (!authResults) return undefined;
  return new RegExp(`\\b${name}=(\\w+)`, 'i').exec(authResults)?.[1];
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

/** Always returns a full SenderAuth (fail-closed). verified iff DMARC passed. */
function buildSenderAuth(authResults: string | undefined): SenderAuth {
  const spf = normalizeVerdict(mechanism(authResults, 'spf'));
  const dkim = normalizeVerdict(mechanism(authResults, 'dkim'));
  const dmarc = normalizeVerdict(mechanism(authResults, 'dmarc'));
  return { spf, dkim, dmarc, verified: dmarc === 'pass' };
}

/**
 * Upper bound on the plain text derived from an HTML body. Matches the ticket
 * description / comment content limit enforced by the shared validators
 * (`packages/shared/src/validators/tickets.ts`, `max(50_000)`), so an enormous
 * HTML mail can't write a larger description than the API would ever accept.
 */
export const MAX_HTML_DERIVED_TEXT_LENGTH = 50_000;

/**
 * Cap on the raw HTML handed to the parser. sanitize-html is super-linear on
 * deeply nested unclosed tags (a 560K-char `<span>a` × N body took ~2.7 s), and
 * this runs inline in the shared mailbox poll worker on sender-controlled
 * input. 1M chars is ~20× the text clamp — ordinary (even Word-bloated) mail
 * is far below it; only the tail of a pathological body is lost.
 */
export const MAX_HTML_INPUT_LENGTH = 1_000_000;

// The only tags kept through sanitize-html: the ones whose boundaries carry
// layout. Everything else is dropped (its text kept); script/style/head/title
// contents are dropped entirely.
const BREAK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'table', 'pre', 'hr',
  'br', 'div', 'li', 'tr', 'td', 'th',
];
const NON_TEXT_TAGS = ['style', 'script', 'textarea', 'option', 'noscript', 'head', 'title'];
// Applied to sanitize-html OUTPUT, where every tag is bare (no attributes) and
// every literal `<` in text is escaped — so these match real tags only and
// cannot backtrack across attacker-shaped markup.
const PARAGRAPH_TAG_RE = /<\/?(?:p|h[1-6]|blockquote|ul|ol|table|pre)>|<hr ?\/?>/g;
const LINE_TAG_RE = /<br ?\/?>|<\/?(?:div|li|tr)>/g;
const CELL_TAG_RE = /<\/?t[dh]>/g;
const PARA = '\u0002';
const LINE = '\u0001';
const BREAK_RUN_RE = /[ \u0001\u0002]*[\u0001\u0002][ \u0001\u0002]*/g;

/**
 * Convert an HTML email body to plain text for the ticket pipeline (#6687).
 *
 * 1. sanitize-html keeps only the layout tags above (bare), decoding entities
 *    in text and re-escaping only `&`, `<`, `>`.
 * 2. Any U+0001/U+0002 now present is sender text (e.g. `&#2;`) — removed
 *    before those code points are used as break markers, so they stay
 *    unambiguous. Source whitespace is collapsed (not significant in HTML).
 * 3. Layout tags become markers (table cells a space); then entities decode.
 * 4. A run of adjacent markers collapses to one break — a blank line if any
 *    paragraph-level tag is in the run, else one newline — so `</div><div>`
 *    and `</li><li>` don't double-space.
 */
function htmlToText(html: string): string {
  const sanitized = sanitizeHtml(html.slice(0, MAX_HTML_INPUT_LENGTH), {
    allowedTags: BREAK_TAGS,
    allowedAttributes: {},
    nonTextTags: NON_TEXT_TAGS,
  });
  const text = sanitized
    .replace(/[\u0001\u0002]/g, '')
    .replace(/\s+/g, ' ')
    .replace(PARAGRAPH_TAG_RE, PARA)
    .replace(LINE_TAG_RE, LINE)
    .replace(CELL_TAG_RE, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/ /g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(BREAK_RUN_RE, (run) => (run.includes(PARA) ? '\n\n' : '\n'))
    .trim()
    .slice(0, MAX_HTML_DERIVED_TEXT_LENGTH);
  // Don't leave half a surrogate pair where the clamp cut.
  return text.replace(/[\uD800-\uDBFF]$/, '');
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
