import { CATALOG_BY_ID } from '@breeze/shared';
import { readPath } from './inheritanceContext';
import type { PartnersMeState } from './usePartnersMeUnit';

/**
 * Catalog paths are relative to `partners.settings`; the page's form state
 * renames one branch (`remoteAccessProviders` is held as `remoteAccess`).
 */
export function draftPath(catalogPath: string): string {
  return catalogPath.startsWith('remoteAccessProviders.')
    ? `remoteAccess.${catalogPath.slice('remoteAccessProviders.'.length)}`
    : catalogPath;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The field's draft differs from its saved baseline at any of its catalog paths. */
export function isFieldDraftDirty(
  fieldId: string,
  state: PartnersMeState | null,
  baseline: PartnersMeState | null,
): boolean {
  const entry = CATALOG_BY_ID[fieldId];
  if (!entry || !state || !baseline) return false;
  return entry.paths.some(path => !same(readPath(state, draftPath(path)), readPath(baseline, draftPath(path))));
}
