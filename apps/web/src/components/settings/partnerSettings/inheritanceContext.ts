import { createContext, useContext } from 'react';
import type { InheritanceBucket } from '@/lib/api/partnerSettingsInheritance';
import type { TabInheritanceState } from './useTabInheritance';

/**
 * What the per-field inheritance widgets (badge, inline line) need from the
 * partner settings shell (#9170 W4). Provided by `PartnerSettingsPage`; outside
 * it (a tab rendered on its own) badges still render from the catalog and the
 * inline lines render nothing.
 */
export type PartnerInheritanceUi = {
  /** The active tab's counts, or null when the tab has nothing to count. */
  tabState: TabInheritanceState | null;
  /** A saved (not draft) value from `partners.settings`, by catalog dot path. */
  savedSetting: (path: string) => unknown;
  /** The field has an unsaved draft, so its line describes the saved value. */
  isFieldDirty: (fieldId: string) => boolean;
  /** Open the org list behind one of the field's counts. */
  openDrill: (fieldId: string, bucket: InheritanceBucket) => void;
  /** The field whose org list is open, if any. */
  selectedFieldId: string | null;
};

export const PartnerInheritanceContext = createContext<PartnerInheritanceUi | null>(null);

export function usePartnerInheritance(): PartnerInheritanceUi | null {
  return useContext(PartnerInheritanceContext);
}

/** Dot-path read into a settings object (catalog paths are relative to `partners.settings`). */
export function readPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
