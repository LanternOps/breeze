// IOC scans page (`/security/scans`) hash grammar:
//
//   #scans | #threats | #sweeps[&group=<groupId>]
//
// Built on lib/hashParams.ts. The tab token comes first; `group` selects one
// sweep group on the Sweeps tab and means nothing elsewhere. Parsers ignore
// unknown keys and malformed values; the writer emits exactly `#<tab>` when no
// group applies (the page's tab buttons and their tests rely on that).
import { parseHashGrammar, writeHashKeys } from '../../lib/hashParams';

export const SCANS_TABS = ['scans', 'threats', 'sweeps'] as const;
export type ScansTab = (typeof SCANS_TABS)[number];

export interface ScansHashState {
  tab: ScansTab;
  /** Sweep group id; only ever set on the Sweeps tab. */
  group: string | null;
}

export const DEFAULT_SCANS_HASH_STATE: ScansHashState = { tab: 'scans', group: null };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `hash` may carry the leading `#` or not (useHashState strips it). */
export function parseScansHash(hash: string): ScansHashState {
  const { tab, params } = parseHashGrammar(hash, SCANS_TABS);
  if (tab !== 'sweeps') return { tab: (tab as ScansTab | null) ?? 'scans', group: null };
  const candidate = params.group?.[0];
  return { tab, group: candidate && GUID.test(candidate) ? candidate : null };
}

export function encodeScansHash(state: ScansHashState): string {
  const group = state.tab === 'sweeps' && state.group ? [state.group] : null;
  return writeHashKeys(`#${state.tab}`, { group }, SCANS_TABS);
}
