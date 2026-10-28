import { useEffect } from 'react';
import { create } from 'zustand';
import { catalogForTab, isCatalogTabKey, type CatalogTabKey } from '@breeze/shared';
import { fetchTabInheritance, type TabInheritanceResult } from '@/lib/api/partnerSettingsInheritance';
import { useAuthStore } from '../../../stores/auth';
import type { TabKey } from './tabRegistry';

/**
 * Per-tab inheritance counts for the partner settings page (#9170 W4, spec
 * §5.6): fetched lazily for the active tab, cached for the page session, and
 * refetched for a unit's tabs after that unit saves.
 *
 * Page-scoped and never persisted, like the draft store: the page calls
 * `reset()` on unmount and `setPartner()` on a partner switch. A response that
 * lands after its entry was replaced (invalidate, reset, partner switch) is
 * ignored, so an older answer never overwrites a newer one.
 *
 * An invalidated entry keeps its last answer, marked stale, until the refetch
 * lands, so the lines do not blink out after a save. A failed read
 * (`unavailable`) is retried the next time its tab is opened.
 */
export type TabInheritanceState = { status: 'loading' } | TabInheritanceResult;

type Entry = { state: TabInheritanceState; token: object; stale: boolean };

type InheritanceStore = {
  partnerId: string | null;
  entries: Partial<Record<CatalogTabKey, Entry>>;
  /** Bumped by every invalidate: an open org list re-reads when it changes. */
  revision: number;
  setPartner: (partnerId: string | null) => void;
  reset: () => void;
  invalidate: (tabs: readonly string[]) => void;
  /** Drop failed reads, so the next view of their tab retries (called on a tab change). */
  dropUnavailable: () => void;
};

export const useInheritanceStore = create<InheritanceStore>((set, get) => ({
  partnerId: null,
  entries: {},
  revision: 0,
  setPartner: partnerId => {
    if (get().partnerId === partnerId) return;
    set({ partnerId, entries: {} });
  },
  reset: () => set({ partnerId: null, entries: {}, revision: 0 }),
  invalidate: tabs => {
    const drop = tabs.filter(isCatalogTabKey);
    if (drop.length === 0) return;
    set(s => {
      const entries = { ...s.entries };
      for (const tab of drop) {
        const entry = entries[tab];
        if (entry) entries[tab] = { ...entry, stale: true };
      }
      return { entries, revision: s.revision + 1 };
    });
  },
  dropUnavailable: () => {
    const { entries } = get();
    const failed = (Object.keys(entries) as CatalogTabKey[]).filter(tab => entries[tab]?.state.status === 'unavailable');
    if (failed.length === 0) return;
    set(s => {
      const next = { ...s.entries };
      for (const tab of failed) delete next[tab];
      return { entries: next };
    });
  },
}));

/** Called by the header Save after a unit saved: its tabs' counts are stale. */
export function invalidateInheritance(tabs: readonly TabKey[]): void {
  useInheritanceStore.getState().invalidate(tabs);
}

/**
 * The catalog tab to fetch for a page tab, or null. A tab whose catalog
 * entries are all `unclassified` has nothing to badge or count, so it never fetches.
 */
export function inheritanceTabFor(tab: TabKey): CatalogTabKey | null {
  if (!isCatalogTabKey(tab)) return null;
  return catalogForTab(tab).some(entry => entry.kind !== 'unclassified') ? tab : null;
}

const RESTRICTED: TabInheritanceState = { status: 'restricted' };
const LOADING: TabInheritanceState = { status: 'loading' };

async function load(tab: CatalogTabKey): Promise<void> {
  const token = {};
  // A stale entry keeps showing its last answer while the refetch runs.
  useInheritanceStore.setState(s => {
    const previous = s.entries[tab];
    const state = previous?.stale ? previous.state : LOADING;
    return { entries: { ...s.entries, [tab]: { state, token, stale: false } } };
  });
  const result = await fetchTabInheritance(tab);
  if (useInheritanceStore.getState().entries[tab]?.token !== token) return;
  useInheritanceStore.setState(s => ({ entries: { ...s.entries, [tab]: { state: result, token, stale: false } } }));
}

/**
 * The counts for `tab` (null when there is no tab). A user without full
 * partner org access short-circuits to `restricted` and never fetches: the
 * route would answer 403 for them anyway.
 */
export function useTabInheritance(tab: CatalogTabKey | null): TabInheritanceState | null {
  const restricted = useAuthStore(s => s.user?.canManagePartnerWide) === false;
  const entry = useInheritanceStore(s => (tab ? s.entries[tab] : undefined));
  const needsFetch = !entry || entry.stale;

  useEffect(() => {
    if (!tab || restricted || !needsFetch) return;
    void load(tab);
  }, [tab, restricted, needsFetch]);

  if (!tab) return null;
  if (restricted) return RESTRICTED;
  return entry?.state ?? LOADING;
}
