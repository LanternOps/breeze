import type { gmail_v1 } from '@googleapis/gmail';
import type { InboundEmailAttachment, NormalizedInboundEmail } from '../inboundEmail/types';
import { htmlToText } from '../inboundEmail/htmlToText';
import { buildSenderAuth, stripComments } from '../inboundEmail/authenticationResults';
import { BREEZE_OUTBOUND_HEADER } from '../emailDomains/outboundMarker';

// Cap decoded body size defensively (a hostile message must not let us decode an
// unbounded buffer). 1 MiB of text is far beyond any real ticket body. Exported so
// the referenced-body fetch can refuse an over-cap part by its declared size.
export const MAX_BODY_BYTES = 1024 * 1024;
// base64 expands 3 bytes -> 4 chars, so bounding the ENCODED input to this many
// chars keeps the decoded buffer at/under MAX_BODY_BYTES WITHOUT first allocating
// the whole decoded body. Rounded up to a multiple of 4 so a slice never splits a
// base64 quantum. Exported so the referenced-body fetch can apply the same bound.
export const MAX_BODY_B64_CHARS = Math.ceil(MAX_BODY_BYTES / 3) * 4;

type GHeader = gmail_v1.Schema$MessagePartHeader;

function header(headers: GHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

/** The declared charset of a MIME part, from its Content-Type header, lowercased
 * (e.g. 'iso-8859-1', 'windows-1252'). Gmail does NOT transcode part bodies to
 * UTF-8, so a legacy sender's body must be decoded with its own charset. */
function partCharset(part: gmail_v1.Schema$MessagePart | undefined): string | undefined {
  const ct = header(part?.headers ?? undefined, 'Content-Type');
  const m = ct ? /charset\s*=\s*"?([\w.:-]+)"?/i.exec(ct) : null;
  return m?.[1]?.toLowerCase();
}

function decodeBody(data: string | null | undefined, charset?: string): string {
  if (!data) return '';
  // Gmail part bodies are base64url. Bound the ENCODED input BEFORE decoding so a
  // hostile oversized part cannot force a full-size allocation; the subarray then
  // trims any remaining quantum to the exact byte cap.
  const bounded = data.length > MAX_BODY_B64_CHARS ? data.slice(0, MAX_BODY_B64_CHARS) : data;
  const buf = Buffer.from(bounded, 'base64url').subarray(0, MAX_BODY_BYTES);
  // Decode with the part's declared charset when it is not already UTF-8/ASCII;
  // an unknown label falls back to UTF-8 rather than throwing.
  if (charset && !['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(charset)) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      /* unknown encoding label — fall through to UTF-8 */
    }
  }
  return buf.toString('utf8');
}

interface WalkResult {
  text: string;
  html: string | undefined;
  attachments: InboundEmailAttachment[];
}

/** A part is an attachment when it declares Content-Disposition: attachment OR
 * carries a filename. RFC 2183 makes `filename` an OPTIONAL parameter, so a
 * filename-less `attachment` part must NOT be mistaken for the body — otherwise
 * an unnamed attachment (including a SINGLE-PART root attachment) could have its
 * contents copied into the ticket description. */
function isAttachmentPart(part: gmail_v1.Schema$MessagePart): boolean {
  const disposition = (header(part.headers ?? undefined, 'Content-Disposition') ?? '')
    .trim().toLowerCase();
  // An embedded email (message/rfc822) is an ATTACHED message, not this message's
  // body — treat it as an attachment even with no filename or disposition, so the
  // walker never descends into it and adopts the forwarded message's text as the
  // ticket description.
  const mime = (part.mimeType ?? '').toLowerCase();
  return (part.filename ?? '') !== '' || disposition.startsWith('attachment') || mime === 'message/rfc822';
}

/** Walk the MIME tree collecting the first text/plain, first text/html, and
 * attachment metadata (never bodies). Bounded recursion depth. */
function walkParts(part: gmail_v1.Schema$MessagePart | undefined, depth: number, acc: WalkResult): void {
  if (!part || depth > 20) return;
  const mime = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';

  if (isAttachmentPart(part)) {
    acc.attachments.push({
      filename: filename || '(unnamed)',
      contentType: mime || 'application/octet-stream',
      size: Number(part.body?.size ?? 0),
      // Gmail attachment import is not implemented yet. Marking the file skipped
      // puts a visible "[Email attachments not imported: …]" line on the ticket
      // (inboundAttachments.ts) instead of dropping it silently.
      skipReason: 'provider_unsupported',
    });
    return; // do not descend into an attachment's own body
  }

  if (mime === 'text/plain' && !acc.text) {
    acc.text = decodeBody(part.body?.data, partCharset(part));
  } else if (mime === 'text/html' && acc.html === undefined) {
    acc.html = decodeBody(part.body?.data, partCharset(part));
  }

  for (const child of part.parts ?? []) walkParts(child, depth + 1, acc);
}

// ── Sender authentication ────────────────────────────────────────────────────

// The authserv-id Google stamps on Authentication-Results for mail delivered to
// a Gmail/Workspace mailbox. Only a header carrying THIS authserv-id is trusted:
// a sender cannot make Google stamp it, whereas a sender CAN forge a header whose
// authserv-id equals the recipient's own domain (which is why the mailbox domain
// is deliberately NOT trusted here — see the security review). If a tenant's Google
// infra ever stamps a different id, mail fails closed (quarantined, never dropped)
// until this constant is tuned.
const GOOGLE_AUTHSERV_ID = 'mx.google.com';


/**
 * Return the Authentication-Results header we can TRUST, or '' if none.
 *
 * RFC 8601 §5: the receiving MTA PREPENDS its Authentication-Results header, so the
 * TOPMOST `Authentication-Results` in a message delivered to a Gmail mailbox is the
 * one Google stamped on receipt. We trust ONLY that topmost header, and only when
 * its authserv-id is Google's (`mx.google.com`).
 *
 * Crucially we do NOT scan past the topmost A-R header to find a Google-looking one
 * lower down: a sender can put their own `Authentication-Results: attacker; dmarc=…`
 * FOLLOWED by a forged `Authentication-Results: mx.google.com; dmarc=pass` into the
 * body, and a "skip non-Google, keep looking" scan would trust the forgery. By
 * stopping at the first A-R header, a forged mx.google.com header is only ever
 * reached (and trusted) if it sits above Google's genuine one — which it cannot,
 * because Google prepends after the sender's content. If the topmost A-R is not
 * Google's (e.g. an unusual routing path where Google did not stamp), we trust
 * nothing. Unmatched -> '' -> verdicts 'unknown' -> verified=false -> the R4 gate
 * quarantines (never drops), so no legitimate mail is lost, only not auto-trusted.
 */
function trustedAuthResults(headers: GHeader[] | undefined): string {
  for (const h of headers ?? []) {
    if ((h.name ?? '').toLowerCase() !== 'authentication-results') continue;
    // First (topmost) Authentication-Results header only — this is Google's stamp.
    const value = h.value ?? '';
    const authservId = (value.split(';')[0] ?? '').trim().split(/\s+/)[0]?.toLowerCase();
    return authservId === GOOGLE_AUTHSERV_ID ? value : '';
  }
  return '';
}



// The ONLY recipient header we trust as proof the support mailbox was actually a
// delivery recipient: Delivered-To, which the receiving server (Gmail) prepends at
// final delivery — it is NOT sender content. To/Cc/Bcc/Resent-To/Resent-Cc/
// X-Forwarded-To are message content the sender or an upstream forwarder controls,
// so they are forgeable and are deliberately NOT trusted (a forged `To: help@` on a
// message delivered only to the account owner must not defeat the recipient scope).
//
// LIVE-VERIFIED (support-primary@example.com via GAM, 2026-09-22): Gmail stamps Delivered-To with
// the EXACT address a message was delivered to — the ALIAS for alias-delivered mail
// (e.g. Delivered-To: support@example.com, alerts@example.com — both aliases of the
// primary support-primary@example.com) and the PRIMARY for direct mail (Delivered-To:
// support-primary@example.com). So matching the connected mailbox address against Delivered-To is
// correct for both a dedicated mailbox and an alias, and drops neither. X-Original-To
// was empty on every Gmail-delivered sample (it is added by upstream gateways, not by
// Gmail) and is therefore NOT trusted here.
const TRUSTED_RECIPIENT_HEADER_NAMES = new Set(['delivered-to']);
// The last label may hold digits and hyphens: punycode TLDs (xn--p1ai) are valid.
const EMAIL_ADDR_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z0-9-]{2,}/gi;

