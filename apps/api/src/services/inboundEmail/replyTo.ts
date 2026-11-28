import { parseMailboxes } from './addressParse';

/**
 * Reply-To parsing for inbound mail (email-first replies W1, Refs #8758).
 *
 * The stored reply address decides who receives customer mail about a ticket,
 * and Reply-To is attacker-controlled message content. So this parser accepts
 * only the unambiguous case: exactly one header instance holding exactly one
 * syntactically valid mailbox. Anything else (no header, two headers, a group or
 * address list, a malformed or oversized value) returns undefined, and the
 * caller falls back to the From address. Never "the first of several".
 *
 * Syntax only. The loop guard (an address that is one of our own mailboxes) runs
 * twice: each normalizer drops the address that received the message, and ingest
 * drops the partner's own addresses once the partner is known
 * (replyToGuard.ts).
 */

// RFC 5321 path limit; also bounds what reaches the database.
const MAX_ADDRESS_LENGTH = 254;
// A header value longer than this is not a plain Reply-To.
const MAX_HEADER_LENGTH = 998;
// Dot-atom local part (no quoted strings, no comments) and an LDH domain with at
// least two labels. Stricter than RFC 5322 on purpose: a reply address that
// needs quoting is not one we mail on an attacker's say-so.
// The atext set minus `%`, `!` and `|`, which only ever meant relay routing.
const LOCAL_PART = /^[a-z0-9#$&'*+/=?^_`{}~-]+(?:\.[a-z0-9#$&'*+/=?^_`{}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A real top-level domain: letters, or an IDN A-label. Never numeric, so no
// IP-address-shaped domain.
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function isUsableAddress(address: string): boolean {
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return false;
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return false;
  const local = address.slice(0, at);
  const labels = address.slice(at + 1).split('.');
  return local.length <= 64
    && LOCAL_PART.test(local)
    && labels.length >= 2
    && labels.every((l) => DOMAIN_LABEL.test(l))
    && TOP_LABEL.test(labels[labels.length - 1]!);
}

function recipientAddress(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const address = (value as { emailAddress?: { address?: unknown } }).emailAddress?.address;
  return typeof address === 'string' ? address : null;
}

/**
 * The reply address, lower-cased, when `raw` holds exactly one valid address;
 * otherwise undefined.
 *
 * `raw` is one header value (string), every instance of the header (string[]),
 * or Graph's structured `replyTo` recipients (`[{ emailAddress: { address } }]`).
 */
export function normalizeReplyTo(raw: unknown): string | undefined {
  if (typeof raw === 'string') return normalizeReplyTo([raw]);
  if (!Array.isArray(raw)) return undefined;

  if (raw.every((v) => typeof v === 'string')) {
    const values = (raw as string[]).filter((v) => v.trim() !== '');
    if (values.length !== 1) return undefined;
    // Unfold a folded header line, then refuse any other control character.
    const value = values[0]!.replace(/\r?\n[ \t]+/g, ' ');
    // eslint-disable-next-line no-control-regex
    if (value.length > MAX_HEADER_LENGTH || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return undefined;
    const mailboxes = parseMailboxes(value);
    if (mailboxes.length !== 1) return undefined;
    const address = mailboxes[0]!.address;
    // Only the two plain shapes: a bare address, or `Name <address>`. The parser
    // is lenient about stray text (`jane smith@x.example` reads as a name plus
    // `smith@x.example`), and a guessed address is not one to mail.
    const plain = value.trim().toLowerCase();
    if (plain !== address && !plain.endsWith(`<${address}>`)) return undefined;
    return isUsableAddress(address) ? address : undefined;
  }

  if (raw.length !== 1) return undefined;
  const address = recipientAddress(raw[0])?.trim().toLowerCase();
  return address && isUsableAddress(address) ? address : undefined;
}

/**
 * The mailbox an address delivers to, for own-address comparisons: lower-cased,
 * with any `+tag` subaddress dropped from the local part. Exchange Online and
 * Gmail both deliver `support+anything@x` to `support@x`, so a Reply-To naming
 * a subaddress of one of our mailboxes loops just as the bare address would.
 * No other folding (Gmail ignores dots, but most mailboxes do not, so
 * `sup.port@x` stays a different address).
 */
export function mailboxBaseAddress(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at < 0) return a;
  const local = a.slice(0, at);
  const plus = local.indexOf('+');
  return (plus < 0 ? local : local.slice(0, plus)) + a.slice(at);
}

/** True when `a` and `b` deliver to the same mailbox (see mailboxBaseAddress). */
export function isSameMailbox(a: string, b: string): boolean {
  return mailboxBaseAddress(a) === mailboxBaseAddress(b);
}

/**
 * `replyTo` unless it names the mailbox the message was delivered to, or a
 * subaddress of it (a loop).
 */
export function replyToUnlessOwn(replyTo: string | undefined, ownAddress: string): string | undefined {
  if (!replyTo) return undefined;
  return isSameMailbox(replyTo, ownAddress) ? undefined : replyTo;
}
