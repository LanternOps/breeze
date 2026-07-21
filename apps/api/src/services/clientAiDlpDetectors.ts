/**
 * Built-in DLP detectors for Breeze AI for Office (spec §6).
 *
 * Pure functions: string in → match spans out. Validation gates (Luhn for
 * cards, mod-97 for IBAN, plausibility for SSN, mixed-class post-filters for
 * generic token blobs) keep false positives down; the residual trade-offs are
 * documented per detector in the Plan-3 doc
 * (docs/superpowers/plans/ai-mcp/2026-06-12-ai-for-office-3-dlp.md, Tasks 2–3).
 *
 * The apiKey shapes are seeded from BARE_SECRET_PATTERNS in
 * services/aiToolOutput.ts (sk-, GitHub token family, github_pat_, AKIA, JWT)
 * plus Breeze brz_ tokens (services/apiKeys.ts generates brz_ + 48 hex) and
 * generic 32+ char hex/base64 bearer-ish blobs.
 *
 * (services/aiInputSanitizer.ts was reviewed as a seed source per spec §6:
 * its patterns target prompt-injection/Unicode, not PII/secrets, so nothing
 * is reused from it — the secret shapes above come from aiToolOutput.ts.)
 */

export interface DlpMatch {
  /** Inclusive start offset in the scanned string. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** Merge overlapping/nested spans (sorted output). Used per-detector and by the engine. */
export function mergeMatches(matches: DlpMatch[]): DlpMatch[] {
  if (matches.length <= 1) return matches;
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: DlpMatch[] = [{ ...sorted[0]! }];
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

function spansOf(text: string, re: RegExp): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

// ── creditCard ───────────────────────────────────────────────────────────────
// 13–19 digits with optional single space/dash separators, Luhn-validated.
// The digit lookarounds pin BOTH edges, so runs of 20+ digits never match —
// not even a sub-span (long numeric IDs are safe).
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

export function luhnCheck(digits: string): boolean {
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

export function detectCreditCard(text: string): DlpMatch[] {
  const out: DlpMatch[] = [];
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

/** Engine computes this over the WHOLE payload to activate bare-9-digit matching. */
export function ssnContextPresent(text: string): boolean {
  return SSN_CONTEXT.test(text);
}

function plausibleSsn(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  if (a === 0 || a === 666 || a >= 900) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

export function detectSsn(text: string, bareContextActive: boolean): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const m of text.matchAll(SSN_DASHED)) {
    if (plausibleSsn(m[1]!, m[2]!, m[3]!)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  if (bareContextActive) {
    for (const m of text.matchAll(SSN_BARE)) {
      const v = m[0];
      if (plausibleSsn(v.slice(0, 3), v.slice(3, 5), v.slice(5))) {
        out.push({ start: m.index ?? 0, end: (m.index ?? 0) + v.length });
      }
    }
  }
  return mergeMatches(out);
}

// ── iban ─────────────────────────────────────────────────────────────────────
// Unspaced canonical IBAN shape (spec §6 pattern). Spaced presentation
// ("DE89 3704 ...") is a documented v1 non-goal.
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

/** ISO 13616 mod-97: move first 4 chars to the end, A→10..Z→35, remainder must be 1. */
export function ibanMod97(candidate: string): boolean {
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

export function detectIban(text: string): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    if (ibanMod97(m[0])) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  return out;
}

// ── apiKey ───────────────────────────────────────────────────────────────────
// Specific token shapes — seeded from BARE_SECRET_PATTERNS in
// services/aiToolOutput.ts, plus Breeze brz_ tokens (services/apiKeys.ts).
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bbrz_[0-9a-f]{32,64}\b/g,
];

// Bearer-ish generic blobs: 32+ char hex / base64 runs, post-filtered for
// mixed character classes so plain words and plain numbers never match.
// Residual FP: 32+ char mixed-case alphanumeric identifiers will match —
// accepted (spec asks for bearer-ish blobs; action is redact by default and
// the MSP can set apiKey to 'off').
const HEX_BLOB = /\b[0-9a-f]{32,128}\b/g;
const BASE64_BLOB = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,256}={0,2}(?![A-Za-z0-9+/=])/g;

export function detectApiKey(text: string): DlpMatch[] {
  const out: DlpMatch[] = [];
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
// NOT match (precision-first — they collide with IDs and partial card runs).
const PHONE =
  /(?<![\d.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?![\d-])/g;

export function detectEmail(text: string): DlpMatch[] {
  return spansOf(text, EMAIL);
}

export function detectPhone(text: string): DlpMatch[] {
  return spansOf(text, PHONE);
}
