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
  currentSiteId: string | null;
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

  // Actions
  setPartner: (partnerId: string) => void;
  /** Pass a non-empty orgId to select that org; pass '' or null to clear the
   * selection (currentOrgId → null, currentSiteId → null, allOrgs → true). */
  setOrganization: (orgId: string | null) => void;
  setSite: (siteId: string | null) => void;
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
      currentSiteId: null,
      allOrgs: false,
      lastOrgId: null,
      partners: [],
      organizations: [],
      sites: [],
      isLoading: false,
      error: null,

      setPartner: (partnerId) => {
        set({
          currentPartnerId: partnerId,
          currentOrgId: null,
          currentSiteId: null,
          // Switching partner resets to the default scope so the new partner's
          // first org gets auto-selected rather than landing in All-orgs.
          allOrgs: false,
          organizations: [],
          sites: []
        });
        // Fetch organizations for the new partner
        get().fetchOrganizations();
      },

      setOrganization: (orgId) => {
        // Falsy ('' or null) clears the selection entirely → explicit All-orgs.
        const resolved = orgId || null;
        set({
          currentOrgId: resolved,
          currentSiteId: null,
          sites: [],
          allOrgs: !resolved,
          // Remember the concrete org so the "Current" pill can return to it.
          ...(resolved ? { lastOrgId: resolved } : {})
        });
        // Fetch sites only when an org is actually selected.
        if (resolved) get().fetchSites();
      },

      setSite: (siteId) => {
        set({ currentSiteId: siteId });
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
          if ((!currentPartnerId || !cachedPartnerExists) && partners.length > 0) {
            get().setPartner(partners[0].id);
          } else if (currentPartnerId && !cachedPartnerExists) {
            get().clearOrgContext();
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
            isLoading: false
          });

          // Auto-select first organization if none selected or cached org no
          // longer exists — UNLESS the user explicitly chose All-orgs scope, in
          // which case currentOrgId is null on purpose and must stay that way
          // (otherwise the post-switch reload snaps back to the first org).
          const { currentOrgId, allOrgs } = get();
          const cachedOrgExists = currentOrgId && organizations.some((o: Organization) => o.id === currentOrgId);
          if (!allOrgs && (!currentOrgId || !cachedOrgExists) && organizations.length > 0) {
            get().setOrganization(organizations[0].id);
          } else if (currentOrgId && !cachedOrgExists) {
            // Cached org vanished with nothing to auto-select. Clear allOrgs too
            // so we don't persist a contradictory null (currentOrgId null while
            // allOrgs false would read as an explicit All-orgs choice elsewhere).
            set({ currentOrgId: null, currentSiteId: null, sites: [], allOrgs: false });
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
          currentSiteId: null,
          // Reset the persisted scope fields too, or a logout→login as a
          // different user inherits the prior user's All-orgs choice / stale
          // lastOrgId (both are persisted).
          allOrgs: false,
          lastOrgId: null,
          partners: [],
          organizations: [],
          sites: [],
          error: null
        });
      }
    }),
    {
      name: 'breeze-org',
      partialize: (state) => ({
        currentPartnerId: state.currentPartnerId,
        currentOrgId: state.currentOrgId,
        currentSiteId: state.currentSiteId,
        allOrgs: state.allOrgs,
        lastOrgId: state.lastOrgId
      })
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

// Helper to get current site details
export function getCurrentSite(): Site | null {
  const { currentSiteId, sites } = useOrgStore.getState();
  if (!currentSiteId) return null;
  return sites.find((site) => site.id === currentSiteId) || null;
}

// Helper to get current partner details
export function getCurrentPartner(): Partner | null {
  const { currentPartnerId, partners } = useOrgStore.getState();
  if (!currentPartnerId) return null;
  return partners.find((partner) => partner.id === currentPartnerId) || null;
}
