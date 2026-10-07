import addressparser from 'nodemailer/lib/addressparser/index.js';

/**
 * RFC 5322 address parsing for inbound headers (From, Mailgun's envelope
 * `sender`, `recipient`).
 *
 * A header's address is its mailbox addr-spec, never an address that merely
 * appears inside a quoted display name or a comment. Hand-rolled "first <...>"
 * or "last <...>" regexes get that wrong: `"Staff <staff@msp.example>"
 * <attacker@evil.example>` yields the staff address. nodemailer's addressparser
 * tokenizes quoted strings and comments, so the display name stays a name.
 */
export interface ParsedMailbox {
  /** Lower-cased addr-spec. */
  address: string;
  /** Display name, if any. */
  name?: string;
}

/** Every mailbox in a header value, group members flattened, empty addresses dropped. */
export function parseMailboxes(raw: string | null | undefined): ParsedMailbox[] {
  if (!raw || !raw.trim()) return [];
  return addressparser(raw, { flatten: true })
    .map((m) => ({ address: (m.address ?? '').trim().toLowerCase(), name: (m.name ?? '').trim() || undefined }))
    .filter((m) => m.address !== '');
}

/** The header's mailbox when it holds exactly one, else null (absent or ambiguous). */
export function parseSingleMailbox(raw: string | null | undefined): ParsedMailbox | null {
  const all = parseMailboxes(raw);
  return all.length === 1 ? all[0]! : null;
}
