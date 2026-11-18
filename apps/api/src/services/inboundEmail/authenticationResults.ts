import type { SenderAuth, SenderAuthVerdict } from './types';

// Shared Authentication-Results verdict parsing for inbound mail (Gmail and
// Microsoft Graph). WHICH header is trusted stays provider-specific (each
// normalizer's own header selection); this module only reads verdicts out of the
// header the caller already chose to trust.

export function normalizeVerdict(raw: string | undefined): SenderAuthVerdict {
  const v = raw?.trim().toLowerCase();
  if (v === 'pass') return 'pass';
  if (v === 'fail' || v === 'softfail' || v === 'permerror' || v === 'temperror') return 'fail';
  if (v === 'neutral') return 'neutral';
  if (v === 'none') return 'none';
  return 'unknown';
}

/**
 * Split an Authentication-Results value into its clauses (index 0 is the
 * authserv-id), per the RFC 8601 / RFC 5322 lexical rules a writer follows:
 *  - a CFWS comment `( … )` may nest and is dropped;
 *  - a quoted-string `" … "` is kept whole, and `;`, `(` or `=` inside it has no
 *    meaning; a quoted-pair `\x` inside it is the literal character x.
 * Writers echo sender-chosen text (the envelope sender, a DKIM `i=`) into their
 * comments and properties, sometimes unescaped, so a value is accepted only when
 * it reads one way. Returns null (read no verdict) for an unterminated comment,
 * quoted-string or quoted-pair, a `)` outside any comment, or a comment holding
 * `"` or `\` (which the writers do not put in their own comments).
 */
