import { useCallback, useState } from 'react';
import type { TFunction } from 'i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import type { Site } from './SiteList';

/**
 * Site CRUD state + handlers, extracted verbatim from `OrganizationsPage`
 * (#5075 W02) so the organization record's Sites tab (`OrgSitesTab`) can share
 * the exact same behaviour instead of re-implementing it.
 *
 * Same URLs, same `runAction` error fallbacks, same `ActionError` catch
 * pattern as the page it was extracted from. The one addition is
 * `orgIdOverride: orgId` on the sites GET, so a caller inside the record page
 * (whose org can differ from the OrgSwitcher's ambient scope) always reads
 * the RIGHT org's sites rather than whatever the switcher happens to point at.
 * `OrganizationsPage` is unaffected: there, `orgId` passed in already IS the
 * organization whose sites are being listed, so pinning it explicitly is a
 * no-op change in observable behaviour.
 */
export type SiteModalMode = 'closed' | 'add' | 'edit' | 'delete';

export interface SiteFormDefaults {
  name: string;
  timezone?: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

export interface UseSiteCrud {
  sites: Site[];
  sitesLoading: boolean;
  siteSubmitting: boolean;
  siteModalMode: SiteModalMode;
  selectedSite: Site | null;
  guidingFirstSite: boolean;
  setGuidingFirstSite: (v: boolean) => void;
  /**
   * Returns the fetched site list, or null when the count couldn't be
   * determined (failed request or a malformed 200 body) — see
   * `OrganizationsPage`'s original `fetchSites` for why this distinction
   * matters to first-site guidance callers.
   *
   * Accepts an optional org id override for the one caller that must fetch a
   * DIFFERENT org's sites than the one this hook was instantiated with: right
   * after creating an organization, `OrganizationsPage` fetches the brand-new
   * org's sites before its own `setSelectedOrg` state update has re-rendered
   * this hook with the new id.
   */
  refresh: (orgIdOverride?: string) => Promise<Site[] | null>;
  /** Resets the visible list to empty without a network request — used when
   *  switching to an org whose sites must not be fetched (an archive-lifecycle
   *  org, or no org selected at all). */
  clear: () => void;
  openAdd: () => void;
  openEdit: (site: Site) => void;
  openDelete: (site: Site) => void;
  close: () => void;
  submit: (values: Record<string, unknown>) => Promise<void>;
  confirmDelete: () => Promise<void>;
  getSiteFormDefaults: (
    site: Site & { address?: Record<string, string>; contact?: Record<string, string> },
  ) => SiteFormDefaults;
}

export interface UseSiteCrudOptions {
  onUnauthorized: () => void;
  t: TFunction;
}

export function useSiteCrud(orgId: string | null, opts: UseSiteCrudOptions): UseSiteCrud {
  const { onUnauthorized, t } = opts;
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [siteModalMode, setSiteModalMode] = useState<SiteModalMode>('closed');
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [siteSubmitting, setSiteSubmitting] = useState(false);
  const [guidingFirstSite, setGuidingFirstSite] = useState(false);

  const refresh = useCallback(
    async (orgIdOverride?: string): Promise<Site[] | null> => {
      const targetOrgId = orgIdOverride ?? orgId;
      if (!targetOrgId) return null;
      setSitesLoading(true);
      try {
        const response = await fetchWithAuth(`/orgs/sites?organizationId=${targetOrgId}`, {
          orgIdOverride: targetOrgId,
        });
        if (!response.ok) throw new Error(`Failed to fetch sites (status ${response.status})`);
        const data = await response.json();
        const siteList = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : null;
        if (siteList === null) {
          // 200 OK but the body isn't a parseable array of sites — fail closed so
          // callers suppress the first-site nag rather than treat this as
          // confirmed zero.
          setSites([]);
          // Message text is pinned by `OrganizationsPage.firstSite.test.tsx`,
          // which predates this hook's extraction — kept verbatim (including
          // the `[OrganizationsPage]` prefix) rather than renamed to
          // `[useSiteCrud]`, since this IS still that page's first-site
          // detection path, only relocated.
          console.warn('[OrganizationsPage] sites response was ok but not a parseable array for org', targetOrgId, data);
          return null;
        }
        setSites(siteList);
        return siteList;
      } catch (err) {
        setSites([]);
        console.warn('[OrganizationsPage] failed to fetch sites for org', targetOrgId, err);
        return null;
      } finally {
        setSitesLoading(false);
      }
    },
    [orgId],
  );

  const clear = useCallback(() => setSites([]), []);

  const openAdd = useCallback(() => {
    setSelectedSite(null);
    setSiteModalMode('add');
  }, []);

  const openEdit = useCallback((site: Site) => {
    setSelectedSite(site);
    setSiteModalMode('edit');
  }, []);

  const openDelete = useCallback((site: Site) => {
    setSelectedSite(site);
    setSiteModalMode('delete');
  }, []);

  const close = useCallback(() => {
    setSiteModalMode('closed');
    setSelectedSite(null);
    setGuidingFirstSite(false);
  }, []);

  const surfaceUnexpectedError = useCallback(
    (err: unknown) => {
      // runAction already surfaced an ActionError as a toast, and onUnauthorized
      // handles 401. Only a non-ActionError escape is unsurfaced here — see
      // OrganizationsPage's original handlers for the full reasoning (the page
      // banner these once fell back to renders behind the still-open modal).
      if (!(err instanceof ActionError)) {
        showToast({
          message: err instanceof Error ? err.message : t('settings:organizationsPage.errors.generic'),
          type: 'error',
        });
      }
    },
    [t],
  );

  const submit = useCallback(
    async (values: Record<string, unknown>) => {
      if (!orgId) return;
      setSiteSubmitting(true);
      try {
        const payload = {
          orgId,
          name: values.name,
          timezone: values.timezone,
          address: {
            line1: values.addressLine1,
            line2: values.addressLine2,
            city: values.city,
            state: values.state,
            postalCode: values.postalCode,
            country: values.country,
          },
          contact: {
            name: values.contactName,
            email: values.contactEmail,
            phone: values.contactPhone,
          },
        };

        const url = siteModalMode === 'edit' && selectedSite ? `/orgs/sites/${selectedSite.id}` : '/orgs/sites';
        const method = siteModalMode === 'edit' ? 'PATCH' : 'POST';

        await runAction({
          request: () => fetchWithAuth(url, { method, body: JSON.stringify(payload) }),
          // `organizationsPage.errors.saveSite` interpolates {{status}}, which
          // runAction does not expose when building the fallback — this is the
          // existing status-free sibling, present in all 8 locales.
          errorFallback: t('settings:siteDetailPage.errors.saveSite'),
          onUnauthorized,
        });

        await refresh();
        close();
      } catch (err) {
        surfaceUnexpectedError(err);
      } finally {
        setSiteSubmitting(false);
      }
    },
    [orgId, siteModalMode, selectedSite, refresh, close, onUnauthorized, t, surfaceUnexpectedError],
  );

  const confirmDelete = useCallback(async () => {
    if (!selectedSite || !orgId) return;
    setSiteSubmitting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/orgs/sites/${selectedSite.id}`, { method: 'DELETE' }),
        errorFallback: t('settings:organizationsPage.errors.deleteSite'),
        onUnauthorized,
      });

      await refresh();
      close();
    } catch (err) {
      surfaceUnexpectedError(err);
    } finally {
      setSiteSubmitting(false);
    }
  }, [selectedSite, orgId, refresh, close, onUnauthorized, t, surfaceUnexpectedError]);

  const getSiteFormDefaults = useCallback(
    (site: Site & { address?: Record<string, string>; contact?: Record<string, string> }): SiteFormDefaults => ({
      name: site.name,
      timezone: site.timezone,
      addressLine1: site.address?.line1 ?? '',
      addressLine2: site.address?.line2 ?? '',
      city: site.address?.city ?? '',
      state: site.address?.state ?? '',
      postalCode: site.address?.postalCode ?? '',
      country: site.address?.country ?? '',
      contactName: site.contact?.name ?? '',
      contactEmail: site.contact?.email ?? '',
      contactPhone: site.contact?.phone ?? '',
    }),
    [],
  );

  return {
    sites,
    sitesLoading,
    siteSubmitting,
    siteModalMode,
    selectedSite,
    guidingFirstSite,
    setGuidingFirstSite,
    refresh,
    clear,
    openAdd,
    openEdit,
    openDelete,
    close,
    submit,
    confirmDelete,
    getSiteFormDefaults,
  };
}
