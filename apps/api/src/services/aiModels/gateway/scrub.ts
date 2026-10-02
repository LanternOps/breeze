import { GATEWAY_ERROR_TEXT_MAX } from './limits';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const GENERIC_SECRETS: RegExp[] = [
  /(authorization\s*:\s*bearer\s+)[^\s"',;]+/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,          // OpenAI/Anthropic-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,            // AWS access key ids (W07)
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT-shaped tokens
];

/**
 * Remove credential material from text that may leave the gateway (errors,
 * last_error, verification detail). Exact secrets, their common encodings and
 * any 12-char tail of a long secret are replaced; generic key shapes are
 * replaced even when the secret is unknown. Scrubbing runs on the FULL text
 * before truncation, so a secret straddling the cut cannot survive as a prefix.
 */
export function scrubSecrets(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
  max: number = GATEWAY_ERROR_TEXT_MAX,
): string {
  let out = text.replace(CONTROL, ' ');
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    // Codex review #2: the exact secret and its common encodings (URL-encoded,
    // base64, base64url, JSON-escaped), plus any 12-char tail of a long secret.
    const forms = new Set([s, encodeURIComponent(s), Buffer.from(s).toString('base64'),
      Buffer.from(s).toString('base64url'), JSON.stringify(s).slice(1, -1)]);
    if (s.length >= 16) forms.add(s.slice(-12));
    // Longest first, so a shorter form (the tail) cannot split a longer one.
    for (const f of [...forms].sort((a, b) => b.length - a.length)) {
      if (f.length >= 8) out = out.split(f).join('[redacted]');
    }
  }
  for (const re of GENERIC_SECRETS) {
    out = out.replace(re, (m, prefix?: unknown) => (typeof prefix === 'string' && prefix.length > 0 ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