/** Collapse `+suffix` plus-addressing to the base mailbox so `help+urgent@x`
 * matches a `help@x` mailbox (same mailbox, tagged). Domain kept verbatim. */
function baseAddress(addr: string): string {
  const at = addr.indexOf('@');
  if (at < 0) return addr;
  const local = addr.slice(0, at);
  const plus = local.indexOf('+');
  return (plus < 0 ? local : local.slice(0, plus)) + addr.slice(at);
}

/**
 * True when the connected support mailbox is a TRUSTED delivery recipient of the
 * message, so the poller ingests only mail actually delivered to the support address
 * rather than the whole inbox — the mailbox may be an alias on a personal/shared
 * account whose other mail must NOT become tickets (#6592/#6593, ingestion-scope A).
 *
 * Only the MTA-stamped `Delivered-To` is trusted, and only its TOP (first)
 * occurrence — Gmail prepends its own on delivery, so a sender-injected duplicate
 * lower in the message cannot win (mirrors the Authentication-Results handling).
 * Sender-content recipient headers (To, Cc, Bcc, Resent-To, Resent-Cc,
 * X-Forwarded-To) are forgeable and are NOT accepted as proof. Matching is
 * address-only (display-name commas cannot confuse it), case-insensitive,
 * plus-addressing tolerant. A non-match leaves the mail in the inbox, never
 * deleted; the sweep logs every skip so a wrongly-filtered message is visible
 * (see sweepOneGmail).
 *
 * LIVE-VERIFIED (support-primary@example.com via GAM, 2026-09-22): Gmail stamps Delivered-To with
 * the EXACT address a message was delivered to. Alias-delivered mail carries the
 * ALIAS (samples: Delivered-To: support@example.com, alerts@example.com — both aliases
 * of the primary support-primary@example.com); direct mail carries the PRIMARY (Delivered-To:
 * support-primary@example.com). So a Delivered-To match against the connected address captures BOTH
 * a dedicated support mailbox and an alias, and drops neither. X-Original-To was empty
 * on every Gmail-delivered sample (it is a gateway header, not Gmail's) and is not
 * trusted here.
 */
