import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { fetchWithAuth } from './auth';

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
  organizationId: string;
  name: string;
  address?: string;
  status: 'active' | 'inactive';
  deviceCount: number;
  createdAt: string;
}

interface OrgState {
  currentPartnerId: string | null;
  currentOrgId: string | null;
  currentSiteId: string | null;
  partners: Partner[];
  organizations: Organization[];
  sites: Site[];
  isLoading: boolean;
  error: string | null;

  // Actions
  setPartner: (partnerId: string) => void;
  setOrganization: (orgId: string) => void;
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
          organizations: [],
          sites: []
        });
        // Fetch organizations for the new partner
        get().fetchOrganizations();
      },

      setOrganization: (orgId) => {
        set({
          currentOrgId: orgId,
          currentSiteId: null,
          sites: []
        });
        // Fetch sites for the new organization
        get().fetchSites();
      },

      setSite: (siteId) => {
        set({ currentSiteId: siteId });
      },

      fetchPartners: async () => {
        set({ isLoading: true, error: null });
        try {
          const response = await fetchWithAuth('/partners');
          if (!response.ok) {
            throw new Error('Failed to fetch partners');
          }
          const data = await response.json();
          const partners = data.partners || data;
          set({
            partners,
            isLoading: false
          });

          // Auto-select first partner if none selected
          const { currentPartnerId } = get();
          if (!currentPartnerId && partners.length > 0) {
            get().setPartner(partners[0].id);
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
        if (!currentPartnerId) {
          set({ organizations: [] });
          return;
        }

        set({ isLoading: true, error: null });
        try {
          const response = await fetchWithAuth(`/organizations?partnerId=${currentPartnerId}`);
          if (!response.ok) {
            throw new Error('Failed to fetch organizations');
          }
          const data = await response.json();
          const organizations = data.organizations || data;
          set({
            organizations,
            isLoading: false
          });

          // Auto-select first organization if none selected
          const { currentOrgId } = get();
          if (!currentOrgId && organizations.length > 0) {
            get().setOrganization(organizations[0].id);
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
          const response = await fetchWithAuth(`/sites?organizationId=${currentOrgId}`);
          if (!response.ok) {
            throw new Error('Failed to fetch sites');
          }
          const data = await response.json();
          const sites = data.sites || data;
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
        currentSiteId: state.currentSiteId
      })
    }
  )
);

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