export function splitAuthClauses(value: string): string[] | null {
  const clauses: string[] = [];
  let cur = '';
  let depth = 0;          // comment nesting
  let quoted = false;     // inside a quoted-string
  let pair = false;       // previous char was a quoted-pair backslash (in a quoted-string)
  for (const ch of value) {
    if (depth > 0) {
      if (ch === '"' || ch === '\\') return null;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0) cur += ' ';
      continue;
    }
    if (quoted) {
      cur += ch;
      if (pair) pair = false;
      else if (ch === '\\') pair = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; cur += ch; continue; }
    if (ch === '(') { depth = 1; continue; }
    if (ch === ')') return null;
    if (ch === ';') { clauses.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (depth !== 0 || quoted || pair) return null;
  clauses.push(cur);
  return clauses;
}

// authserv-id: a host name, optionally followed by a version number.
const AUTHSERV_ID = /^\s*([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?:\s+\d+)?\s*$/;
// `method=result`, then nothing but `name=value` properties.
const CLAUSE_HEAD = /^\s*([A-Za-z][\w-]*)\s*=\s*([A-Za-z]+)(?=\s|$)/;
const PROPERTY_NAME = /^([A-Za-z][\w.-]*)\s*=\s*/;
// DKIM identity properties a decision reads. Their values must be plain tokens: a
// quote, parenthesis, semicolon, backslash or space there means the value was
// echoed from the signature in a form we cannot read unambiguously. (header.from
// and smtp.mailfrom may be quoted by writers; header.from must still equal the
// From domain, and the envelope sender is checked separately.)
const BOUND_PROPERTIES = new Set(['header.i', 'header.d']);
const PLAIN_TOKEN = /^[^\s()";\\]+$/;
const AFTER_DMARC = new Set(['compauth', 'dara']);
const DMARC_PROPERTY = /^(header\.from|action|reason|policy\.[\w.-]+)$/;

/** The value starting at `text[0]`: up to the next whitespace outside a quoted-string. */
function readValue(text: string): string {
  let out = '';
  let quoted = false;
  let pair = false;
  for (const ch of text) {
    if (!quoted && /\s/.test(ch)) break;
    out += ch;
    if (pair) { pair = false; continue; }
    if (quoted && ch === '\\') pair = true;
    else if (ch === '"') quoted = !quoted;
  }
  return out;
}

/** A value that is one whole quoted-string, unquoted and unescaped; any other value as is. */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  if (readValue(value) !== value || /(^|[^\\])(\\\\)*"/.test(inner)) return value;
  return inner.replace(/\\(.)/g, '$1');
}

/** `name=value` properties of one clause (after its `method=result`); null when
 * anything else is there or a bound property is not a plain token. */
function parseProperties(rest: string): Map<string, string | null> | null {
  const props = new Map<string, string | null>();
  let text = rest;
  while ((text = text.replace(/^\s+/, '')) !== '') {
    const name = PROPERTY_NAME.exec(text);
    if (!name) return null;
    text = text.slice(name[0].length);
    const raw = readValue(text);
    if (!raw) return null;
    text = text.slice(raw.length);
    const key = name[1]!.toLowerCase();
    if (BOUND_PROPERTIES.has(key) && !PLAIN_TOKEN.test(raw)) return null;
    const value = unquote(raw).toLowerCase();
    props.set(key, props.has(key) && props.get(key) !== value ? null : value);
  }
  return props;
}

export interface AuthClause {
  method: string;
  result: string;
  /** Lowercased property values such as `header.from`; null when one appears twice
   * with different values, so a conflicting pair can never satisfy a comparison. */
  props: Map<string, string | null>;
}

/**
 * Every `method=result` clause with its properties, or null when the value cannot
 * be read unambiguously: a malformed split (splitAuthClauses), an authserv-id that
 * is not a host name, a clause that is not `method=result` followed only by
 * `name=value` properties, a DKIM identity that is not a plain token, or more than
 * one DMARC or SPF clause (writers give one of each per stamp; a second one can only
 * be text the writer echoed). Callers treat null as "no verdict" (not verified).
 */
export function parseAuthClausesOrNull(authResults: string): AuthClause[] | null {
  const parts = splitAuthClauses(authResults);
  if (!parts || !AUTHSERV_ID.test(parts[0] ?? '')) return null;
  const clauses: AuthClause[] = [];
  for (const clause of parts.slice(1)) {
    if (!clause.trim()) continue; // an empty clause, e.g. after a trailing `;`
    const head = CLAUSE_HEAD.exec(clause);
    if (!head?.[1] || !head[2]) return null;
    const props = parseProperties(clause.slice(head[0].length));
    if (!props) return null;
    clauses.push({ method: head[1].toLowerCase(), result: head[2], props });
  }
  for (const once of ['dmarc', 'spf']) {
    if (clauses.filter((c) => c.method === once).length > 1) return null;
  }
  // Writers put DMARC last (Exchange follows it with compauth, Google with dara),
  // and give it only header.from, action, reason and policy.* properties. A DMARC
  // clause anywhere else, or carrying another property, is text a writer echoed.
  const dmarcAt = clauses.findIndex((c) => c.method === 'dmarc');
  if (dmarcAt >= 0) {
    if (clauses.slice(dmarcAt + 1).some((c) => !AFTER_DMARC.has(c.method))) return null;
    if ([...clauses[dmarcAt]!.props.keys()].some((k) => !DMARC_PROPERTY.test(k))) return null;
  }
  return clauses;
}

// Characters that let an echoed envelope sender change how a stamp reads.
const ENVELOPE_SPECIALS = /[()";\\]/;

/**
 * Whether stamps may be read for a message with this envelope sender (MAIL FROM /
 * Return-Path). Writers copy it into their comments and properties, some unescaped
 * (Gmail's `spf=… (google.com: domain of <envelope> designates …)`), and once a `(`,
 * `)`, `"`, `;` or `\` from it is in a stamp no reader can recover the writer's
 * clause boundaries. True for an ordinary, null (`<>`) or unknown envelope.
 */
export function envelopeAllowsStamps(envelope: unknown): boolean {
  if (envelope === undefined || envelope === null) return true;
  return typeof envelope === 'string' && !ENVELOPE_SPECIALS.test(envelope);
}

/** Why no stamp was read for a message whose envelope sender failed envelopeAllowsStamps. */
export const ENVELOPE_UNREADABLE = 'envelope sender cannot be read unambiguously';
/** Why no stamp was read for a message whose DKIM signature failed dkimIdentitiesAllowStamps. */
export const SIGNATURE_IDENTITY_UNREADABLE = 'signature identity cannot be read unambiguously';

/**
 * Whether stamps may be read for a message with these DKIM-Signature header values.
 * Writers echo a signature's `i=` (the identity, which the signer chooses) as
 * header.i, decoded and sometimes unquoted, so an `i=` holding `(`, `)`, `"`, `;`,
 * `\` or whitespace once decoded changes how a stamp reads. A value that is not
 * text, or an `i=` with a malformed `=XX` escape, also refuses.
 */
export function dkimIdentitiesAllowStamps(signatures: readonly unknown[]): boolean {
  for (const sig of signatures) {
    if (typeof sig !== 'string') return false;
    for (const tag of sig.split(';')) {
      const eq = tag.indexOf('=');
      if (eq < 0 || tag.slice(0, eq).trim().toLowerCase() !== 'i') continue;
      const encoded = tag.slice(eq + 1).replace(/\s+/g, ''); // folding whitespace is not part of the value
      if (/=(?![0-9A-Fa-f]{2})/.test(encoded)) return false;
      const decoded = encoded.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      if (/[()";\\\s]/.test(decoded)) return false;
    }
  }
  return true;
}

/**
 * The reason no stamp may be read for a message, or null when stamps may be read.
 * `envelopeRequired` is for providers that always supply the envelope sender
 * (Mailgun's `sender`, Gmail's Return-Path): there a missing one is unreadable.
 */
export function stampsUnreadableReason(input: {
  envelope: unknown;
  envelopeRequired: boolean;
  dkimSignatures: readonly unknown[];
}): string | null {
  if (input.envelopeRequired && input.envelope === undefined) return ENVELOPE_UNREADABLE;
  if (!envelopeAllowsStamps(input.envelope)) return ENVELOPE_UNREADABLE;
  if (!dkimIdentitiesAllowStamps(input.dkimSignatures)) return SIGNATURE_IDENTITY_UNREADABLE;
  return null;
}

/** The leading authserv-id token of a value that splits, lower-cased; null otherwise. */
export function leadingAuthservId(value: string): string | null {
  const first = splitAuthClauses(value)?.[0];
  return first === undefined ? null : first.trim().split(/\s+/)[0]!.toLowerCase();
}

/** The authserv-id of a value that parses, lower-cased; null otherwise. */
export function authservIdOf(authResults: string): string | null {
  if (!parseAuthClausesOrNull(authResults)) return null;
  return AUTHSERV_ID.exec(splitAuthClauses(authResults)![0]!)![1]!.toLowerCase();
}

/** Every `method=result` clause with its properties; none for a value that cannot be read. */
export function parseAuthClauses(authResults: string | undefined): AuthClause[] {
  return authResults ? parseAuthClausesOrNull(authResults) ?? [] : [];
}

/** The result of the first `name` clause, or undefined when there is none. */
export function mechanism(authResults: string | undefined, name: string): string | undefined {
  return parseAuthClauses(authResults).find((c) => c.method === name.toLowerCase())?.result;
}

/** The DMARC result across every DMARC clause: 'pass' only when all of them pass. */
function dmarcResult(authResults: string | undefined): string | undefined {
  const results = parseAuthClauses(authResults).filter((c) => c.method === 'dmarc').map((c) => c.result);
  if (results.length === 0) return undefined;
  return results.find((r) => normalizeVerdict(r) !== 'pass') ?? results[0];
}

/** Lower-cased domain of a single well-formed address, or null. */
export function addressDomain(address: string | null | undefined): string | null {
  const a = (address ?? '').trim().toLowerCase();
  const at = a.indexOf('@');
  if (at <= 0 || at !== a.lastIndexOf('@') || at === a.length - 1) return null;
  return a.slice(at + 1);
}

// The domain after every `@` in a header value, wherever it sits: display names,
// quoted strings and comments included. Used only to refuse a binding, never to
// choose an address.
const AT_DOMAIN = /@([^\s<>"(),;:@[\]]+)/g;

/** True when every `@` in every value is followed by exactly `domain`. */
function everyAtIsOnDomain(values: readonly string[], domain: string): boolean {
  for (const value of values) {
    const ats = value.split('@').length - 1;
    const matches = [...value.matchAll(AT_DOMAIN)];
    if (matches.length !== ats) return false; // an `@` we cannot read a domain after
    if (matches.some((m) => m[1]!.toLowerCase() !== domain)) return false;
  }
  return true;
}

/**
 * The From domain a trusted DMARC pass covers, or null when it covers no address
 * we hold. DMARC is evaluated over the RFC 5322 From domain:
 *  - every DMARC clause that names `header.from` must name the domain of
 *    `fromAddress` (a different or conflicting one binds nothing);
 *  - every `@` in the raw From header value(s) (`fromHeaders`) must be followed
 *    by that same domain, so no reading of the header — ours or a verifier's —
 *    can name a mailbox on another domain. This runs whether or not a clause
 *    named `header.from`, since not every trusted stamp need name it.
 * `fromAddress` must be the single From mailbox; pass null when there is none.
 */
export function dmarcAuthenticatedDomain(
  authResults: readonly string[],
  fromAddress: string | null | undefined,
  fromHeaders?: string | readonly unknown[] | null,
): string | null {
  const domain = addressDomain(fromAddress);
  if (!domain) return null;
  const raw: readonly unknown[] = typeof fromHeaders === 'string' ? [fromHeaders] : fromHeaders ?? [];
  // A From value we cannot read as text names an unknown sender.
  if (raw.some((v) => typeof v !== 'string')) return null;
  for (const value of authResults) {
    for (const clause of parseAuthClauses(value)) {
      if (clause.method !== 'dmarc' || !clause.props.has('header.from')) continue;
      if (clause.props.get('header.from') !== domain) return null;
    }
  }
  return everyAtIsOnDomain(raw as readonly string[], domain) ? domain : null;
}

/**
 * Always returns a full SenderAuth (fail-closed). verified iff DMARC passed;
 * when verified, authenticatedDomain is the From domain it passed for, or null.
 */
export function buildSenderAuth(
  authResults: string | undefined,
  fromAddress?: string | null,
  fromHeaders?: string | readonly unknown[] | null,
): SenderAuth {
  const spf = normalizeVerdict(mechanism(authResults, 'spf'));
  const dkim = normalizeVerdict(mechanism(authResults, 'dkim'));
  const dmarc = normalizeVerdict(dmarcResult(authResults));
  const verified = dmarc === 'pass';
  if (!verified) return { spf, dkim, dmarc, verified };
  return { spf, dkim, dmarc, verified, authenticatedDomain: dmarcAuthenticatedDomain([authResults ?? ''], fromAddress, fromHeaders) };
}
