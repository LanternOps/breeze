import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { fetchWithAuth, registerOrgIdProvider } from './auth';
import { isGlobalScopeRoute } from '../lib/routeScope';

export interface Partner {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
}

export interface Organization {
  id: string;
  partnerId: string;
  name: string;
  status: 'active' | 'trial' | 'suspended' | 'inactive';
  trialEndsAt?: string;
  createdAt: string;
}

export interface Site {
  id: string;
  orgId: string;
  name: string;
  address?: string;
  deviceCount: number;
  createdAt: string;
}

interface OrgState {
  currentPartnerId: string | null;
  currentOrgId: string | null;
  /**
   * True when the user has *explicitly* chosen the All-orgs scope via the
   * scope pill (currentOrgId is null on purpose), as opposed to the transient
   * null of a fresh session before the first org is auto-selected. This flag is
   * the difference: it suppresses the auto-select-first-org fallback in
   * `fetchOrganizations` so the All-orgs choice survives the post-switch reload
   * instead of silently snapping back to the first org.
   */
  allOrgs: boolean;
  /**
   * The last *concrete* org the user had selected. Lets the "Current" pill
   * button return to where they were when leaving All-orgs scope, instead of
   * arbitrarily jumping to the first org in the list.
   */
  lastOrgId: string | null;
  partners: Partner[];
  organizations: Organization[];
  sites: Site[];
  isLoading: boolean;
  error: string | null;
  /**
   * Flips true the first time `fetchOrganizations` completes successfully this
   * session (never persisted — resets each load). Lets consumers tell "the org
   * list hasn't loaded yet" apart from "it loaded and this partner has zero
   * orgs": both leave currentOrgId null with allOrgs false, but the first is a
   * transient skeleton state and the second is terminal. See `useOrgScope`.
   */
  organizationsLoaded: boolean;

  // Actions
  setPartner: (partnerId: string) => void;
  /** Seed currentPartnerId WITHOUT resetting the org context. For "we just
   * learned which partner this session belongs to" (JWT claims, first partner
   * fetch) — as opposed to setPartner's real partner switch, whose reset +
   * auto-select silently snaps the user to the first org. */
  adoptPartnerId: (partnerId: string) => void;
  /** Select a concrete organization (fetches its sites). */
  selectOrganization: (orgId: string) => void;
  /** Enter the explicit All-organizations (fleet) scope. */
  selectAllOrgs: () => void;
  /** Clear the selection WITHOUT asserting fleet intent — currentOrgId → null,
   * allOrgs → false (the transient/unresolved shape). For the vanished-org
   * path, not user-initiated. */
  resetSelection: () => void;
  /** Thin delegator kept for existing call sites: a non-empty orgId selects
   * that org, '' or null enters fleet view. Prefer the explicit
   * `selectOrganization` / `selectAllOrgs` in new code. */
  setOrganization: (orgId: string | null) => void;
  fetchPartners: () => Promise<void>;
  fetchOrganizations: () => Promise<void>;
  fetchSites: () => Promise<void>;
  clearOrgContext: () => void;
}

