import { describe, it, expect } from 'vitest';
import { normalizeGmailMessage, isAddressedToMailbox } from './normalizeGmailMessage';
import { withInboundAttachmentNote } from '../inboundEmail/inboundAttachments';
import { MAX_HTML_DERIVED_TEXT_LENGTH } from '../inboundEmail/htmlToText';
import type { gmail_v1 } from '@googleapis/gmail';

describe('isAddressedToMailbox (ingestion scope A — MTA-stamped headers only)', () => {
  const H = (name: string, value: string) => ({ name, value });
  const MB = 'help@client.example';

  it('true when the mailbox is in the Gmail-stamped Delivered-To', () => {
    // LIVE-VERIFIED (support-primary@example.com via GAM, 2026-09-22): Gmail stamps Delivered-To
    // with the exact delivered address — the alias for alias mail, the primary for
    // direct mail — so a Delivered-To match captures a dedicated mailbox AND an alias.
    expect(isAddressedToMailbox([H('Delivered-To', MB)], MB)).toBe(true);
    // an alias delivered to the connected address matches (observed: Delivered-To
    // carried the alias support@example.com / alerts@example.com, not the primary)
    expect(isAddressedToMailbox([H('Delivered-To', `alias-of <${MB}>`)], MB)).toBe(true);
    // case-insensitive + plus-addressing on the trusted header
    expect(isAddressedToMailbox([H('Delivered-To', 'HELP@CLIENT.EXAMPLE')], MB)).toBe(true);
    expect(isAddressedToMailbox([H('Delivered-To', 'help+urgent@client.example')], MB)).toBe(true);
  });

  it('does NOT trust X-Original-To (a gateway header, not Gmail-stamped — empty on every live Gmail sample)', () => {
    expect(isAddressedToMailbox([H('X-Original-To', MB)], MB)).toBe(false);
  });

  it('does NOT trust sender-content recipient headers (To/Cc/Bcc/Resent-*/X-Forwarded-To) — they are forgeable', () => {
    expect(isAddressedToMailbox([H('To', `Support <${MB}>`)], MB)).toBe(false);
    expect(isAddressedToMailbox([H('Cc', `a@x.com, ${MB}`)], MB)).toBe(false);
    expect(isAddressedToMailbox([H('Bcc', MB)], MB)).toBe(false);
    expect(isAddressedToMailbox([H('Resent-To', MB)], MB)).toBe(false);
    expect(isAddressedToMailbox([H('X-Forwarded-To', MB)], MB)).toBe(false);
  });

  it('REJECTS the hostile case: delivered to the account owner, help@ only in a forged To (reviewer falsifier)', () => {
    expect(isAddressedToMailbox(
      [H('Delivered-To', 'owner@client.example'), H('To', MB), H('Resent-To', MB), H('X-Forwarded-To', MB)],
      MB,
    )).toBe(false);
  });

  it('trusts only the FIRST (Gmail-prepended) Delivered-To, so a sender-injected duplicate below cannot win', () => {
    // Gmail's genuine top header says owner@; a forged second Delivered-To says help@.
    expect(isAddressedToMailbox(
      [H('Delivered-To', 'owner@client.example'), H('Delivered-To', MB)],
      MB,
    )).toBe(false);
  });

  it('false for sender-only, empty, or a different same-domain mailbox', () => {
    expect(isAddressedToMailbox([H('From', MB), H('Delivered-To', 'owner@personal.example')], MB)).toBe(false);
    expect(isAddressedToMailbox([H('Delivered-To', 'sales@client.example')], MB)).toBe(false);
    expect(isAddressedToMailbox([], MB)).toBe(false);
    expect(isAddressedToMailbox(undefined, MB)).toBe(false);
  });
});

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

const SUB = '104729382910';
const MAILBOX = 'help@example.com';

