// Security threats list (`/security/vulnerabilities`) hash grammar:
//   #status=active&severity=critical
// Built on lib/hashParams.ts. Parsers ignore unknown keys / invalid values.
import { parseHashGrammar } from '../../lib/hashParams';

const THREAT_STATUSES = ['active', 'quarantined', 'removed'] as const;
const THREAT_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export interface ThreatsHashState {
  status: string;
  severity: string;
}

function first(values: string[] | undefined, allowed: readonly string[]): string {
  const v = values?.[0];
  return v && allowed.includes(v) ? v : '';
}

/** `hash` may carry the leading `#` or not (useHashState strips it). */
export function parseThreatsHash(hash: string): ThreatsHashState {
  const { params } = parseHashGrammar(hash, []);
  return {
    status: first(params.status, THREAT_STATUSES),
    severity: first(params.severity, THREAT_SEVERITIES),
  };
}

export function encodeThreatsHash(state: Partial<ThreatsHashState>): string {
  const parts: string[] = [];
  if (state.status) parts.push(`status=${encodeURIComponent(state.status)}`);
  if (state.severity) parts.push(`severity=${encodeURIComponent(state.severity)}`);
  return parts.length ? `#${parts.join('&')}` : '';
}
