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
/** Only this much of a secret feeds the window set (keys are ≤ 500 chars by schema). */
const MAX_SECRET_WINDOW_SOURCE = 1024;

/** Encoded forms of the whole secret that a window search over the text cannot see. */
function encodedForms(s: string): string[] {
  const utf8 = Buffer.from(s, 'utf8');
  const basic = Buffer.from(`:${s}`, 'utf8'); // HTTP Basic with an empty username
  const hex = utf8.toString('hex');
  const forms = new Set<string>([hex, hex.toUpperCase(), JSON.stringify(s).slice(1, -1)]);
  for (const b of [utf8, basic]) {
    const b64 = b.toString('base64');
    forms.add(b64);
    forms.add(b64.replace(/=+$/, ''));
    forms.add(b.toString('base64url'));
  }
  // Non-ASCII characters are percent-encoded as multi-byte UTF-8 sequences, which
  // the ASCII-only decoded view below does not reassemble; cover both hex cases.
  const uri = encodeURIComponent(s);
  forms.add(uri);
  forms.add(uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  forms.delete(s);
  return [...forms].filter((f) => f.length >= MIN_SECRET_CHARS);
}

/**
 * The text with every %HH escape of an ASCII byte decoded (either hex case),
 * plus, for each decoded character, the span of the original text it came from.
 * Returns null when the text has no escapes.
 */
function percentDecodedView(text: string): { view: string; start: number[]; end: number[] } | null {
  if (!text.includes('%')) return null;
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === '%' && i + 2 < text.length && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      const code = parseInt(text.slice(i + 1, i + 3), 16);
      if (code < 0x80) { out.push(String.fromCharCode(code)); start.push(i); end.push(i + 3); i += 3; continue; }
    }
    out.push(text[i]!); start.push(i); end.push(i + 1); i += 1;
  }
  return { view: out.join(''), start, end };
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
 * Remove credential material from text that may leave the gateway (errors,
 * last_error, verification detail). For each known secret this redacts:
 * every run of 12+ consecutive characters of the secret (the whole secret when
 * it is shorter than 12), in the text as written and with ASCII percent-escapes
 * decoded (so upper, lower, mixed and partial URL-encoding are all covered);
 * and the secret's hex (both cases), base64/base64url (padded or not), the
 * base64 of the empty-username Basic form `:<secret>`, its JSON-escaped form
 * and its full URL-encoding. Generic key shapes are replaced even when the
 * secret is unknown. Work is linear in the text for each secret. Scrubbing runs
 * on the FULL text before truncation, so a secret straddling the cut cannot
 * survive as a prefix.
 */
export function scrubSecrets(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
  max: number = GATEWAY_ERROR_TEXT_MAX,
): string {
  let out = text.replace(CONTROL, ' ');
  for (const s of secrets) {
    if (!s || s.length < MIN_SECRET_CHARS) continue;
    // Longest first, so a shorter form cannot split a longer one.
    for (const f of encodedForms(s).sort((a, b) => b.length - a.length)) out = out.split(f).join(REDACTED);

    const source = s.slice(0, MAX_SECRET_WINDOW_SOURCE);
    const w = Math.min(WINDOW_CHARS, source.length);
    const windows = new Set<string>();
    for (let i = 0; i + w <= source.length; i += 1) windows.add(source.substr(i, w));
    const spans = windowSpans(out, windows, w);
    const decoded = percentDecodedView(out);
    if (decoded) spans.push(...windowSpans(decoded.view, windows, w, decoded));
    out = redactSpans(out, spans);
    // A secret longer than the window source still has its exact form removed.
    if (s.length > MAX_SECRET_WINDOW_SOURCE) out = out.split(s).join(REDACTED);
  }
  for (const re of GENERIC_SECRETS) {
    out = out.replace(re, (m, prefix?: unknown) => (typeof prefix === 'string' && prefix.length > 0 ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
