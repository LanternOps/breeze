/**
 * Topology M4 (#6000): the ONE string sanitizer for anything a topology AI
 * surface (tool result, evidence snapshot, explanation) derives from collected
 * or operator-entered text — device names, interface aliases, DNS/LLDP/CDP and
 * controller strings, manual notes, error text. All of it is UNTRUSTED DATA:
 *
 *   - control characters (C0/C1), bidi overrides and zero-width characters are
 *     stripped, so a hostile name cannot hide text or forge structure;
 *   - known prompt-boundary/injection shapes are neutralized by the shared chat
 *     sanitizer (`sanitizeUntrustedText`), so an instruction inside an
 *     interface alias is inert text, never a directive;
 *   - credential-shaped fragments (key=value secrets, SNMP communities,
 *     bearer/basic auth, cookies, private-key blocks, userinfo in URLs) are
 *     replaced with a fixed marker;
 *   - the result is capped at 255 UTF-8 bytes on a code-point boundary.
 *
 * Callers must additionally treat the output as data (the evidence snapshot
 * carries it only in `untrustedText` fields, and the model contract says so).
 */
import { sanitizeUntrustedText } from '../aiInputSanitizer';

export const TOPOLOGY_AI_TEXT_MAX_BYTES = 255;
export const TOPOLOGY_AI_REDACTED = '[redacted]';

// C0 (except none), DEL, C1, bidi overrides/isolates, zero-width, BOM, soft hyphen.
const CONTROL = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/giu,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu,
  /\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/giu,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|community|snmp[_-]?community|auth[_-]?key|priv[_-]?key|psk|credential)s?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/giu,
  /\b(community)\s+("[^"]*"|'[^']*'|\S+)/giu,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(:[^\s/@]*)?@/giu,
];

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let bytes = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/** Redact credential-shaped fragments. Exported for the evidence serializer's error-text path. */
export function redactTopologySecrets(value: string, flags?: Set<string>): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      flags?.add('secret_redacted');
      pattern.lastIndex = 0;
      out = out.replace(pattern, (match, scheme: string | undefined) =>
        typeof scheme === 'string' && /:\/\/$/.test(scheme) ? `${scheme}${TOPOLOGY_AI_REDACTED}@` : TOPOLOGY_AI_REDACTED);
    }
  }
  return out;
}

/**
 * Sanitize one untrusted string for a topology AI surface. Non-strings and
 * strings that sanitize to nothing return null (never an empty claim).
 */
export function sanitizeTopologyAiText(value: unknown, flags?: Set<string>, maxBytes = TOPOLOGY_AI_TEXT_MAX_BYTES): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.normalize('NFC').replace(CONTROL, ' ');
  if (stripped !== value.normalize('NFC')) flags?.add('control_stripped');
  const redacted = redactTopologySecrets(stripped, flags);
  const sink: string[] = [];
  // Length is enforced below in BYTES; the chat sanitizer only neutralizes.
  const neutral = sanitizeUntrustedText(redacted, Number.MAX_SAFE_INTEGER, sink);
  for (const flag of sink) flags?.add(flag);
  const collapsed = neutral.replace(/\s+/gu, ' ').trim();
  const bounded = truncateUtf8(collapsed, maxBytes);
  if (bounded !== collapsed) flags?.add('truncated');
  return bounded.length ? bounded : null;
}
