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
 * Parse ONE `method=result` verdict out of a trusted Authentication-Results value,
 * clause by clause. RFC 8601 allows CFWS comments in parentheses and trailing
 * properties; we strip parenthesised comments per clause and read only the leading
 * `method=result` token, so `spf=pass (dmarc=pass); dmarc=fail` correctly yields
 * dmarc=fail (not the value hidden inside the spf clause's comment).
 */
/** Remove CFWS comments (RFC 5322 parentheses, which may NEST and may contain
 * semicolons) so they cannot smuggle a fake clause boundary or verdict. Must run
 * BEFORE splitting on ';' — a comment like `(explanation; dmarc=pass)` otherwise
 * survives a naive split-then-strip and forges a pass. */
export function stripComments(s: string): string {
  let out = '';
  let depth = 0;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; } // drop the escaped char (inside a comment)
    if (depth > 0 && ch === '\\') { escaped = true; continue; } // RFC 5322 quoted-pair: \) is a literal ')', not a terminator
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { if (depth > 0) depth--; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

export function mechanism(authResults: string | undefined, name: string): string | undefined {
  if (!authResults) return undefined;
  // Strip comments FIRST, then split into clauses and drop the authserv-id.
  const clauses = stripComments(authResults).split(';').slice(1);
  for (const clause of clauses) {
    const m = /^\s*([A-Za-z][\w-]*)\s*=\s*(\w+)/.exec(clause);
    if (m && m[1] && m[1].toLowerCase() === name.toLowerCase()) return m[2];
  }
  return undefined;
}

export interface AuthClause {
  method: string;
  result: string;
  /** Lowercased property values such as `header.from`; null when one appears twice
   * with different values, so a conflicting pair can never satisfy a comparison. */
  props: Map<string, string | null>;
}

/** Every `method=result` clause with its properties, comments stripped first. */
export function parseAuthClauses(authResults: string | undefined): AuthClause[] {
  if (!authResults) return [];
  const clauses: AuthClause[] = [];
  for (const clause of stripComments(authResults).split(';').slice(1)) {
    const head = /^\s*([A-Za-z][\w-]*)\s*=\s*(\w+)/.exec(clause);
    if (!head?.[1] || !head[2]) continue;
    const props = new Map<string, string | null>();
    for (const m of clause.slice(head[0].length).matchAll(/([A-Za-z][\w.-]*)\s*=\s*("[^"]*"|[^\s;]+)/g)) {
      const name = m[1]!.toLowerCase();
      const value = m[2]!.replace(/^"|"$/g, '').toLowerCase();
      props.set(name, props.has(name) && props.get(name) !== value ? null : value);
    }
    clauses.push({ method: head[1].toLowerCase(), result: head[2], props });
  }
  return clauses;
}

/** Always returns a full SenderAuth (fail-closed). verified iff DMARC passed. */
export function buildSenderAuth(authResults: string | undefined): SenderAuth {
  const spf = normalizeVerdict(mechanism(authResults, 'spf'));
  const dkim = normalizeVerdict(mechanism(authResults, 'dkim'));
  const dmarc = normalizeVerdict(mechanism(authResults, 'dmarc'));
  return { spf, dkim, dmarc, verified: dmarc === 'pass' };
}