export const useOrgStore = create<OrgState>()(
  persist(
    (set, get) => ({
      currentPartnerId: null,
      currentOrgId: null,
      allOrgs: false,
      lastOrgId: null,
      partners: [],
      organizations: [],
      sites: [],
      isLoading: false,
      error: null,
      organizationsLoaded: false,

      setPartner: (partnerId) => {
        set({
          currentPartnerId: partnerId,
          currentOrgId: null,
          // Switching partner resets to the default scope so the new partner's
          // first org gets auto-selected rather than landing in All-orgs.
          allOrgs: false,
          organizations: [],
          // The new partner's org list hasn't loaded yet — back to the
          // "loading" shape until the refetch below resolves.
          organizationsLoaded: false,
          sites: []
        });
        // Fetch organizations for the new partner
        get().fetchOrganizations();
      },

      adoptPartnerId: (partnerId) => {
        set({ currentPartnerId: partnerId });
      },

      selectOrganization: (orgId) => {
        set({
          currentOrgId: orgId,
          sites: [],
          allOrgs: false,
          // Remember the concrete org so the "Current" pill can return to it.
          lastOrgId: orgId
        });
        get().fetchSites();
      },

      selectAllOrgs: () => {
        set({ currentOrgId: null, sites: [], allOrgs: true });
      },

      resetSelection: () => {
        // Clear WITHOUT asserting fleet intent: currentOrgId null + allOrgs
        // false is the transient/unresolved shape, distinct from an explicit
        // All-orgs choice.
        set({ currentOrgId: null, sites: [], allOrgs: false });
      },

      setOrganization: (orgId) => {
        // Falsy ('' or null) clears the selection entirely → explicit All-orgs.
        if (orgId) get().selectOrganization(orgId);
        else get().selectAllOrgs();
      },

      fetchPartners: async () => {
        set({ isLoading: true, error: null });
        try {
          const response = await fetchWithAuth('/orgs/partners');
          if (!response.ok) {
            throw new Error('Failed to fetch partners');
          }
          const data = await response.json();
          const partners = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.partners)
              ? data.partners
              : Array.isArray(data)
                ? data
                : [];
          set({
            partners,
            isLoading: false
          });

          // Auto-select first partner if none selected or cached partner no longer exists
          const { currentPartnerId } = get();
          const cachedPartnerExists = currentPartnerId && partners.some((p: Partner) => p.id === currentPartnerId);
          if (!currentPartnerId && partners.length > 0) {
            // First resolution of the partner id (typical single-partner login):
            // adopt it WITHOUT the setPartner reset. setPartner clears the org
            // selection and the allOrgs intent, and the subsequent auto-select
            // then snaps the user to the first org — so any page that fetched
            // partners (e.g. /settings/partner) silently hijacked whatever
            // context the user had chosen.
            get().adoptPartnerId(partners[0].id);
            get().fetchOrganizations();
          } else if (currentPartnerId && !cachedPartnerExists) {
            // The cached partner genuinely vanished — a real context change, so
            // the full reset (or clear when nothing to select) is correct.
            if (partners.length > 0) {
              get().setPartner(partners[0].id);
            } else {
              get().clearOrgContext();
            }
          }
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to fetch partners',
            isLoading: false
          });
        }
      },

      fetchOrganizations: async () => {
        const { currentPartnerId } = get();

        set({ isLoading: true, error: null });
        try {
          const params = currentPartnerId ? `?partnerId=${currentPartnerId}` : '';
          const response = await fetchWithAuth(`/orgs/organizations${params}`);
          if (!response.ok) {
            throw new Error('Failed to fetch organizations');
          }
          const data = await response.json();
          const organizations = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.organizations)
              ? data.organizations
              : Array.isArray(data)
                ? data
                : [];
          set({
            organizations,
            isLoading: false,
            // The list has now resolved for this session; a still-null org from
            // here on means "zero orgs", not "not loaded yet".
            organizationsLoaded: true
          });

          // Auto-select first organization if none selected or cached org no
          // longer exists — UNLESS the user explicitly chose All-orgs scope, in
          // which case currentOrgId is null on purpose and must stay that way
          // (otherwise the post-switch reload snaps back to the first org).
          const { currentOrgId, allOrgs } = get();
          const cachedOrgExists = currentOrgId && organizations.some((o: Organization) => o.id === currentOrgId);
          if (!allOrgs && (!currentOrgId || !cachedOrgExists) && organizations.length > 0) {
            get().selectOrganization(organizations[0].id);
          } else if (currentOrgId && !cachedOrgExists) {
            // Cached org vanished with nothing to auto-select. Reset to the
            // unresolved shape (allOrgs stays false) so we don't persist a
            // contradictory null that reads as an explicit All-orgs choice.
            get().resetSelection();
          }
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to fetch organizations',
            isLoading: false
          });
        }
      },

      fetchSites: async () => {
        const { currentOrgId } = get();
        if (!currentOrgId) {
          set({ sites: [] });
          return;
        }

        set({ isLoading: true, error: null });
        try {
          const response = await fetchWithAuth(`/orgs/sites?organizationId=${currentOrgId}`);
          if (!response.ok) {
            throw new Error('Failed to fetch sites');
          }
          const data = await response.json();
          const sites = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.sites)
              ? data.sites
              : Array.isArray(data)
                ? data
                : [];
          set({
            sites,
            isLoading: false
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to fetch sites',
            isLoading: false
          });
        }
      },

      clearOrgContext: () => {
        set({
          currentPartnerId: null,
          currentOrgId: null,
          // Reset the persisted scope fields too, or a logout→login as a
          // different user inherits the prior user's All-orgs choice / stale
          // lastOrgId (both are persisted).
          allOrgs: false,
          lastOrgId: null,
          partners: [],
          organizations: [],
          organizationsLoaded: false,
          sites: [],
          error: null
        });
      }
    }),
    {
      name: 'breeze-org',
      // currentSiteId is intentionally no longer part of this state: the global
      // site selection only ever filtered data on Discovery; two enrollment
      // forms (AddDeviceModal, EnrollmentKeyManager) merely read it as a default
      // site. So site handling moved into the pages that support it, and
      // dropping it from partialize discards any stale persisted value.
      partialize: (state) => ({
        currentPartnerId: state.currentPartnerId,
        currentOrgId: state.currentOrgId,
        allOrgs: state.allOrgs,
        lastOrgId: state.lastOrgId
      }),
      // Normalize a contradictory persisted pair on rehydrate. A concrete org
      // selection wins over a stale allOrgs flag (an older schema or tampered
      // localStorage could persist both). useOrgScope's precedence rule papers
      // over this too, but only for hook consumers — fix it at the source so
      // raw `allOrgs` readers can't observe the contradiction either.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<OrgState> | undefined) };
        if (merged.currentOrgId && merged.allOrgs) merged.allOrgs = false;
        return merged;
      }
    }
  )
);

// Page-aware org scoping: on a global (catalog) route the selector does not
// apply, so inject no orgId; on a scoped route inject the selected org. The
// pathname is read at call time so it tracks Astro client-side navigation.
registerOrgIdProvider(() => {
  if (typeof window !== 'undefined' && isGlobalScopeRoute(window.location.pathname)) {
    return null;
  }
  return useOrgStore.getState().currentOrgId;
});

// Helper to get current organization details
export function getCurrentOrganization(): Organization | null {
  const { currentOrgId, organizations } = useOrgStore.getState();
  if (!currentOrgId) return null;
  return organizations.find((org) => org.id === currentOrgId) || null;
}

// Helper to get current partner details
export function getCurrentPartner(): Partner | null {
  const { currentPartnerId, partners } = useOrgStore.getState();
  if (!currentPartnerId) return null;
  return partners.find((partner) => partner.id === currentPartnerId) || null;
}
