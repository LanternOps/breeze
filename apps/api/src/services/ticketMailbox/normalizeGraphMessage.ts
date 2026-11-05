import { getDomain } from 'tldts';
import type { GraphMessage } from './graphMailClient';
import type { NormalizedInboundEmail, SenderAuth } from '../inboundEmail/types';
import { BREEZE_OUTBOUND_HEADER } from '../emailDomains/outboundMarker';
import { htmlToText } from '../inboundEmail/htmlToText';
import { buildSenderAuth, normalizeVerdict, parseAuthClauses, stripComments } from '../inboundEmail/authenticationResults';
import { MAX_BODY_BYTES } from './normalizeGmailMessage';
import type { ArcEvaluation } from './arcSeal';

function header(headers: GraphMessage['internetMessageHeaders'], name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}



/**
 * Return the value of the Authentication-Results header we can TRUST, or '' if none.
 *
 * Graph's `internetMessageHeaders` returns the full header set, which can include an
 * `Authentication-Results` line a malicious sender put into their OWN message
 * (e.g. `Authentication-Results: anything; dmarc=pass`). Exchange Online stamps a
 * header whose authserv-id is whatever its MX wrote. This legacy read — mirroring the
 * mailgun normalizer's authserv-id check — trusts ONLY a header whose authserv-id
 * matches the support mailbox's own domain; unmatched → '' → all verdicts 'unknown'
 * → verified=false → the R4 gate quarantines (never drops) for manual review.
 * Only read when Exchange has NOT marked the message as external (intra-tenant mail,
 * or mail missing the org headers). External mail goes through exchangeStampAuth and
 * the trusted ARC sealers instead, and never reads this form: Exchange Online writes
 * `mx.microsoft.com`, so on external mail a mailbox-domain line can only be the
 * sender's (#10862). Intra-tenant mail is verified from Exchange's intra-tenant stamp
 * (#8299).
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
  return allHeadersEqual(headers, 'x-ms-exchange-organization-authas', 'Internal')
    && allHeadersEqual(headers, 'x-ms-exchange-organization-messagedirectionality', 'Originating');
}

function allHeadersEqual(
  headers: GraphMessage['internetMessageHeaders'], name: string, expected: string,
): boolean {
  const values = (headers ?? [])
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value.trim());
  return values.length > 0 && values.every((v) => v === expected);
}

/**
 * The tenant's own Exchange saying this message came in from outside: AuthAs
 * Anonymous (attributed to no connector) or Partner (attributed to a partner
 * connector), with MessageDirectionality Incoming. Same firewall as
 * isExchangeIntraTenant, same strictness. Null is "no proof of external origin":
 * Exchange's stamp is not read, and the legacy mailbox-domain path applies.
 */
function exchangeExternalAuthAs(
  headers: GraphMessage['internetMessageHeaders'],
): 'Anonymous' | 'Partner' | null {
  if (!allHeadersEqual(headers, 'x-ms-exchange-organization-messagedirectionality', 'Incoming')) return null;
  if (allHeadersEqual(headers, 'x-ms-exchange-organization-authas', 'Anonymous')) return 'Anonymous';
  if (allHeadersEqual(headers, 'x-ms-exchange-organization-authas', 'Partner')) return 'Partner';
  return null;
}

const EXCHANGE_AUTHSERV_ID = /^(mx\.microsoft\.com|[a-z0-9-]+\.mail\.protection\.outlook\.com)$/;

function authservId(value: string): string | null {
  const first = stripComments(value).split(';')[0]?.trim().toLowerCase() ?? '';
  return /^([a-z0-9.-]+)(?:\s+\d+)?$/.exec(first)?.[1] ?? null;
}

function organizationalDomain(domain: string | null | undefined): string | null {
  return domain ? getDomain(domain, { allowPrivateDomains: true }) : null;
}

function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(value.lastIndexOf('@') + 1) || null;
}

type SealedVerdict = 'pass' | 'fail' | 'not-from-domain' | 'inconclusive';

/**
 * Read a trusted sealer's results against this message's From domain. A seal does
 * not cover From, so a genuine sealed pass for some other domain must not count.
 * Real gateways may report only dkim and spf (the sample in #10862 has no dmarc
 * clause), so an aligned pass of either counts, which is DMARC's own definition.
 */
