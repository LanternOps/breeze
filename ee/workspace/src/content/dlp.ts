/**
 * Workspace DLP engine — pure-TS scan/redact pipeline for text leaving the
 * workspace (chat prompts, content bodies, etc). No I/O; consumes the
 * DlpConfig produced by org settings (src/services/orgSettingsService.ts).
 *
 * Detector SEMANTICS are ported from the read-only reference at
 * ~/breeze/apps/api/src/services/clientAiDlp.ts and
 * ~/breeze/apps/api/src/services/clientAiDlpDetectors.ts (client-ai's DLP
 * chokepoint). Cross-repo import isn't possible (open-core boundary), so
 * this is a deliberate local reimplementation, not duplication to flag.
 * Detector names here use the workspace's DetectorId spelling
 * (credit_card / api_key, snake_case) rather than client-ai's camelCase.
 *
 * Order of operations mirrors the reference: scan every enabled detector
 * over the full text first (findings list is always complete), THEN decide
 * outcome — any 'block' match short-circuits redaction (the caller should
 * not persist/forward the text), otherwise 'redact' matches are replaced
 * with `[REDACTED:<detector>]` tokens (redaction is itself idempotent: a
 * re-scan of already-redacted output finds nothing) and 'log' matches are
 * recorded without touching the text. 'off' detectors are not scanned.
 */

import type { DetectorId, DlpAction, DlpConfig } from '../services/orgSettingsService';

export interface DlpFinding {
  detector: string;
  action: DlpAction;
  count: number;
}

export interface DlpTextResult {
  text: string;
  findings: DlpFinding[];
  blocked: boolean;
}

interface Match {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

interface CompiledRule {
  name: string;
  action: DlpAction;
  detect: (text: string) => Match[];
}

/** Merge overlapping/nested spans (sorted output). */
function mergeMatches(matches: Match[]): Match[] {
  if (matches.length <= 1) return matches;
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Match[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function spansOf(text: string, re: RegExp): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

// ── credit_card ──────────────────────────────────────────────────────────────
// 13–19 digits with optional single space/dash separators, Luhn-validated.
// Digit lookarounds pin both edges so runs of 20+ digits never match.
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

function luhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function detectCreditCard(text: string): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  return out;
}

// ── ssn ──────────────────────────────────────────────────────────────────────
const SSN_DASHED = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const SSN_BARE = /(?<![\d.-])\d{9}(?![\d.-])/g;
const SSN_CONTEXT = /\bssns?\b|social\s*security/i;

// Matches a redaction token this engine itself emits, e.g. `[REDACTED:ssn]`.
// `ssnContextPresent` must not treat that literal "ssn" (or any other
// detector name) as user-authored context, or a re-scan of already-redacted
// output would spuriously "discover" context and start flagging unrelated
// bare 9-digit numbers — breaking the documented idempotence invariant.
const REDACTION_TOKEN = /\[REDACTED:[^[\]]*\]/g;

/**
 * Blank out already-emitted `[REDACTED:...]` tokens before scanning, while
 * preserving string length/offsets so match positions still line up with
 * the original `text`. The space filler is neither a digit nor a
 * word character, so it can't itself satisfy any detector pattern or
 * the word-boundary checks the punctuation it replaces could.
 */
function maskRedactionTokens(text: string): string {
  return text.replace(REDACTION_TOKEN, (m) => ' '.repeat(m.length));
}

function ssnContextPresent(text: string): boolean {
  return SSN_CONTEXT.test(text);
}

function plausibleSsn(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  if (a === 0 || a === 666 || a >= 900) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

function detectSsn(text: string): Match[] {
  // Scan a copy with any prior [REDACTED:...] tokens masked out, so this
  // detector's own output can never leak context keywords or digit runs
  // back into itself on a re-scan (see maskRedactionTokens above).
  const scanText = maskRedactionTokens(text);
  const out: Match[] = [];
  for (const m of scanText.matchAll(SSN_DASHED)) {
    if (plausibleSsn(m[1]!, m[2]!, m[3]!)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  // Bare-9-digit matching only activates when an SSN keyword appears
  // somewhere in the text (avoids flagging arbitrary 9-digit IDs).
  if (ssnContextPresent(scanText)) {
    for (const m of scanText.matchAll(SSN_BARE)) {
      const v = m[0];
      if (plausibleSsn(v.slice(0, 3), v.slice(3, 5), v.slice(5))) {
        out.push({ start: m.index ?? 0, end: (m.index ?? 0) + v.length });
      }
    }
  }
  return mergeMatches(out);
}

// ── iban ─────────────────────────────────────────────────────────────────────
// Unspaced canonical IBAN shape. Spaced presentation is a documented non-goal.
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

/** ISO 13616 mod-97: move first 4 chars to the end, A→10..Z→35, remainder must be 1. */
function ibanMod97(candidate: string): boolean {
  const rearranged = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged[i]!;
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (let j = 0; j < value.length; j++) {
      const digit = value.charCodeAt(j) - 48;
      if (digit < 0 || digit > 9) return false;
      remainder = (remainder * 10 + digit) % 97;
    }
  }
  return remainder === 1;
}

function detectIban(text: string): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    if (ibanMod97(m[0])) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  return out;
}

// ── api_key ──────────────────────────────────────────────────────────────────
// Specific entropy-prefixed token shapes, plus generic bearer-ish blobs
// post-filtered for mixed character classes.
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bbrz_[0-9a-f]{32,64}\b/g,
];

const HEX_BLOB = /\b[0-9a-f]{32,128}\b/g;
const BASE64_BLOB = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,256}={0,2}(?![A-Za-z0-9+/=])/g;

function detectApiKey(text: string): Match[] {
  const out: Match[] = [];
  for (const re of API_KEY_PATTERNS) {
    out.push(...spansOf(text, re));
  }
  for (const m of text.matchAll(HEX_BLOB)) {
    const v = m[0];
    if (/\d/.test(v) && /[a-f]/.test(v)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + v.length });
    }
  }
  for (const m of text.matchAll(BASE64_BLOB)) {
    const v = m[0];
    if (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + v.length });
    }
  }
  // JWTs/keys often double-match the generic blobs — merge so counts are honest.
  return mergeMatches(out);
}