export function isAddressedToMailbox(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  mailboxAddress: string,
): boolean {
  const target = baseAddress(mailboxAddress.trim().toLowerCase());
  if (!target) return false;
  // Take only the FIRST occurrence of each trusted header (Gmail's own, prepended).
  const seen = new Set<string>();
  const values: string[] = [];
  for (const h of headers ?? []) {
    const name = (h.name ?? '').toLowerCase();
    if (!TRUSTED_RECIPIENT_HEADER_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    values.push(h.value ?? '');
  }
  const matches = values.join('\n').toLowerCase().match(EMAIL_ADDR_RE);
  return matches != null && matches.some((m) => baseAddress(m) === target);
}

function parseEmail(raw: string | undefined): { address: string; name?: string } {
  if (!raw) return { address: '' };
  // Strip RFC 5322 CFWS comments FIRST so a valid `user@dom.com (Display)` does
  // not leave "(display)" glued to the address — resolveOrg does an exact domain
  // compare and would otherwise drop a known customer.
  const cleaned = stripComments(raw).trim();
  // The address is inside the angle brackets, whatever the display name contains
  // (commas, escaped quotes: `"Doe, \"John\"" <john@x.com>`). Extract the LAST
  // <addr> so a display name can never leak into the address. A `[^"<]*?` regex
  // over the whole header failed on escaped quotes and returned the whole header.
  const angle = /<([^<>]+)>\s*$/.exec(cleaned) ?? /<([^<>]+)>/.exec(cleaned);
  if (angle) {
    const address = (angle[1] ?? '').trim().toLowerCase();
    const name = cleaned.slice(0, angle.index).trim().replace(/^"(.*)"$/, '$1').trim() || undefined;
    return { address, name };
  }
  return { address: cleaned.toLowerCase() };
}

/**
 * Pure mapping: a Gmail FULL-format message -> the pipeline's NormalizedInboundEmail.
 *
 * `mailboxSub` is the mailbox's immutable Google account sub; it namespaces the
 * durable dedup key (Gmail message ids are only unique within a mailbox, and the
 * pipeline's unique index is (partner_id, provider_message_id) with no
 * provider/mailbox column). Being immutable and never-reused, it keeps the dedup
 * namespace stable across an email/alias change. The native Gmail id and thread id
 * are kept in `raw`.
 */
export function normalizeGmailMessage(
  msg: gmail_v1.Schema$Message,
  partnerId: string,
  mailboxAddress: string,
  mailboxSub: string,
): NormalizedInboundEmail {
  const headers = msg.payload?.headers ?? undefined;
  const from = parseEmail(header(headers, 'From'));
  const references = header(headers, 'References')?.trim().split(/\s+/).filter(Boolean);

  const acc: WalkResult = { text: '', html: undefined, attachments: [] };
  walkParts(msg.payload ?? undefined, 0, acc);
  // Single-part messages carry the body directly on payload.body. Guard against a
  // ROOT part that is itself an attachment (Content-Disposition: attachment / a
  // filename): walkParts already recorded it as attachment metadata and left the
  // body empty on purpose, so decoding it here would copy the attachment's contents
  // into the ticket description. isAttachmentPart is the same check walkParts uses.
  if (!acc.text && !acc.html && msg.payload?.body?.data
      && !(msg.payload && isAttachmentPart(msg.payload))) {
    const mime = (msg.payload.mimeType ?? '').toLowerCase();
    const decoded = decodeBody(msg.payload.body.data, partCharset(msg.payload ?? undefined));
    if (mime === 'text/html') acc.html = decoded; else acc.text = decoded;
  }
  // An HTML-only message has no text/plain part. Derive the FULL body text from
  // the HTML (the consumer persists only `text`), not just Gmail's truncated
  // `snippet` — a support message often carries the details after the preview
  // cutoff. Snippet remains the last-ditch fallback if the HTML flattens to empty.
  const text = acc.text || (acc.html ? htmlToText(acc.html) : '') || (msg.snippet ?? '');

  const gmailId = msg.id ?? '';

  return {
    provider: 'gmail',
    providerMessageId: `gmail:${mailboxSub}:${gmailId}`,
    resolvedPartnerId: partnerId,
    to: mailboxAddress.trim().toLowerCase(),
    from: from.address,
    fromName: from.name,
    subject: header(headers, 'Subject') ?? '',
    text,
    html: acc.html,
    messageId: header(headers, 'Message-ID') ?? header(headers, 'Message-Id'),
    inReplyTo: header(headers, 'In-Reply-To'),
    references,
    autoSubmitted: header(headers, 'Auto-Submitted'),
    precedence: header(headers, 'Precedence'),
    // Return-Path (envelope, `<>` = bounce) and X-Loop feed loopPrevention's
    // bounce and auto-response suppression — the Graph mapper maps both, so the
    // Gmail path must too or those guards silently never fire for Gmail mail.
    returnPath: header(headers, 'Return-Path'),
    xLoop: header(headers, 'X-Loop'),
    outboundMarker: header(headers, BREEZE_OUTBOUND_HEADER),
    senderAuth: buildSenderAuth(trustedAuthResults(headers)),
    attachments: acc.attachments,
    raw: {
      gmailMessageId: gmailId,
      gmailThreadId: msg.threadId,
      internalDate: msg.internalDate,
      labelIds: msg.labelIds ?? [],
      // Persist the normalized body + sender name so a quarantined/failed Gmail row
      // is readable in the review queue. ticket_email_inbound has no body column
      // (body lives in `raw`), and the review-queue "convert to ticket" path
      // reconstructs from `raw`. The Mailgun path stores its webhook form there
      // (stripped-text/body-plain/from); a Gmail row must carry equivalents under
      // neutral keys or the converted ticket comes out with an empty description
      // and no submitter name.
      bodyText: text,
      fromName: from.name ?? null,
    },
  };
}