function baseMessage(headers: gmail_v1.Schema$MessagePartHeader[], parts?: gmail_v1.Schema$MessagePart[]): gmail_v1.Schema$Message {
  return {
    id: 'gmsg-1',
    threadId: 'gthread-1',
    internalDate: '1758300000000',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'snippet fallback',
    payload: {
      mimeType: parts ? 'multipart/alternative' : 'text/plain',
      headers,
      parts,
      body: parts ? {} : { data: b64url('plain body') },
    },
  };
}

const GOOGLE_AR = 'mx.google.com; spf=pass smtp.mailfrom=cust@x.com; dkim=pass header.i=@x.com; dmarc=pass';

describe('normalizeGmailMessage', () => {
  it('maps core fields, provider gmail, and namespaced dedup id', () => {
    const msg = baseMessage([
      { name: 'From', value: 'Cust Name <Cust@X.com>' },
      { name: 'To', value: MAILBOX },
      { name: 'Subject', value: 'Printer down [T-2026-0007]' },
      { name: 'Message-ID', value: '<abc@mail.x.com>' },
      { name: 'In-Reply-To', value: '<prev@mail.x.com>' },
      { name: 'References', value: '<root@mail.x.com> <prev@mail.x.com>' },
      { name: 'Authentication-Results', value: GOOGLE_AR },
    ], [
      { mimeType: 'text/plain', filename: '', body: { data: b64url('please help') } },
      { mimeType: 'text/html', filename: '', body: { data: b64url('<p>please help</p>') } },
    ]);
    const n = normalizeGmailMessage(msg, 'partner-9', MAILBOX, SUB);
    expect(n.provider).toBe('gmail');
    // Namespaced so it cannot collide with another mailbox's Gmail id under the
    // (partner_id, provider_message_id) unique key.
    expect(n.providerMessageId).toBe(`gmail:${SUB}:gmsg-1`);
    expect(n.resolvedPartnerId).toBe('partner-9');
    expect(n.to).toBe(MAILBOX);
    expect(n.from).toBe('cust@x.com');
    expect(n.fromName).toBe('Cust Name');
    expect(n.subject).toBe('Printer down [T-2026-0007]');
    expect(n.messageId).toBe('<abc@mail.x.com>');
    expect(n.inReplyTo).toBe('<prev@mail.x.com>');
    expect(n.references).toEqual(['<root@mail.x.com>', '<prev@mail.x.com>']);
    expect(n.text).toBe('please help');
    expect(n.html).toBe('<p>please help</p>');
    expect(n.raw.gmailMessageId).toBe('gmsg-1');
    expect(n.raw.gmailThreadId).toBe('gthread-1');
    // Neutral body + sender-name keys so a quarantined/failed Gmail row is
    // readable when the review queue reconstructs a ticket from `raw`.
    expect(n.raw.bodyText).toBe('please help');
    expect(n.raw.fromName).toBe('Cust Name');
  });

  it('trusts a Google-stamped Authentication-Results (verified on DMARC pass)', () => {
    const msg = baseMessage([
      { name: 'From', value: 'cust@x.com' },
      { name: 'Authentication-Results', value: GOOGLE_AR },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true });
  });

  it('IGNORES a sender-injected Authentication-Results with a foreign authserv-id (fail closed)', () => {
    const msg = baseMessage([
      { name: 'From', value: 'attacker@evil.com' },
      // Forged header the sender put in their own message: authserv-id is NOT
      // mx.google.com or the mailbox domain, so it must be ignored.
      { name: 'Authentication-Results', value: 'evil.com; spf=pass; dkim=pass; dmarc=pass' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth?.verified).toBe(false);
    expect(n.senderAuth?.dmarc).toBe('unknown');
  });

  it('does NOT skip a non-Google topmost Authentication-Results to trust a forged mx.google.com header below it', () => {
    // Attack: the sender puts a non-Google A-R first, then a FORGED
    // `mx.google.com; dmarc=pass` below it. A "skip non-Google, keep scanning"
    // parser would trust the forgery. We must trust only the TOPMOST A-R (Google
    // prepends its genuine one on receipt), so this stays unverified.
    const msg = baseMessage([
      { name: 'From', value: 'attacker@evil.com' },
      { name: 'Authentication-Results', value: 'relay.attacker.com; spf=fail; dmarc=fail' },
      { name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth?.verified).toBe(false);
    expect(n.senderAuth?.dmarc).toBe('unknown');
  });

  it('trusts Google\'s genuine topmost header even when a forged mx.google.com header sits below it', () => {
    // Normal delivery: Google prepends its real verdict (dmarc=fail for a spoof),
    // the sender\'s forged mx.google.com; dmarc=pass is below it and ignored.
    const msg = baseMessage([
      { name: 'From', value: 'attacker@evil.com' },
      { name: 'Authentication-Results', value: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail' },
      { name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth).toEqual({ spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false });
  });

  it('is unverified when there is no Authentication-Results at all (fail closed)', () => {
    const msg = baseMessage([{ name: 'From', value: 'cust@x.com' }]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth?.verified).toBe(false);
  });

  it('does not verify when Google reports dmarc=fail', () => {
    const msg = baseMessage([
      { name: 'From', value: 'cust@x.com' },
      { name: 'Authentication-Results', value: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth).toEqual({ spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false });
  });

  it('does NOT trust an Authentication-Results whose authserv-id is the mailbox domain (forgeable)', () => {
    // The exact forgery Codex flagged: an attacker sets authserv-id = the
    // recipient's own domain, which the sender can write. Only mx.google.com is trusted.
    const msg = baseMessage([
      { name: 'From', value: 'victim@example.net' },
      { name: 'Authentication-Results', value: 'example.com; dmarc=pass' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth?.verified).toBe(false);
  });

  it('reads the real dmarc clause, not a value hidden inside a comment', () => {
    // `spf=pass (dmarc=pass)` must NOT be read as dmarc=pass; the genuine
    // dmarc=fail clause wins → unverified.
    const msg = baseMessage([
      { name: 'From', value: 'cust@x.com' },
      { name: 'Authentication-Results', value: 'mx.google.com; spf=pass (dmarc=pass); dmarc=fail' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth?.dmarc).toBe('fail');
    expect(n.senderAuth?.verified).toBe(false);
  });

  it('is not fooled by a dmarc verdict hidden in a comment that contains a semicolon', () => {
    // Codex pass-4 case: a naive split-on-";" then strip-comments would treat
    // "(explanation; dmarc=pass)" as a real clause. Comments must be stripped first.
    const msg = baseMessage([
      { name: 'From', value: 'cust@x.com' },
      { name: 'Authentication-Results', value: 'mx.google.com; spf=fail (explanation; dmarc=pass); dmarc=fail' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth?.dmarc).toBe('fail');
    expect(n.senderAuth?.verified).toBe(false);
  });

  it('handles an escaped paren inside a comment (quoted-pair) without leaking a forged verdict', () => {
    // Codex pass-3 case: `\)` must NOT terminate the comment; the genuine
    // dmarc=fail clause still wins.
    const msg = baseMessage([
      { name: 'From', value: 'cust@x.com' },
      { name: 'Authentication-Results', value: 'mx.google.com; spf=fail (explanation \\); dmarc=pass); dmarc=fail' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.senderAuth?.dmarc).toBe('fail');
    expect(n.senderAuth?.verified).toBe(false);
  });

  it('collects attachment metadata but never descends into attachment bodies', () => {
    const msg = baseMessage([{ name: 'From', value: 'cust@x.com' }], [
      { mimeType: 'text/plain', filename: '', body: { data: b64url('see attached') } },
      { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 20480, attachmentId: 'att-1' } },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).toBe('see attached');
    expect(n.attachments).toEqual([{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 20480, skipReason: 'provider_unsupported' }]);
  });

  it('treats an UNNAMED Content-Disposition: attachment part as an attachment, not the body', () => {
    // RFC 2183: `filename` is optional, so a text/plain attachment can arrive with
    // no filename. It must not be selected as the ticket description.
    const msg = baseMessage([{ name: 'From', value: 'cust@x.com' }], [
      {
        mimeType: 'text/plain',
        filename: '',
        headers: [{ name: 'Content-Disposition', value: 'attachment' }],
        body: { size: 12, data: b64url('secret dump') },
      },
      { mimeType: 'text/plain', filename: '', body: { data: b64url('the real body') } },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).toBe('the real body');
    expect(n.attachments).toEqual([{ filename: '(unnamed)', contentType: 'text/plain', size: 12, skipReason: 'provider_unsupported' }]);
  });

  it('F5: treats an embedded message/rfc822 as an attachment, not the body', () => {
    // A forwarded email (message/rfc822) with NO filename/disposition must be an
    // attachment, so its nested text never becomes the ticket description.
    const msg = baseMessage([{ name: 'From', value: 'cust@x.com' }], [
      { mimeType: 'text/plain', filename: '', body: { data: b64url('the real reply body') } },
      {
        mimeType: 'message/rfc822',
        filename: '',
        body: { size: 42 },
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64url('FORWARDED private content') } }],
      },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).toBe('the real reply body');
    expect(n.text).not.toContain('FORWARDED private content');
    expect(n.attachments).toEqual([{ filename: '(unnamed)', contentType: 'message/rfc822', size: 42, skipReason: 'provider_unsupported' }]);
  });

  it('F4: does NOT copy a single-part ROOT attachment body into the ticket description', () => {
    // A single-part message whose ROOT is Content-Disposition: attachment with inline
    // body data: the body must be recorded as attachment metadata only, never decoded
    // into the description (the single-part fallback must honor the attachment guard).
    const msg: gmail_v1.Schema$Message = {
      id: 'gmsg-att', threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
      snippet: 'snippet fallback',
      payload: {
        mimeType: 'text/plain',
        filename: 'dump.txt',
        headers: [
          { name: 'From', value: 'cust@x.com' },
          { name: 'Content-Disposition', value: 'attachment; filename="dump.txt"' },
        ],
        body: { size: 11, data: b64url('SECRET DUMP') },
      },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).not.toContain('SECRET DUMP');
    expect(n.text).toBe('snippet fallback');
    expect(n.attachments).toEqual([{ filename: 'dump.txt', contentType: 'text/plain', size: 11, skipReason: 'provider_unsupported' }]);
  });

  it('marks Gmail attachments not-imported so the ticket carries a visible note', () => {
    const msg: gmail_v1.Schema$Message = {
      id: 'gmsg-att-note', threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
      snippet: 'snippet fallback',
      payload: {
        mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'cust@x.com' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('see attached') } },
          { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 20480, attachmentId: 'a1' } },
        ],
      },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(withInboundAttachmentNote(n.text, n)).toBe(
      'see attached\n\n[Email attachments not imported: invoice.pdf (attachment import is not available for this mailbox yet)]',
    );
  });

  it('matches a Delivered-To on a punycode domain (last label with digits and hyphens)', () => {
    expect(isAddressedToMailbox([{ name: 'Delivered-To', value: 'help@example.xn--p1ai' }], 'help@example.xn--p1ai')).toBe(true);
    expect(isAddressedToMailbox([{ name: 'Delivered-To', value: 'other@example.xn--p1ai' }], 'help@example.xn--p1ai')).toBe(false);
  });

  it('F3: processes a hostile unmatched-"<" body at scale, bounded by the shared caps', () => {
    // Regression for the quadratic /<[^>]+>/g strip (O(n) per unmatched '<', O(n^2)
    // overall — a synchronous event-loop DoS from anyone who can email the mailbox).
    // The replacement is linear BY CONSTRUCTION (every branch makes forward progress;
    // an unmatched '<' is kept as literal text; the style/script closer search is
    // memoized), so instead of a flaky wall-clock threshold this asserts the
    // deterministic outcome: the FULL input is processed and preserved at scale. A
    // truly quadratic impl would not finish this within vitest's per-test timeout.
    const run = (chars: number) => {
      const hostile = '<'.repeat(chars);
      const msg: gmail_v1.Schema$Message = {
        id: `gmsg-dos-${chars}`, threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
        snippet: 'snippet fallback',
        payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'cust@x.com' }], body: { data: b64url(hostile) } },
      };
      return normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    };
    // Shared htmlToText (inboundEmail/htmlToText.ts, also used by Microsoft Graph):
    // unmatched '<' is kept as literal text and the derived text is capped at the
    // ticket description limit, so a huge hostile body finishes and stays bounded.
    expect(run(50_000).text).toBe('<'.repeat(50_000));
    expect(run(400_000).text).toBe('<'.repeat(MAX_HTML_DERIVED_TEXT_LENGTH));
  });

  it('F3: keeps a lone "<" and the text after it (no silent body truncation)', () => {
    // A legitimate body with an unclosed "<" (e.g. "price < 100") must not lose
    // everything after the "<" — the tag stripper treats it as literal text.
    const msg: gmail_v1.Schema$Message = {
      id: 'gmsg-lt', threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
      snippet: 'snippet fallback',
      payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'cust@x.com' }],
        body: { data: b64url('<p>Quote:</p>the price &lt; 100 and 5 < 10, call me back please') } },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).toContain('call me back please');
    expect(n.text).toContain('5 < 10');
  });

  it('F31: does not treat a ">" inside a quoted attribute as the tag terminator', () => {
    const msg: gmail_v1.Schema$Message = {
      id: 'gmsg-attr', threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
      snippet: 'snippet fallback',
      payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'cust@x.com' }],
        body: { data: b64url('<p title="1 > 0">Call me</p>') } },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).toBe('Call me');
  });

  it('F27-1: strips real <style>/<script> blocks but treats a look-alike tag as an ordinary tag', () => {
    const msg: gmail_v1.Schema$Message = {
      id: 'gmsg-blk', threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
      snippet: 'snippet fallback',
      payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'cust@x.com' }],
        body: { data: b64url('<style>.x{color:red}</style><p>Body one</p><script>alert(1)</script><styled-note>Body two</styled-note>done') } },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    // Real style/script content is removed...
    expect(n.text).not.toContain('color:red');
    expect(n.text).not.toContain('alert(1)');
    // ...but a look-alike <styled-note> is just a dropped tag — its text and
    // everything after it survive (no whole-body truncation).
    expect(n.text).toContain('Body one');
    expect(n.text).toContain('Body two');
    expect(n.text).toContain('done');
  });

  it('F27-1: an UNCLOSED <style> drops what follows it, like the Microsoft 365 path (shared parser)', () => {
    const msg: gmail_v1.Schema$Message = {
      id: 'gmsg-uncl', threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
      snippet: 'snippet fallback',
      payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'cust@x.com' }],
        body: { data: b64url('<p>Important before</p><style type="text/css">and the actual message the customer typed') } },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    // Content before the malformed block survives; sanitize-html treats an unclosed
    // <style> as running to the end, the same result a Microsoft 365 mailbox gives.
    expect(n.text).toContain('Important before');
    expect(n.text).not.toContain('the actual message the customer typed');
  });

  it('F27-2: a long HTML-only body flattens from the start and is capped at the ticket description limit', () => {
    const filler = '<p>line</p>'.repeat(30_000); // ~330k chars of HTML
    const html = `<p>start</p>${filler}<p>END-MARKER</p>`;
    const msg: gmail_v1.Schema$Message = {
      id: 'gmsg-long', threadId: 't', internalDate: '1758300000000', labelIds: ['INBOX'],
      snippet: 'snippet fallback',
      payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'cust@x.com' }], body: { data: b64url(html) } },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text.startsWith('start')).toBe(true);
    expect(n.text.length).toBeLessThanOrEqual(MAX_HTML_DERIVED_TEXT_LENGTH);
  });

  it('bounds a hostile oversized body to the 1 MiB cap without decoding the whole input', () => {
    // 'A' in base64url decodes to a 0x00 byte. Build an encoded string well past
    // the cap; the decoded body must be clamped to <= 1 MiB.
    const MAX_BODY_BYTES = 1024 * 1024;
    const huge = 'A'.repeat(MAX_BODY_BYTES * 2); // ~2 MiB of encoded chars
    const msg = baseMessage([{ name: 'From', value: 'cust@x.com' }], [
      { mimeType: 'text/plain', filename: '', body: { data: huge } },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(Buffer.byteLength(n.text, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it('maps loop-prevention headers, including Return-Path and X-Loop', () => {
    const msg = baseMessage([
      { name: 'From', value: 'noreply@x.com' },
      { name: 'Auto-Submitted', value: 'auto-replied' },
      { name: 'Precedence', value: 'bulk' },
      { name: 'Return-Path', value: '<>' },
      { name: 'X-Loop', value: 'help@example.com' },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.autoSubmitted).toBe('auto-replied');
    expect(n.precedence).toBe('bulk');
    // Without these two, loopPrevention's bounce (<>) and X-Loop guards never
    // fire for Gmail mail.
    expect(n.returnPath).toBe('<>');
    expect(n.xLoop).toBe('help@example.com');
  });

  it('derives the FULL body text from HTML for an HTML-only message (not just the snippet)', () => {
    const msg = baseMessage(
      [{ name: 'From', value: 'cust@x.com' }],
      [{ mimeType: 'text/html', body: { data: b64url('<p>Intro line.</p><p>Details <b>after</b> the preview cutoff.</p>') } }],
    );
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.html).toContain('Details');
    // The full HTML is flattened to text — the content past the snippet cutoff
    // survives, and the body is never empty.
    expect(n.text).toContain('Intro line.');
    expect(n.text).toContain('Details after the preview cutoff.');
    expect(n.text).not.toBe('snippet fallback');
  });

  it('strips a CFWS comment from a bare From address so resolution sees the real domain', () => {
    const msg = baseMessage([{ name: 'From', value: 'customer@client.example (Customer Name)' }]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.from).toBe('customer@client.example');
  });

  it('extracts the address from a quoted display name containing commas and escaped quotes', () => {
    // The angle-bracket address must win regardless of the display name; a naive
    // [^"<] parser returned the whole header and broke domain routing.
    const msg = baseMessage([{ name: 'From', value: 'Doe, "John" <john@client.example>' }]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.from).toBe('john@client.example');
  });

  it('decodes a non-UTF-8 (iso-8859-1) body using the part charset, not mojibake', () => {
    const latin1Body = Buffer.from('café résumé', 'latin1').toString('base64url');
    const msg = baseMessage([{ name: 'From', value: 'cust@x.com' }], [
      {
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }],
        body: { data: latin1Body },
      },
    ]);
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).toBe('café résumé');
    expect(n.text).not.toContain('�'); // no replacement char
  });

  it('falls back to the snippet only when there is no body part', () => {
    const msg: gmail_v1.Schema$Message = {
      id: 'g2', threadId: 't2', internalDate: '1', labelIds: ['INBOX'], snippet: 'just the snippet',
      payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'a@b.com' }], parts: [] },
    };
    const n = normalizeGmailMessage(msg, 'p', MAILBOX, SUB);
    expect(n.text).toBe('just the snippet');
  });
});