// ── email / phone (off by default) ───────────────────────────────────────────
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// NANP-ish with required separators or +country/parens. Bare 10-digit runs do
// NOT match (they'd collide with IDs and partial card runs).
const PHONE =
  /(?<![\d.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?![\d-])/g;

function detectEmail(text: string): Match[] {
  return spansOf(text, EMAIL);
}

function detectPhone(text: string): Match[] {
  return spansOf(text, PHONE);
}

const BUILTIN_DETECTORS: Array<[DetectorId, (text: string) => Match[]]> = [
  ['credit_card', detectCreditCard],
  ['ssn', detectSsn],
  ['iban', detectIban],
  ['api_key', detectApiKey],
  ['email', detectEmail],
  ['phone', detectPhone],
];

function compileRules(config: DlpConfig): CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const [name, detect] of BUILTIN_DETECTORS) {
    const action = config.detectors[name];
    if (action === 'off') continue;
    rules.push({ name, action, detect });
  }

  for (const custom of config.customPatterns) {
    if (custom.action === 'off') continue;
    let re: RegExp;
    try {
      re = new RegExp(custom.pattern, 'gu');
    } catch {
      // Malformed pattern: normalizeDlp() already rejects these at write
      // time, so this only guards out-of-band data. Skip rather than throw
      // — a pure scan function should not crash the caller.
      continue;
    }
    rules.push({
      name: custom.name,
      action: custom.action,
      detect: (text: string) => {
        const out: Match[] = [];
        for (const m of text.matchAll(re)) {
          // Zero-width matches (e.g. an all-optional custom group) carry no
          // redactable span; matchAll already advances past them safely on
          // its own, so skip and keep scanning rather than abandoning the
          // rest of the text.
          if (m[0].length === 0) continue;
          out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
        }
        return out;
      },
    });
  }
  return rules;
}

/** Replace spans right-to-left; overlapping spans merge, earliest span's rule labels the token. */
function replaceSpans(text: string, spans: Array<{ span: Match; rule: string }>): string {
  const sorted = [...spans].sort(
    (a, b) => a.span.start - b.span.start || a.span.end - b.span.end,
  );
  const merged: Array<{ start: number; end: number; rule: string }> = [];
  for (const { span, rule } of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end, rule });
    }
  }
  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const m = merged[i];
    if (!m) continue;
    out = `${out.slice(0, m.start)}[REDACTED:${m.rule}]${out.slice(m.end)}`;
  }
  return out;
}

/**
 * Scan `text` against every enabled detector/custom pattern in `config`.
 * Findings are always complete (the full scan runs before any short-circuit).
 * If any matched rule's action is 'block', redaction is skipped and the
 * original text is returned alongside `blocked: true` — the caller is
 * responsible for refusing to persist/forward it. Otherwise 'redact' matches
 * are replaced with `[REDACTED:<detector>]` tokens; 'log' matches are
 * recorded but leave the text untouched; 'off' detectors are never scanned.
 */
export function applyDlpToText(text: string, config: DlpConfig): DlpTextResult {
  const rules = compileRules(config);

  const matchesByRule: Array<{ rule: CompiledRule; spans: Match[] }> = [];
  for (const rule of rules) {
    const spans = rule.detect(text);
    if (spans.length > 0) matchesByRule.push({ rule, spans });
  }

  const findings: DlpFinding[] = matchesByRule.map(({ rule, spans }) => ({
    detector: rule.name,
    action: rule.action,
    count: spans.length,
  }));

  const blocked = matchesByRule.some(({ rule }) => rule.action === 'block');
  if (blocked) {
    return { text, findings, blocked: true };
  }

  const redactSpans: Array<{ span: Match; rule: string }> = [];
  for (const { rule, spans } of matchesByRule) {
    if (rule.action !== 'redact') continue;
    for (const span of spans) redactSpans.push({ span, rule: rule.name });
  }
  const outText = redactSpans.length > 0 ? replaceSpans(text, redactSpans) : text;

  return { text: outText, findings, blocked: false };
}
