// Vulnerability fleet page hash grammar (spec 2026-10-18 §3.2.1):
//
//   #<software|cves>[/<groupKey>][&status=open&severity=critical&kev=1&patchAvailable=1]
//
// Legacy bookmarks (`#software`, `#cves/<groupKey>`) parse unchanged. Built on
// lib/hashParams.ts; parsers ignore unknown keys and invalid values.
import { parseHashGrammar } from '../../lib/hashParams';
import type { VulnFleetFilters } from '../../lib/api/vulnerabilities';

export type VulnTab = 'software' | 'cves';
export const VULN_TABS: readonly VulnTab[] = ['software', 'cves'];

const STATUSES = ['open', 'accepted', 'mitigated', 'patched', 'all'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export type VulnHashFilters = Partial<Pick<VulnFleetFilters, 'status' | 'severity' | 'kevOnly' | 'patchAvailable'>>;

export interface ParsedVulnHash {
  tab: VulnTab | null;
  selection: string | null;
  /** null when the hash names no filter keys (so it never resets live filters). */
  filters: VulnHashFilters | null;
}

export function parseVulnHash(hash: string): ParsedVulnHash {
  const { tab, selection, params } = parseHashGrammar(hash, VULN_TABS);
  const filters: VulnHashFilters = {};
  const status = params.status?.[0];
  if (status && (STATUSES as readonly string[]).includes(status)) filters.status = status;
  const severity = params.severity?.[0];
  if (severity && (SEVERITIES as readonly string[]).includes(severity)) filters.severity = severity;
  if (params.kev?.[0] === '1') filters.kevOnly = true;
  if (params.patchAvailable?.[0] === '1') filters.patchAvailable = true;
  return {
    tab: tab as VulnTab | null,
    selection,
    filters: Object.keys(filters).length > 0 ? filters : null,
  };
}

export interface VulnHashInput {
  tab: VulnTab;
  status?: string;
  severity?: string;
  kev?: boolean;
  patchAvailable?: boolean;
}

/** Standalone href fragment for the dashboard links. */
export function encodeVulnHash(input: VulnHashInput): string {
  const parts: string[] = [encodeURIComponent(input.tab)];
  if (input.status) parts.push(`status=${encodeURIComponent(input.status)}`);
  if (input.severity) parts.push(`severity=${encodeURIComponent(input.severity)}`);
  if (input.kev) parts.push('kev=1');
  if (input.patchAvailable) parts.push('patchAvailable=1');
  return `#${parts.join('&')}`;
}
