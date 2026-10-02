import { GATEWAY_ERROR_TEXT_MAX } from './limits';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const GENERIC_SECRETS: RegExp[] = [
  /(authorization\s*:\s*bearer\s+)[^\s"',;]+/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,          // OpenAI/Anthropic-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,            // AWS access key ids (W07)
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT-shaped tokens
];

const REDACTED = '[redacted]';
/** Secrets shorter than this are ignored (never redact every "a"). */
const MIN_SECRET_CHARS = 8;
/** Any run of this many consecutive secret characters is treated as the secret. */
const WINDOW_CHARS = 12;
/** Only this much of a secret feeds the window sets (keys are ≤ 500 chars by schema). */
const MAX_SECRET_WINDOW_SOURCE = 1024;
/** Hex characters per encoded-fragment window: 12 bytes of the secret. */
const HEX_WINDOW_CHARS = 24;
/** Base64 characters per encoded-fragment window: 12 bytes of the secret. */
const B64_WINDOW_CHARS = 16;
/** Fewest secret bytes for which encoded-fragment windows are used (shorter secrets: whole forms only). */
const MIN_ENCODED_WINDOW_BYTES = 12;

/** Whole encoded forms of the secret, matched exactly. */
function exactForms(s: string): string[] {
  const utf8 = Buffer.from(s, 'utf8');
  const basic = Buffer.from(`:${s}`, 'utf8'); // HTTP Basic with an empty username
  const forms = new Set<string>([JSON.stringify(s).slice(1, -1)]);
  for (const b of [utf8, basic]) {
    const b64 = b.toString('base64');
    forms.add(b64);
    forms.add(b64.replace(/=+$/, ''));
    forms.add(b.toString('base64url'));
  }
  forms.delete(s);
  return [...forms].filter((f) => f.length >= MIN_SECRET_CHARS);
}

/** Whole encoded forms whose hex digits may be written in either case (hex, URL-encoding), matched case-insensitively. */
function caselessForms(s: string): string[] {
  return [Buffer.from(s, 'utf8').toString('hex'), encodeURIComponent(s)]
    .filter((f) => f !== s && f.length >= MIN_SECRET_CHARS);
}

/**
 * The text with every %HH escape decoded (either hex case, mixed freely): an
 * ASCII byte decodes on its own, and a well-formed multi-byte UTF-8 sequence of
 * escapes decodes to its character. For each decoded UTF-16 unit, the span of
 * the original text it came from. Returns null when the text has no escapes.
 */
function percentDecodedView(text: string): { view: string; start: number[]; end: number[] } | null {
  if (!text.includes('%')) return null;
  const byteAt = (i: number): number | null => {
    if (text[i] !== '%' || i + 2 >= text.length) return null;
    const hex = text.slice(i + 1, i + 3);
    return /^[0-9A-Fa-f]{2}$/.test(hex) ? parseInt(hex, 16) : null;
  };
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < text.length;) {
    const lead = byteAt(i);
    if (lead !== null && lead < 0x80) {
      out.push(String.fromCharCode(lead)); start.push(i); end.push(i + 3); i += 3;
      continue;
    }
    if (lead !== null) {
      const len = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
      const bytes = [lead];
      for (let k = 1; k < len; k += 1) {
        const b = byteAt(i + 3 * k);
        if (b === null || b < 0x80 || b > 0xbf) break;
        bytes.push(b);
      }
      const decoded = len > 0 && bytes.length === len ? Buffer.from(bytes).toString('utf8') : '';
      if (decoded.length > 0 && !decoded.includes('�')) {
        for (const unit of decoded.split('')) { out.push(unit); start.push(i); end.push(i + 3 * len); }
        i += 3 * len;
        continue;
      }
    }
    out.push(text[i]!); start.push(i); end.push(i + 1); i += 1;
  }
  return { view: out.join(''), start, end };
}

/** Distinct substrings of `source` of length `w` (all of `source` when shorter), starting every `step` units. */
function windowsOf(source: string, w: number, step = 1): Set<string> {
  const out = new Set<string>();
  const width = Math.min(w, source.length);
  for (let i = 0; i + width <= source.length; i += step) out.add(source.substr(i, width));
  return out;
}

/**
 * Fragment windows of the secret's byte encodings: any 12 consecutive bytes of
 * the secret as hex (compared lower-cased), or as base64 / base64url at each of
 * the three byte alignments a fragment can start on. Only base64 characters
 * fully determined by secret bytes are used, so a window never depends on
 * whatever surrounded the secret when it was encoded.
 */