function readSealedVerdict(results: string, fromDomain: string | null): SealedVerdict {
  const clauses = parseAuthClauses(results);
  if (clauses.some((c) => c.method === 'dmarc' && normalizeVerdict(c.result) === 'fail')) return 'fail';

  const passed = (method: string) => clauses.filter(
    (c) => c.method === method && normalizeVerdict(c.result) === 'pass',
  );
  const dmarcPass = passed('dmarc');
  const namesFrom = dmarcPass.filter((c) => c.props.has('header.from'));
  if (namesFrom.some((c) => c.props.get('header.from') !== fromDomain)) return 'not-from-domain';
  if (namesFrom.length > 0) return 'pass';

  const fromOrg = organizationalDomain(fromDomain);
  const aligned = (domain: string | null | undefined) => (
    fromOrg !== null && organizationalDomain(domain) === fromOrg
  );
  const dkimPass = passed('dkim');
  const spfPass = passed('spf');
  if (
    dkimPass.some((c) => aligned(c.props.get('header.d') ?? domainOf(c.props.get('header.i'))))
    || spfPass.some((c) => aligned(domainOf(c.props.get('smtp.mailfrom'))))
  ) {
    return 'pass';
  }
  return dmarcPass.length + dkimPass.length + spfPass.length > 0 ? 'not-from-domain' : 'inconclusive';
}

interface GraphSenderAuth {
  senderAuth: SenderAuth;
  /** Which source was read and what it said. Set only when not verified. */
  consulted?: string;
}

/**
 * Exchange's stamp on external mail. The org headers prove the message crossed this
 * tenant, but they say nothing about which Authentication-Results line Exchange
 * wrote, and a sender can add a line reading `mx.microsoft.com ... dmarc=pass`. So
 * exactly one line may exist across all authserv-ids: if Exchange removed or renamed
 * the sender's line, the one left is its own; if it did not, there are two and we
 * cannot tell them apart, so neither is read. Its header.from must also be this
 * message's From domain. compauth is not read: Microsoft's composite verdict includes
 * implicit and allow-listed passes, which is not what `verified` means anywhere else.
 */
function exchangeStampAuth(
  headers: GraphMessage['internetMessageHeaders'], fromDomain: string | null,
): GraphSenderAuth {
  const lines = (headers ?? []).filter((h) => h.name.toLowerCase() === 'authentication-results');
  const unknown = buildSenderAuth(undefined);
  if (lines.length === 0) return { senderAuth: unknown, consulted: 'no Exchange Online stamp' };
  if (lines.length > 1) {
    return {
      senderAuth: unknown,
      consulted: `Exchange Online stamp ambiguous: ${lines.length} Authentication-Results headers`,
    };
  }
  const value = lines[0]!.value;
  if (!EXCHANGE_AUTHSERV_ID.test(authservId(value) ?? '')) {
    return { senderAuth: unknown, consulted: 'Authentication-Results from an untrusted authserv-id ignored' };
  }
  const auth = buildSenderAuth(value);
  const dmarc = parseAuthClauses(value).filter((c) => c.method === 'dmarc');
  const forThisDomain = fromDomain !== null && dmarc.length > 0 && dmarc.every(
    (c) => normalizeVerdict(c.result) === 'pass' && c.props.get('header.from') === fromDomain,
  );
  if (forThisDomain) return { senderAuth: { ...auth, verified: true, source: 'exchange-online' } };
  return {
    senderAuth: { ...auth, verified: false },
    consulted: auth.dmarc === 'pass'
      ? 'Exchange Online stamp: DMARC verdict is not for the From domain'
      : `Exchange Online stamp: dmarc=${auth.dmarc}`,
  };
}

/**
 * Sender auth for a Microsoft 365 mailbox message, most specific proof first.
 *
 * External mail (exchangeExternalAuthAs): a verified seal from one of the connection's
 * trusted ARC sealers decides when its verdict is a pass for the From domain or a
 * dmarc=fail, because Exchange judges gateway-relayed mail against the gateway's IP
 * and modified body and so its own stamp is wrong there. Any other seal result
 * (none, invalid, not for this domain) falls through to Exchange's stamp. A sealed
 * dmarc=fail vetoes whatever domain it names: conservative, and a sender can only
 * get their own mail quarantined that way. A mailbox-domain Authentication-Results line is
 * not read on this path: Exchange does not write that form, so all it can be is a line
 * from the sender. `Authentication-Results-Original` is never read: nothing shows who
 * wrote it, and on mail sent straight to Exchange that is the sender.
 *
 * Without that proof the mailbox-domain stamp is read as before, and a trusted DMARC
 * verdict wins in both directions. When there is no usable verdict (intra-tenant mail
 * is unsigned), Exchange's intra-tenant stamp verifies the sender instead, so the R4
 * gate in inboundEmailService passes for the tenant's own staff without trusting the
 * From domain or the customer-domain list.
 */
