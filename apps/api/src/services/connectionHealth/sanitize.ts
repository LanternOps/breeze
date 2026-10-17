import { redactLogMessage } from '../logRedaction';
import { BARE_SECRET_PATTERNS } from '../redactionPatterns';
import { redactSecretsFromOutput } from '../secretRedaction';

// Text that leaves a provider (error strings) or a user (connection names) and
// lands in a notice, the panel or a digest email (spec 2026-10-15 §7).

export const HEALTH_DETAIL_MAX = 300;
const DISPLAY_NAME_MAX = 80;

// C0/C1 controls and line separators become spaces; bidi controls, zero-width
// characters and the BOM are removed, so text cannot reorder or hide itself.
const TO_SPACE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// scheme://[userinfo@]host[:port][path?query#fragment] → scheme://host
const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^\s/?#@]*@)?([^\s/?#:@]+)(?::\d+)?[^\s]*/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

function cleanText(raw: string): string {
  return raw.replace(TO_SPACE_RE, ' ').replace(INVISIBLE_RE, '');
}

/** Cap in code points, never splitting a surrogate pair. */
function capCodePoints(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join('');
}

/**
 * Provider error text → a short, credential-free detail, or null. Strips URLs to
 * scheme and host, redacts the log-redaction credential shapes (bearer tokens,
 * key/token/secret pairs, JWTs, vendor tokens), replaces email addresses,
 * collapses whitespace and caps at 300 code points. Idempotent.
 */
export function sanitizeHealthDetail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = cleanText(raw).replace(URL_RE, (_m, scheme: string, host: string) => `${scheme.toLowerCase()}://${host}`);
  s = redactSecretsFromOutput(redactLogMessage(s));
  for (const pattern of BARE_SECRET_PATTERNS) s = s.replace(pattern, '[REDACTED]');
  s = s.replace(EMAIL_RE, '[email]').replace(/\s+/g, ' ').trim();
  s = capCodePoints(s, HEALTH_DETAIL_MAX).trim();
  return s === '' ? null : s;
}

/**
 * User- or vendor-chosen connection names (DCR client_name, a backup or EDR
 * connection name, a mailbox address) → at most 80 code points of plain text.
 */
export function cleanDisplayName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? cleanText(raw).replace(/\s+/g, ' ').trim() : '';
  return capCodePoints(s || fallback, DISPLAY_NAME_MAX);
}
