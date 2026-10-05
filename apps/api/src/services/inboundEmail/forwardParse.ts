/**
 * Forwarded-message parsing for the staff-forward intake path.
 *
 * When a staff member forwards a client's email into the ticket mailbox, the
 * OUTER From is the staff member (e.g. msp.example) — so ordinary sender-domain
 * routing would file the ticket under the MSP's own org. This module extracts
 * the ORIGINAL sender's address from the forwarded-header block so the caller
 * can route by that domain instead.
 *
 * Deterministic and bounded: it recognizes exactly two forwarded-header
 * shapes (Gmail and Outlook, below) and pulls the original From address. It parses the address, never a display name, and never trusts the
 * extracted address for authentication — the caller uses the DOMAIN only to pick
 * an internal org bucket, gated on the OUTER message already being verified.
 *
 * Parses a provider-supplied text/plain body only; the caller never passes text derived from
 * HTML, so HTML-only mail routes normally. In practice that makes it a Gmail
 * feature: the Microsoft 365 mailbox path receives HTML bodies (Graph is not
 * asked for text), and modern Outlook marks a forward with an underscore rule
 * rather than "-----Original Message-----", which is not recognized. A
 * forward is recognized ONLY by an exact forward-marker line (Gmail
 * "---------- Forwarded message ---------" or Outlook "-----Original
 * Message-----") whose very next line starts a header block containing a From:
 * header and a Date:/Sent: or Subject: header. From:/Sent:/Subject: lines typed
 * or quoted anywhere else in a message never count, and neither does prose that
 * mentions "the original message".
 *
 * Recognition is textual: nothing in the message proves a mail client wrote the
 * marker, so a staff member who types the exact marker line and header block
 * gets the same routing. That is accepted because only an authenticated, active
 * partner-level staff user of the partner, in a partner that turned the setting
 * on, can trigger the path, and it only chooses which customer org (one that user
 * already has access to) the new ticket is filed under.
 */

// An email address inside angle brackets, or a bare address. Intentionally
// simple: we only need the domain, and over-permissive local parts are fine.
const ANGLE_ADDR = /<\s*([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)\s*>/;
const BARE_ADDR = /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/;

/** The only lines that introduce a forwarded block, matched exactly (no
 *  surrounding whitespace): Gmail "---------- Forwarded message ---------" and Outlook
 *  "-----Original Message-----". */
const FORWARD_MARKER_LINE = /^(?:-{10} Forwarded message -{9}|-{5}Original Message-{5})$/;
const HEADER_LINE = /^[A-Za-z][A-Za-z -]{0,30}:/;
const DATE_LINE = /^(?:Sent|Date):/;
const SUBJECT_LINE = /^Subject:/;

/**
 * Remove RFC5322 quoted display-names and parenthesized comments (which may be
 * nested and may contain escapes) so an address inside them cannot be mistaken
 * for the real mailbox. A small scanner rather than regex strips, because nested
 * comments and escaped quotes defeat a single regex pass.
 */
function stripQuotesAndComments(line: string): string {
  let out = '';
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (inQuote) {
      if (c === '\\') { i++; continue; }        // skip the escaped char
      if (c === '"') { inQuote = false; }         // close quote
      continue;                                   // drop quoted content
    }
    if (depth > 0) {
      if (c === '\\') { i++; continue; }        // skip the escaped char
      else if (c === '(') depth++;                // nested comment
      else if (c === ')') depth--;                // close one level
      continue;                                   // drop comment content
    }
    if (c === '"') { inQuote = true; out += ' '; continue; }
    if (c === '(') { depth++; out += ' '; continue; }
    out += c;
  }
  return out;
}

/** Pull the first email address out of a "From:" header line. */
function addrFromLine(line: string): string | null {
  const cleaned = stripQuotesAndComments(line);
  const angle = cleaned.match(ANGLE_ADDR)?.[1];
  if (angle) return angle.toLowerCase();
  const bare = cleaned.match(BARE_ADDR)?.[1];
  if (bare) return bare.toLowerCase();
  return null;
}

/** Is this line a "From:" header (English, as both supported markers produce)? */
function isFromLine(line: string): boolean {
  return /^From:/.test(line);
}

/**
 * Extract the original sender's email address from a forwarded body, or null if
 * the body has no recognized forward block (see the module comment).
 */
export function extractForwardedSender(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !FORWARD_MARKER_LINE.test(line)) continue;
    // The header block must start on the very next line and stay contiguous.
    let from: string | null = null;
    let corroborated = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const inner = lines[j] ?? '';
      if (!inner.trim() || !HEADER_LINE.test(inner)) break;
      if (j === i + 1 && !isFromLine(inner)) break;
      if (!from && isFromLine(inner)) from = addrFromLine(inner);
      if (DATE_LINE.test(inner) || SUBJECT_LINE.test(inner)) corroborated = true;
    }
    if (from && corroborated) return from;
  }
  return null;
}

/** The lowercased domain of an email address, or null. */
export function domainOf(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at < 0 || at === addr.length - 1) return null;
  return addr.slice(at + 1).toLowerCase();
}