function graphSenderAuth(
  headers: GraphMessage['internetMessageHeaders'],
  mailboxDomain: string,
  fromAddress: string,
  arc: ArcEvaluation | undefined,
): GraphSenderAuth {
  const authAs = exchangeExternalAuthAs(headers);
  if (!authAs) {
    const auth = buildSenderAuth(trustedAuthResults(headers, mailboxDomain));
    if (auth.verified) return { senderAuth: auth };
    if (auth.dmarc !== 'fail' && isExchangeIntraTenant(headers)) {
      return { senderAuth: { ...auth, verified: true, source: 'exchange-internal' } };
    }
    return {
      senderAuth: auth,
      consulted: auth.dmarc === 'fail' ? 'mailbox-domain stamp: dmarc=fail' : 'no Exchange tenant proof on this message',
    };
  }

  const at = fromAddress.indexOf('@');
  const fromDomain = at > 0 && at === fromAddress.lastIndexOf('@') ? fromAddress.slice(at + 1) : null;
  const notes: string[] = [];
  if (arc?.status === 'verified') {
    const auth = buildSenderAuth(arc.authResults);
    const verdict = readSealedVerdict(arc.authResults, fromDomain);
    if (verdict === 'pass') return { senderAuth: { ...auth, verified: true, source: 'trusted-arc-sealer' } };
    if (verdict === 'fail') {
      return { senderAuth: { ...auth, verified: false }, consulted: `trusted ARC sealer ${arc.sealer}: dmarc=fail` };
    }
    notes.push(verdict === 'not-from-domain'
      ? `trusted ARC sealer ${arc.sealer}: verdict is not for the From domain`
      : `trusted ARC sealer ${arc.sealer}: no usable verdict`);
  } else if (arc?.status === 'no-trusted-seal') {
    notes.push('no seal from a trusted ARC sealer');
  } else if (arc?.status === 'dns-unavailable') {
    notes.push(`trusted ARC sealer ${arc.sealer}: key lookup failed`);
  } else if (arc?.status === 'invalid') {
    notes.push(`${arc.sealer ? `trusted ARC sealer ${arc.sealer}` : 'ARC chain'}: seal did not verify (${arc.reason})`);
  }

  const stamp: GraphSenderAuth = authAs === 'Anonymous'
    ? exchangeStampAuth(headers, fromDomain)
    : { senderAuth: buildSenderAuth(undefined), consulted: 'Exchange Online stamp not read on connector mail' };
  if (stamp.senderAuth.verified) return stamp;
  return { senderAuth: stamp.senderAuth, consulted: [...notes, stamp.consulted].join('; ') };
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

/**
 * Pure mapping: Graph message -> the pipeline's NormalizedInboundEmail. `options.arc`
 * is the caller's evaluateTrustedArc result, since verifying a seal needs DNS.
 */
export function normalizeGraphMessage(
  msg: GraphMessage,
  partnerId: string,
  mailboxAddress: string,
  options?: { arc?: ArcEvaluation },
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

  const { senderAuth, consulted } = graphSenderAuth(msg.internetMessageHeaders, mailboxDomain, fromAddr, options?.arc);

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
    ...(consulted ? { senderAuthConsulted: consulted } : {}),
    // Metadata only across the queue — attachment bytes never go into Redis. The
    // inbound worker fetches them from Graph before processing when this is set
    // (services/ticketMailbox/fetchInboundAttachments.ts, #6688).
    attachments: [],
    hasAttachments: msg.hasAttachments === true,
    raw: {
      ccRecipients: msg.ccRecipients ?? [],
      graphConversationId: msg.conversationId,
      receivedDateTime: msg.receivedDateTime,
      // Audit trail for which source passed the R4 gate (#8299, #10862); absent when
      // none of the Exchange or gateway sources did.
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
