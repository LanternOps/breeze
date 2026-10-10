/**
 * Secret redaction for file content returned by a diagnostic read, applied
 * before the content reaches the AI assistant (aiToolsDiagnosticAccess.ts).
 *
 * Credential stores themselves are never readable through a grant
 * (./classification.ts), but an ordinary log or config file can still carry a
 * password assignment, a bearer token or a pasted private key. The rules are
 * the ones the codebase already applies, not a new set:
 *   - SECRET_OUTPUT_REDACTIONS (../secretRedaction.ts): PEM private-key
 *     blocks, AWS key ids, bearer tokens, JWTs, connection strings and
 *     `secret=`-style pairs — the rules the agent applies to script output;
 *   - SECRET_ASSIGNMENT_PATTERNS (../logRedaction.ts) and BARE_SECRET_PATTERNS
 *     (../aiToolOutput.ts): the assignment and vendor-token rules every AI tool
 *     result already passes through.
 *
 * The caller chooses the offset and size of each read, so redacting only the
 * returned bytes would let a read start just after `password=` or inside a key
 * body. Instead the device is asked for DIAGNOSTIC_REDACTION_CONTEXT_BYTES of
 * extra context on each side (diagnosticReadWindow), the rules run over that
 * whole window to find the byte spans they would redact, and every masked run
 * that overlaps the requested range is replaced by a marker. A private-key
 * body is also caught from its END line when its header is out of reach.
 * UTF-16 text (Windows logs) is scanned in both byte alignments as well.
 */
import { BARE_SECRET_PATTERNS } from '../aiToolOutput';
import { SECRET_ASSIGNMENT_PATTERNS } from '../logRedaction';
import { SECRET_OUTPUT_REDACTIONS } from '../secretRedaction';

/** Context read on each side of the requested range; matches the PEM block bound in secretRedaction.ts. */
export const DIAGNOSTIC_REDACTION_CONTEXT_BYTES = 16 * 1024;

const MARKER = Buffer.from('[REDACTED]', 'latin1');

type Rule = { pattern: RegExp; keepGroup1: boolean };

const RULES: readonly Rule[] = [
  ...SECRET_OUTPUT_REDACTIONS.map((r) => ({ pattern: r.pattern, keepGroup1: r.replacement.startsWith('$1') })),
  ...SECRET_ASSIGNMENT_PATTERNS.map((pattern) => ({ pattern, keepGroup1: true })),
  ...BARE_SECRET_PATTERNS.map((pattern) => ({ pattern, keepGroup1: false })),
].map((r) => ({
  // Private copies: a shared global RegExp carries lastIndex state.
  pattern: new RegExp(r.pattern.source, r.pattern.flags.includes('g') ? r.pattern.flags : `${r.pattern.flags}g`),
  keepGroup1: r.keepGroup1,
}));

const PEM_END = /-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const BASE64_OR_SPACE = /[A-Za-z0-9+/=\s]/;

/** The range to ask the device for, given the range the caller asked for. */
export function diagnosticReadWindow(offset: number, maxBytes: number): { offset: number; maxBytes: number } {
  const start = Math.max(0, offset - DIAGNOSTIC_REDACTION_CONTEXT_BYTES);
  return { offset: start, maxBytes: offset - start + maxBytes + DIAGNOSTIC_REDACTION_CONTEXT_BYTES };
}

/** [start, end) spans, in characters of `text`, that the rules redact. */
function secretSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const { pattern, keepGroup1 } of RULES) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      if (m[0].length === 0) continue;
      const start = m.index + (keepGroup1 && m[1] ? m[1].length : 0);
      if (start < m.index + m[0].length) spans.push([start, m.index + m[0].length]);
    }
  }
  // A key body whose BEGIN line is out of reach still ends in an END line:
  // walk back over the base64 body (linear; no backtracking regex).
  PEM_END.lastIndex = 0;
  for (const m of text.matchAll(PEM_END)) {
    let j = m.index;
    while (j > 0 && BASE64_OR_SPACE.test(text[j - 1]!)) j -= 1;
    spans.push([j, m.index + m[0].length]);
  }
  return spans;
}

/** Whether the window looks like UTF-16 text (many NUL bytes). */
function looksUtf16(bytes: Buffer): boolean {
  let nul = 0;
  for (const b of bytes) if (b === 0) nul += 1;
  return bytes.length >= 4 && nul * 5 >= bytes.length;
}

/** Per-byte mask of what the rules redact anywhere in `window`. */
function secretMask(window: Buffer): Uint8Array {
  const mask = new Uint8Array(window.length);
  // Byte-for-byte view: covers ASCII and UTF-8 text and text inside binaries.
  for (const [a, b] of secretSpans(window.toString('latin1'))) mask.fill(1, a, b);
  if (looksUtf16(window)) {
    for (const phase of [0, 1]) {
      const units = Math.floor((window.length - phase) / 2);
      let text = '';
      for (let i = 0; i < units; i += 1) {
        text += String.fromCharCode(window[phase + 2 * i]! | (window[phase + 2 * i + 1]! << 8));
      }
      for (const [a, b] of secretSpans(text)) mask.fill(1, phase + 2 * a, Math.min(window.length, phase + 2 * b));
    }
  }
  return mask;
}

/**
 * Returns `window[sliceStart, sliceStart + sliceLength)` with every redacted
 * run that overlaps it replaced by a marker, and whether anything was.
 */
export function redactDiagnosticWindow(
  window: Buffer,
  sliceStart: number,
  sliceLength: number,
): { bytes: Buffer; redacted: boolean } {
  const start = Math.min(Math.max(0, sliceStart), window.length);
  const end = Math.min(window.length, start + Math.max(0, sliceLength));
  if (end <= start) return { bytes: Buffer.alloc(0), redacted: false };
  const mask = secretMask(window);
  const parts: Buffer[] = [];
  let redacted = false;
  let i = start;
  while (i < end) {
    let j = i;
    if (mask[i]) {
      while (j < end && mask[j]) j += 1;
      parts.push(MARKER);
      redacted = true;
    } else {
      while (j < end && !mask[j]) j += 1;
      parts.push(window.subarray(i, j));
    }
    i = j;
  }
  return { bytes: Buffer.concat(parts), redacted };
}