function encodedWindows(s: string): { hex: Set<string>; b64: Set<string> } {
  const bytes = Buffer.from(s.slice(0, MAX_SECRET_WINDOW_SOURCE), 'utf8');
  if (bytes.length < MIN_ENCODED_WINDOW_BYTES) return { hex: new Set(), b64: new Set() };
  const hex = windowsOf(bytes.toString('hex'), HEX_WINDOW_CHARS, 2);
  const b64 = new Set<string>();
  for (let a = 0; a < 3; a += 1) {
    const slice = bytes.subarray(a);
    const exact = slice.subarray(0, slice.length - (slice.length % 3));
    if (exact.length < MIN_ENCODED_WINDOW_BYTES) continue;
    for (const enc of [exact.toString('base64'), exact.toString('base64url')]) {
      for (const win of windowsOf(enc, B64_WINDOW_CHARS)) b64.add(win);
    }
  }
  return { hex, b64 };
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** Every occurrence of `needle` in `text` (case-insensitively when asked), as spans. */
function occurrences(text: string, needle: string, caseless: boolean): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (caseless) {
    const re = new RegExp(needle.replace(REGEX_SPECIALS, '\\$&'), 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) spans.push([m.index, m.index + m[0].length]);
    return spans;
  }
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) spans.push([i, i + needle.length]);
  return spans;
}

/** Spans of `view` holding any member of `windows` (all of length w), mapped to original offsets. */
function windowSpans(view: string, windows: ReadonlySet<string>, w: number, map?: { start: number[]; end: number[] }): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let p = 0; p + w <= view.length; p += 1) {
    if (!windows.has(view.substr(p, w))) continue;
    spans.push(map ? [map.start[p]!, map.end[p + w - 1]!] : [p, p + w]);
  }
  return spans;
}

/** Replace the union of `spans` (merging overlapping and touching spans) with one marker each. */
function redactSpans(text: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;
  let [curStart, curEnd] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s <= curEnd) { curEnd = Math.max(curEnd, e); continue; }
    parts.push(text.slice(cursor, curStart), REDACTED);
    cursor = curEnd; curStart = s; curEnd = e;
  }
  parts.push(text.slice(cursor, curStart), REDACTED, text.slice(curEnd));
  return parts.join('');
}

/**
 * Spans of `text` carrying material of the secret `s`:
 *  - every run of 12+ consecutive characters of the secret (the whole secret
 *    when shorter), in the text as written and with percent-escapes decoded
 *    (upper, lower, mixed and partial encoding, multi-byte UTF-8 included);
 *  - any 12 consecutive bytes of the secret written as hex (either case) or as
 *    base64 / base64url (any alignment);
 *  - whole encoded forms: hex and URL-encoding (case-insensitive), base64 /
 *    base64url padded or not, the base64 of the empty-username Basic form
 *    `:<secret>`, and the JSON-escaped form.
 * Work is linear in the text for each secret.
 */
function secretSpans(text: string, s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const f of exactForms(s)) spans.push(...occurrences(text, f, false));
  for (const f of caselessForms(s)) spans.push(...occurrences(text, f, true));

  const source = s.slice(0, MAX_SECRET_WINDOW_SOURCE);
  const w = Math.min(WINDOW_CHARS, source.length);
  const windows = windowsOf(source, w);
  spans.push(...windowSpans(text, windows, w));
  const decoded = percentDecodedView(text);
  if (decoded) spans.push(...windowSpans(decoded.view, windows, w, decoded));

  const enc = encodedWindows(s);
  if (enc.hex.size > 0) {
    for (let p = 0; p + HEX_WINDOW_CHARS <= text.length; p += 1) {
      if (enc.hex.has(text.substr(p, HEX_WINDOW_CHARS).toLowerCase())) spans.push([p, p + HEX_WINDOW_CHARS]);
    }
  }
  if (enc.b64.size > 0) spans.push(...windowSpans(text, enc.b64, B64_WINDOW_CHARS));
  // A secret longer than the window source still has its exact form removed.
  if (s.length > MAX_SECRET_WINDOW_SOURCE) spans.push(...occurrences(text, s, false));
  return spans;
}

/**
 * Whether `text` carries material of `secret`, by exactly the detection
 * scrubSecrets redacts (see secretSpans). Generic key shapes are not
 * considered here. A secret shorter than 8 characters is matched verbatim only.
 */
export function containsSecretMaterial(text: string, secret: string | null | undefined): boolean {
  if (!secret) return false;
  if (secret.length < MIN_SECRET_CHARS) return text.includes(secret);
  return secretSpans(text.replace(CONTROL, ' '), secret).length > 0;
}

/**
 * Remove credential material from text that may leave the gateway (errors,
 * last_error, verification detail). For each known secret this redacts every
 * span secretSpans finds (raw and windowed, percent-decoded, hex and base64
 * encodings and fragments of them). Generic key shapes are replaced even when
 * the secret is unknown. Scrubbing runs on the FULL text before truncation, so
 * a secret straddling the cut cannot survive as a prefix.
 */
export function scrubSecrets(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
  max: number = GATEWAY_ERROR_TEXT_MAX,
): string {
  let out = text.replace(CONTROL, ' ');
  for (const s of secrets) {
    if (!s || s.length < MIN_SECRET_CHARS) continue;
    out = redactSpans(out, secretSpans(out, s));
  }
  for (const re of GENERIC_SECRETS) {
    out = out.replace(re, (m, prefix?: unknown) => (typeof prefix === 'string' && prefix.length > 0 ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
