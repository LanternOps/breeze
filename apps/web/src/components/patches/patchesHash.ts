// Patches page hash grammar (spec 2026-10-18 §3.2.1):
//
//   #<tab>[/<selection>][&status=<compliance status>]
//
// Tabs: compliance (default, empty hash), patches (`#patches/<patchId>` opens
// the details drawer), rings, jobs. `#compliance&status=failed` and
// `#status=failed` mean the same thing: the compliance tab is the default.
// Built on the shared parser/writer in lib/hashParams.ts; writers preserve keys
// they don't own and parsers ignore unknown keys and invalid values.
import { parseHashGrammar, writeHashKeys } from '../../lib/hashParams';

export const PATCHES_TABS = ['rings', 'patches', 'compliance', 'jobs'] as const;
export type PatchesTab = (typeof PATCHES_TABS)[number];

/**
 * The compliance device-list filters, as both the hash and the
 * `GET /patches/compliance?status=` param spell them. `all` is the absence of
 * the key.
 */
export const COMPLIANCE_STATUS_FILTERS = [
  'needs-patches',
  'compliant',
  'failed',
  'critical',
  'reboot',
  'third-party',
] as const;
export type ComplianceStatusFilter = (typeof COMPLIANCE_STATUS_FILTERS)[number];
export type ComplianceStatusSelection = ComplianceStatusFilter | 'all';

export interface PatchesHashState {
  tab: PatchesTab | null;
  selection: string | null;
  status: ComplianceStatusFilter | null;
}

function pickStatus(values: string[] | undefined): ComplianceStatusFilter | null {
  const first = values?.[0];
  return first && (COMPLIANCE_STATUS_FILTERS as readonly string[]).includes(first)
    ? (first as ComplianceStatusFilter)
    : null;
}

/** `hash` may carry the leading `#` or not (useHashState strips it). */
export function parsePatchesHash(hash: string): PatchesHashState {
  const { tab, selection, params } = parseHashGrammar(hash, PATCHES_TABS);
  return { tab: tab as PatchesTab | null, selection, status: pickStatus(params.status) };
}

/** A standalone compliance-tab hash for a link: `#compliance[&status=…]`. */
export function encodePatchesHash(state: { status?: ComplianceStatusFilter }): string {
  return writeHashKeys('#compliance', { status: state.status ? [state.status] : null }, PATCHES_TABS);
}

/** Rewrite only `status` (`all` removes it) and keep everything else in `currentHash`. */
export function mergePatchesHash(currentHash: string, patch: { status: ComplianceStatusSelection }): string {
  return writeHashKeys(
    currentHash,
    { status: patch.status === 'all' ? null : [patch.status] },
    PATCHES_TABS,
  );
}
