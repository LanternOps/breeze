import { useState, useEffect, useCallback, useMemo, useRef, type DragEvent } from 'react';
import { useHashState } from '@/lib/useHashState';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from './OrganizationList';
import OrganizationForm from './OrganizationForm';
import SiteList, { type Site } from './SiteList';
import SiteForm from './SiteForm';
import BulkOrgImport from '../organizations/BulkOrgImport';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { extractApiError } from '@/lib/apiError';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete';
type SiteModalMode = 'closed' | 'add' | 'edit' | 'delete';

type OrganizationFormValues = {
  name: string;
  slug: string;
  type: 'customer' | 'internal';
  status: 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding';
  maxDevices: number;
  contractStart?: string;
  contractEnd?: string;
};

/**
 * Whether the org card should render its `{{count}} devices` label.
 *
 * The count is absent for organization-scoped callers — that branch of
 * `GET /orgs/organizations` returns a deliberately minimal projection. Rendering
 * the label anyway interpolated `undefined` and produced a bare " devices",
 * which reads as a loading bug or an empty tenant (#3699). `0` is a real value
 * and must render, so this cannot be a truthiness check.
 *
 * Exported for test, like `fetchAllOrganizations` below it.
 */
export function shouldShowDeviceCount(count: number | undefined): boolean {
  return typeof count === 'number' && Number.isFinite(count);
}

// Exported for test — see OrganizationsPage.statusMaps.test.tsx.
export const statusLabelKeys: Record<Organization['status'], string> = {
  active: 'organizationsPage.status.active',
  trial: 'organizationsPage.status.trial',
  suspended: 'organizationsPage.status.suspended',
  churned: 'organizationsPage.status.churned',
  offboarding: 'organizationsPage.status.offboarding',
  merging: 'organizationsPage.status.merging',
  archived: 'organizationsPage.status.archived',
  purging: 'organizationsPage.status.purging',
};

export const statusColors: Record<Organization['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  trial: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  suspended: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  churned: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  offboarding: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400',
  merging: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  archived: 'border-gray-500/30 bg-gray-500/10 text-gray-700 dark:text-gray-400',
  purging: 'border-red-400/30 bg-red-400/10 text-red-600 dark:text-red-300',
};

// Walking every page of GET /orgs/organizations moved to lib/ (#3446 follow-up)
// so the org-switcher store — a second reader with the same first-50 truncation
// — can share it without importing this page component. Re-exported here to
// keep this page the documented home of the pagination contract and its tests.
export {
  fetchAllOrganizations,
  ORGANIZATIONS_PAGE_SIZE,
  ORGANIZATIONS_MAX_PAGES,
} from '../../lib/fetchAllOrganizations';
import { fetchAllOrganizations } from '../../lib/fetchAllOrganizations';

export default function OrganizationsPage() {
  const { t } = useTranslation('settings');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  // Deep-linked org id adopted post-mount (#2421); later hash writes are
  // harmless because the consumer effect only fires while nothing is selected.
  const [initialOrgId] = useHashState<string | null>(null, (h) => h || undefined);
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [draggedOrgId, setDraggedOrgId] = useState<string | null>(null);
  /**
   * True from the moment a reorder PATCH is issued until its reconciliation
   * settles. Dragging is disabled meanwhile, which SERIALIZES reorders: every
   * stale-order race on this page needs a second drag to start while the first
   * request (or its reconciling GET) is still in flight, so removing that
   * overlap removes the class rather than guarding each instance.
   *
   * Before this change the overlap was blocked only as a side effect of the
   * full-page loading spinner unmounting the draggable rows — which the silent
   * reconciliation above deliberately no longer does.
   */
  const [reorderPending, setReorderPending] = useState(false);
  const [dragOverOrgId, setDragOverOrgId] = useState<string | null>(null);

  // Sites state
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [siteModalMode, setSiteModalMode] = useState<SiteModalMode>('closed');
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [siteSubmitting, setSiteSubmitting] = useState(false);
  // True when the site-add modal was auto-opened right after creating an org —
  // drives first-site guidance copy and a Skip-for-now affordance.
  const [guidingFirstSite, setGuidingFirstSite] = useState(false);
  // Partner's configured timezone, used to pre-select the timezone for new sites
  // instead of falling back to UTC. Undefined until loaded / if unavailable.
  const [partnerTimezone, setPartnerTimezone] = useState<string>();
  // When org creation has already fetched sites synchronously for a freshly
  // created org, record its id here so the selectedOrg effect skips the
  // redundant duplicate GET it would otherwise fire (#1978 follow-up).
  const skipSiteFetchForOrgId = useRef<string | null>(null);

  const filteredOrgs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return organizations;
    return organizations.filter(org => org.name.toLowerCase().includes(q));
  }, [organizations, searchQuery]);

  /**
   * `silent` skips the page-level loading flag. `loading` is an EARLY RETURN
   * that replaces the whole page with a spinner, which is right for the first
   * load and wrong for a background reconciliation: the reorder catch would
   * otherwise blank the list the user is looking at, right as its error toast
   * appears, and take their scroll position and selected org with it.
   */
  const fetchOrganizations = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    try {
      if (!silent) setLoading(true);
      setError(undefined);
      const organizations = await fetchAllOrganizations<Organization>(async (page, limit) => {
        const response = await fetchWithAuth(`/orgs/organizations?page=${page}&limit=${limit}`);
        if (!response.ok) {
          if (response.status === 401) {
            // handleSessionExpired, NOT a bare navigateTo('/login'): this GET
            // runs immediately after a successful create/delete (via
            // refreshOrgs), so its 401 lands while fetchWithAuth may already
            // have started the real expiry redirect — which carries `next` and
            // `reason`. A second, bare navigation replaces that destination
            // with a plain /login. handleSessionExpired is idempotent
            // (sessionExpiryInFlight), so calling it here either no-ops into
            // the redirect already running, or performs the full logout for a
            // 401 that survived a SUCCESSFUL refresh — the case where
            // fetchWithAuth returns the 401 without handling it at all.
            handleSessionExpired();
            return null;
          }
          throw new Error(t('organizationsPage.errors.fetchOrganizations'));
        }
        return response.json();
      });
      if (organizations === null) return;
      setOrganizations(organizations);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  // Refresh both the local list and the global org store (consumed by the
  // side nav). Using allSettled so a sidebar-refresh hiccup doesn't undo the
  // user-visible success of the create/delete that already committed.
  const refreshOrgs = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchOrganizations(),
      useOrgStore.getState().fetchOrganizations(),
    ]);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected && rejected.status === 'rejected') {
      console.warn('[OrganizationsPage] org refresh partially failed', rejected.reason);
    }
  }, [fetchOrganizations]);

  // Returns the fetched site list, or null when we couldn't determine the real
  // count. The null signal lets callers distinguish "confirmed zero sites" from
  // "couldn't tell" — important for the first-site nudge, which must not fire on
  // a guess (a transient failure, or an org that DOES have sites, would
  // otherwise re-introduce the misleading nag of #1978). We fail closed (null)
  // on BOTH a failed request AND a malformed HTTP-200 body (e.g. {}, {data:null},
  // or any non-array payload): a 200 whose body isn't a parseable array of sites
  // tells us nothing about the count, so it must not be read as "zero sites".
  // Only a genuine empty array returns [] (legitimately zero → show the nag).
  const fetchSites = useCallback(async (orgId: string): Promise<Site[] | null> => {
    setSitesLoading(true);
    try {
      const response = await fetchWithAuth(`/orgs/sites?organizationId=${orgId}`);
      if (!response.ok) throw new Error(`Failed to fetch sites (status ${response.status})`);
      const data = await response.json();
      const siteList = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : null;
      if (siteList === null) {
        // 200 OK but the body isn't a parseable array of sites — fail closed so
        // callers suppress the nag rather than treat this as confirmed zero.
        setSites([]);
        console.warn('[OrganizationsPage] sites response was ok but not a parseable array for org', orgId, data);
        return null;
      }
      setSites(siteList);
      return siteList;
    } catch (err) {
      setSites([]);
      console.warn('[OrganizationsPage] failed to fetch sites for org', orgId, err);
      return null;
    } finally {
      setSitesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrganizations();
  }, [fetchOrganizations]);

  // Load the partner's default timezone once so new sites pre-select it.
  // Best-effort: on any failure we silently fall back to the form's UTC default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth('/orgs/partners/me');
        if (!response.ok) return;
        const data = await response.json();
        // Mirror PartnerSettingsPage's resolution order: the partner timezone
        // is a first-class `partners.timezone` column (#1318) that the settings
        // JSONB key only shadows. Reading the key alone silently pre-selects
        // UTC for every new site of a partner whose zone reached the column —
        // the same wrong-default symptom as #2856, one layer up.
        const tz = data?.settings?.timezone || data?.timezone;
        if (!cancelled && typeof tz === 'string' && tz) setPartnerTimezone(tz);
      } catch {
        /* best-effort; keep UTC default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-select org from URL param on initial load
  useEffect(() => {
    if (initialOrgId && organizations.length > 0 && !selectedOrg) {
      const match = organizations.find(o => o.id === initialOrgId);
      if (match) setSelectedOrg(match);
    }
  }, [initialOrgId, organizations, selectedOrg]);

  useEffect(() => {
    if (selectedOrg) {
      // Skip the fetch if org creation already fetched sites for this org
      // synchronously — avoids a redundant concurrent GET per create.
      if (skipSiteFetchForOrgId.current === selectedOrg.id) {
        skipSiteFetchForOrgId.current = null;
        return;
      }
      fetchSites(selectedOrg.id);
    } else {
      setSites([]);
    }
  }, [selectedOrg, fetchSites]);

  // Org handlers
  const handleAdd = () => {
    setModalMode('add');
  };

  const handleEdit = (org: Organization) => {
    void navigateTo(`/settings/organizations/${org.id}`);
  };

  const handleDelete = (org: Organization) => {
    setSelectedOrg(org);
    setModalMode('delete');
  };

  const handleSelectOrg = (org: Organization) => {
    setSelectedOrg(prev => prev?.id === org.id ? prev : org);
    setSiteModalMode('closed');
    setSelectedSite(null);
    window.location.hash = org.id;
  };

  const persistOrganizationOrder = useCallback(async (orderedIds: string[]) => {
    setReorderPending(true);
    try {
      // runAction, not setError: this handler was SILENT. It set the page error
      // and then called fetchOrganizations() to revert the optimistic order —
      // and that function calls setError(undefined) before its first await, so
      // React batches the two updates and renders no failure at all. A toast
      // survives the refetch.
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/organizations/order', {
            method: 'PATCH',
            body: JSON.stringify({ orderedIds })
          }),
        errorFallback: t('organizationsPage.errors.saveOrder'),
        onUnauthorized: handleSessionExpired,
      });
    } catch {
      // Re-fetch the authoritative order. Two earlier attempts were wrong in
      // instructive ways, so the reasoning is worth keeping:
      //
      //   1. Skipping reconciliation for status 0 (to dodge a redirect race)
      //      left an ordinary dropped connection showing an order the server
      //      never accepted, with only a transient toast and no correction.
      //   2. Restoring a locally captured pre-drag array fixes that but CANNOT
      //      be correct: `runAction` collapses every request-side throw to
      //      status 0, so a PATCH that COMMITTED and then lost its response is
      //      indistinguishable from one that never arrived. Restoring locally
      //      would then show an order the server does not have — the same
      //      lie, in the other direction. It also races an in-flight
      //      authoritative GET and can clobber newer data with an older
      //      snapshot.
      //
      // Only the server knows what actually persisted, so the closest thing to
      // a correct answer is to ask it. Two limits, stated rather than implied:
      //
      //   - A slow GET could install an order that a later reorder already
      //     superseded. That needs a SECOND drag to overlap the first request,
      //     which `reorderPending` now prevents by disabling dragging until
      //     this settles. A client generation counter was tried first and
      //     reverted: it discarded genuinely current create/delete/import
      //     refreshes — leaving a newly created org invisible — while still
      //     not covering a GET resolving during an in-flight PATCH.
      //     Serializing the drags removes the overlap those guards were
      //     chasing. Two reorders from SEPARATE TABS can still interleave;
      //     that one needs a revision or compare-and-swap on the endpoint,
      //     which has neither.
      //   - The list endpoint pages by `created_at, id` and applies the
      //     partner's preferred order only WITHIN each page, so past the first
      //     page it cannot report a cross-page order at all. Reconciliation is
      //     therefore authoritative only up to that pre-existing server-side
      //     limit, which this change does not introduce or fix.
      //
      // The refetch was previously unsafe purely because fetchOrganizations
      // answered its own 401 with a bare navigateTo('/login'), which raced the
      // richer session-expiry redirect. That is fixed at its source above, so
      // the 401 path of this second GET is idempotent.
      await fetchOrganizations({ silent: true });
    } finally {
      setReorderPending(false);
    }
  }, [fetchOrganizations, t]);

  const handleOrgDragStart = (event: DragEvent<HTMLLIElement>, org: Organization) => {
    setDraggedOrgId(org.id);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set or the drag won't fire.
    try { event.dataTransfer.setData('text/plain', org.id); } catch { /* noop */ }
  };

  const handleOrgDragOver = (event: DragEvent<HTMLLIElement>, org: Organization) => {
    if (!draggedOrgId || draggedOrgId === org.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dragOverOrgId !== org.id) setDragOverOrgId(org.id);
  };

  const handleOrgDragLeave = (event: DragEvent<HTMLLIElement>) => {
    // Only clear when leaving the row entirely, not when entering a child.
    const related = event.relatedTarget as Node | null;
    if (!related || !(event.currentTarget as Node).contains(related)) {
      setDragOverOrgId(null);
    }
  };

  const handleOrgDrop = (event: DragEvent<HTMLLIElement>, targetOrg: Organization) => {
    event.preventDefault();
    setDragOverOrgId(null);
    const sourceId = draggedOrgId;
    setDraggedOrgId(null);
    if (!sourceId || sourceId === targetOrg.id) return;

    const sourceIndex = organizations.findIndex(o => o.id === sourceId);
    const targetIndex = organizations.findIndex(o => o.id === targetOrg.id);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const next = [...organizations];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    setOrganizations(next);
    void persistOrganizationOrder(next.map(o => o.id));
  };

  const handleOrgDragEnd = () => {
    setDraggedOrgId(null);
    setDragOverOrgId(null);
  };

  const handleCloseModal = () => {
    setModalMode('closed');
  };

  const handleSubmit = async (values: OrganizationFormValues) => {
    setSubmitting(true);
    try {
      // runAction, not setError. The failure has to be VISIBLE, and the page
      // error banner is not: it renders outside this modal, which stays open on
      // failure behind a `fixed inset-0 z-50` overlay, so the message landed
      // underneath the form the user is still looking at. Nothing is rendered
      // inside the dialog itself. The toast container is mounted after the page
      // slot in DashboardLayout at the same z-50, so it paints above the
      // overlay — which is what makes the API's own text reachable at all.
      const createdOrg = await runAction<{ id?: string } | null>({
        request: () =>
          fetchWithAuth('/orgs/organizations', {
            method: 'POST',
            body: JSON.stringify(values)
          }),
        errorFallback: t('organizationsPage.errors.saveOrganization'),
        onUnauthorized: handleSessionExpired,
        parseSuccess: (data) => (data ?? null) as { id?: string } | null,
      });

      await refreshOrgs();
      handleCloseModal();

      // Select the new org. Only nudge the user into the "add the first site"
      // flow when we positively confirm the org has zero sites — a default site
      // may already exist (e.g. the partner's bootstrap org ships with one), in
      // which case the first-site nag would be misleading. We need the count
      // synchronously to make this decision, so call fetchSites directly rather
      // than rely on the selectedOrg effect's fire-and-forget refresh. On a
      // fetch failure (null) we skip the nag rather than guess.
      if (createdOrg?.id) {
        const newOrg: Organization = {
          id: createdOrg.id,
          name: values.name,
          status: values.status,
          deviceCount: 0,
          createdAt: new Date().toISOString()
        };
        // We fetch sites synchronously just below, so tell the selectedOrg
        // effect to skip the duplicate GET it would otherwise fire for this org.
        skipSiteFetchForOrgId.current = createdOrg.id;
        setSelectedOrg(newOrg);
        window.location.hash = createdOrg.id;

        const existingSites = await fetchSites(createdOrg.id);
        if (existingSites?.length === 0) {
          setSelectedSite(null);
          setGuidingFirstSite(true);
          setSiteModalMode('add');
        }
      }
    } catch (err) {
      // runAction already surfaced an ActionError as a toast, and onUnauthorized
      // is redirecting on 401 — re-storing either in the page banner would be a
      // second, INVISIBLE copy (it renders behind this modal). Only a
      // non-ActionError escaped runAction untoasted, so only that is surfaced.
      if (!(err instanceof ActionError)) {
        // A toast, NOT setError. The modal is still open on failure and the
        // page banner renders behind its `fixed inset-0 z-50` overlay, so
        // routing an unexpected error there reproduces the exact invisibility
        // this change removes. Reachable in practice: `runAction` calls
        // `onUnauthorized` OUTSIDE its request try/catch, so a throw from
        // handleSessionExpired's logout or location.replace arrives here as a
        // non-ActionError.
        showToast({
          message: err instanceof Error ? err.message : t('organizationsPage.errors.generic'),
          type: 'error'
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedOrg) return;

    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/orgs/organizations/${selectedOrg.id}`, {
            method: 'DELETE'
          }),
        errorFallback: t('organizationsPage.errors.deleteOrganization'),
        onUnauthorized: handleSessionExpired,
      });

      const deletedId = selectedOrg.id;
      await refreshOrgs();
      handleCloseModal();

      if (selectedOrg?.id === deletedId) {
        setSelectedOrg(null);
      }
    } catch (err) {
      // runAction already surfaced an ActionError as a toast, and onUnauthorized
      // is redirecting on 401 — re-storing either in the page banner would be a
      // second, INVISIBLE copy (it renders behind this modal). Only a
      // non-ActionError escaped runAction untoasted, so only that is surfaced.
      if (!(err instanceof ActionError)) {
        // A toast, NOT setError. The modal is still open on failure and the
        // page banner renders behind its `fixed inset-0 z-50` overlay, so
        // routing an unexpected error there reproduces the exact invisibility
        // this change removes. Reachable in practice: `runAction` calls
        // `onUnauthorized` OUTSIDE its request try/catch, so a throw from
        // handleSessionExpired's logout or location.replace arrives here as a
        // non-ActionError.
        showToast({
          message: err instanceof Error ? err.message : t('organizationsPage.errors.generic'),
          type: 'error'
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Site handlers
  const handleAddSite = () => {
    setSelectedSite(null);
    setSiteModalMode('add');
  };

  const handleEditSite = (site: Site) => {
    setSelectedSite(site);
    setSiteModalMode('edit');
  };

  const handleDeleteSite = (site: Site) => {
    setSelectedSite(site);
    setSiteModalMode('delete');
  };

  const handleCloseSiteModal = () => {
    setSiteModalMode('closed');
    setSelectedSite(null);
    setGuidingFirstSite(false);
  };

  const handleSiteSubmit = async (values: Record<string, unknown>) => {
    if (!selectedOrg) return;
    setSiteSubmitting(true);
    try {
      const payload = {
        orgId: selectedOrg.id,
        name: values.name,
        timezone: values.timezone,
        address: {
          line1: values.addressLine1,
          line2: values.addressLine2,
          city: values.city,
          state: values.state,
          postalCode: values.postalCode,
          country: values.country
        },
        contact: {
          name: values.contactName,
          email: values.contactEmail,
          phone: values.contactPhone
        }
      };

      const url = siteModalMode === 'edit' && selectedSite
        ? `/orgs/sites/${selectedSite.id}`
        : '/orgs/sites';
      const method = siteModalMode === 'edit' ? 'PATCH' : 'POST';

      // This handler already read the body — but it threw into `setError`,
      // whose banner sits behind the still-open site modal. runAction keeps the
      // extracted message and puts it somewhere the user can actually see.
      await runAction({
        request: () => fetchWithAuth(url, { method, body: JSON.stringify(payload) }),
        // `organizationsPage.errors.saveSite` interpolates {{status}}, which
        // runAction does not expose when building the fallback — passing 0
        // renders the nonsense "Failed to save site (0)". This is the existing
        // status-free sibling, present in all 8 locales, so no new keys and
        // nothing for localeParity to catch.
        errorFallback: t('siteDetailPage.errors.saveSite'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchSites(selectedOrg.id);
      handleCloseSiteModal();
    } catch (err) {
      // See the org handlers above: runAction already toasted an ActionError,
      // and onUnauthorized handles 401. Only a non-ActionError escape is
      // unsurfaced, and the page banner is invisible behind this modal anyway.
      if (!(err instanceof ActionError)) {
        // A toast, NOT setError. The modal is still open on failure and the
        // page banner renders behind its `fixed inset-0 z-50` overlay, so
        // routing an unexpected error there reproduces the exact invisibility
        // this change removes. Reachable in practice: `runAction` calls
        // `onUnauthorized` OUTSIDE its request try/catch, so a throw from
        // handleSessionExpired's logout or location.replace arrives here as a
        // non-ActionError.
        showToast({
          message: err instanceof Error ? err.message : t('organizationsPage.errors.generic'),
          type: 'error'
        });
      }
    } finally {
      setSiteSubmitting(false);
    }
  };

  const handleConfirmDeleteSite = async () => {
    if (!selectedSite || !selectedOrg) return;
    setSiteSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/orgs/sites/${selectedSite.id}`, { method: 'DELETE' }),
        errorFallback: t('organizationsPage.errors.deleteSite'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchSites(selectedOrg.id);
      handleCloseSiteModal();
    } catch (err) {
      // See the org handlers above: runAction already toasted an ActionError,
      // and onUnauthorized handles 401. Only a non-ActionError escape is
      // unsurfaced, and the page banner is invisible behind this modal anyway.
      if (!(err instanceof ActionError)) {
        // A toast, NOT setError. The modal is still open on failure and the
        // page banner renders behind its `fixed inset-0 z-50` overlay, so
        // routing an unexpected error there reproduces the exact invisibility
        // this change removes. Reachable in practice: `runAction` calls
        // `onUnauthorized` OUTSIDE its request try/catch, so a throw from
        // handleSessionExpired's logout or location.replace arrives here as a
        // non-ActionError.
        showToast({
          message: err instanceof Error ? err.message : t('organizationsPage.errors.generic'),
          type: 'error'
        });
      }
    } finally {
      setSiteSubmitting(false);
    }
  };

  const getSiteFormDefaults = (site: Site & { address?: Record<string, string>; contact?: Record<string, string> }) => ({
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
    contactPhone: site.contact?.phone ?? ''
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('organizationsPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && organizations.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => void fetchOrganizations()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('organizationsPage.actions.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('organizationsPage.title')}</h1>
          <p className="text-muted-foreground">{t('organizationsPage.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="bulk-org-import-toggle"
            onClick={() => setShowBulkImport((v) => !v)}
            className="inline-flex h-10 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium transition hover:bg-muted"
          >
            {t('bulkOrgImport.title')}
          </button>
          <button
            type="button"
            onClick={handleAdd}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {t('organizationsPage.actions.addOrganization')}
          </button>
        </div>
      </div>

      {showBulkImport && (
        <BulkOrgImport
          onImported={() => void fetchOrganizations()}
          onClose={() => setShowBulkImport(false)}
          onUnauthorized={handleSessionExpired}
        />
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Split view: org list (left) + detail panel (right) */}
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* Left panel - Organization list */}
        <div className="rounded-lg border bg-card shadow-xs">
          <div className="border-b px-4 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('organizationsPage.list.title')}
            </h2>
            <input
              type="search"
              placeholder={t('organizationsPage.list.searchPlaceholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="mt-2 h-8 w-full rounded-md border bg-background px-2.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
            {filteredOrgs.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {organizations.length === 0
                  ? t('organizationsPage.list.empty')
                  : t('organizationsPage.list.noMatches')}
              </div>
            ) : (
              <ul className="divide-y">
                {filteredOrgs.map(org => {
                  const dragEnabled = searchQuery.trim().length === 0 && !reorderPending;
                  const isDragging = draggedOrgId === org.id;
                  const isDropTarget = dragOverOrgId === org.id && draggedOrgId !== org.id;
                  return (
                  <li
                    key={org.id}
                    data-testid={`org-row-${org.id}`}
                    onClick={() => handleSelectOrg(org)}
                    draggable={dragEnabled}
                    onDragStart={dragEnabled ? (e) => handleOrgDragStart(e, org) : undefined}
                    onDragOver={dragEnabled ? (e) => handleOrgDragOver(e, org) : undefined}
                    onDragLeave={dragEnabled ? handleOrgDragLeave : undefined}
                    onDrop={dragEnabled ? (e) => handleOrgDrop(e, org) : undefined}
                    onDragEnd={dragEnabled ? handleOrgDragEnd : undefined}
                    className={`group relative cursor-pointer px-4 py-3 transition hover:bg-muted/50 ${
                      selectedOrg?.id === org.id
                        ? 'bg-muted/60 border-l-2 border-l-primary'
                        : 'border-l-2 border-l-transparent'
                    } ${isDragging ? 'opacity-50' : ''} ${isDropTarget ? 'border-t-2 border-t-primary' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      {dragEnabled && (
                        <span
                          data-testid="org-drag-handle"
                          className="mt-0.5 cursor-grab text-muted-foreground/40 opacity-0 transition group-hover:opacity-100 active:cursor-grabbing"
                          title={t('organizationsPage.list.dragToReorder')}
                          aria-hidden="true"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="9" cy="6" r="1" />
                            <circle cx="9" cy="12" r="1" />
                            <circle cx="9" cy="18" r="1" />
                            <circle cx="15" cy="6" r="1" />
                            <circle cx="15" cy="12" r="1" />
                            <circle cx="15" cy="18" r="1" />
                          </svg>
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{org.name}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${statusColors[org.status]}`}
                          >
                            {t(/* i18n-dynamic */ statusLabelKeys[org.status])}
                          </span>
                          {shouldShowDeviceCount(org.deviceCount) && (
                            <span className="text-xs text-muted-foreground">
                              {t('organizationsPage.deviceCount', { count: org.deviceCount })}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Hover action buttons */}
                      <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleEdit(org);
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t('organizationsPage.actions.editOrganization')}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            <path d="m15 5 4 4" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleDelete(org);
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title={t('organizationsPage.actions.deleteOrganization')}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" />
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Right panel - Detail view */}
        <div className="rounded-lg border bg-card shadow-xs">
          {selectedOrg ? (
            <>
              {/* Org header */}
              <div className="border-b px-6 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{selectedOrg.name}</h2>
                    <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusColors[selectedOrg.status]}`}
                      >
                        {t(/* i18n-dynamic */ statusLabelKeys[selectedOrg.status])}
                      </span>
                      {shouldShowDeviceCount(selectedOrg.deviceCount) && (
                        <span>
                          {t('organizationsPage.deviceCount', { count: selectedOrg.deviceCount })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleEdit(selectedOrg)}
                      className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                    >
                      {t('common:actions.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(selectedOrg)}
                      className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      {t('common:actions.delete')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Sites section */}
              <div className="p-6">
                {sitesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                    <span className="ml-3 text-sm text-muted-foreground">{t('organizationsPage.sites.loading')}</span>
                  </div>
                ) : (
                  <SiteList
                    sites={sites}
                    onAddSite={handleAddSite}
                    onEdit={handleEditSite}
                    onDelete={handleDeleteSite}
                    onSiteClick={(site) => void navigateTo(`/settings/sites/${site.id}`)}
                  />
                )}
              </div>
            </>
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="rounded-full bg-muted/50 p-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/60">
                  <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
                  <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                  <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
                  <path d="M10 6h4" />
                  <path d="M10 10h4" />
                  <path d="M10 14h4" />
                  <path d="M10 18h4" />
                </svg>
              </div>
              <h3 className="mt-4 text-sm font-medium">{t('organizationsPage.emptySelection.title')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('organizationsPage.emptySelection.description')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Org Add/Edit Modal */}
      {modalMode === 'add' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4 rounded-lg border bg-card p-6 shadow-xs">
              <h2 className="text-lg font-semibold">{t('organizationsPage.add.title')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('organizationsPage.add.description')}
              </p>
            </div>
            <OrganizationForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              submitLabel={t('organizationsPage.add.submit')}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {/* Org Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedOrg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('organizationsPage.delete.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('organizationsPage.delete.messagePrefix')} <span className="font-medium">{selectedOrg.name}</span>?
              {t('organizationsPage.delete.messageSuffix')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('organizationsPage.actions.deleting') : t('common:actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Site Add/Edit Modal */}
      {(siteModalMode === 'add' || siteModalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4 flex items-start justify-between gap-4 rounded-lg border bg-card p-6 shadow-xs">
              <div>
                <h2 className="text-lg font-semibold">
                  {siteModalMode === 'edit'
                    ? t('organizationsPage.siteModal.editTitle')
                    : guidingFirstSite
                      ? t('organizationsPage.siteModal.firstTitle', { organization: selectedOrg?.name })
                      : t('organizationsPage.siteModal.addTitle')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {siteModalMode === 'edit'
                    ? t('organizationsPage.siteModal.editDescription')
                    : guidingFirstSite
                      ? t('organizationsPage.siteModal.firstDescription')
                      : t('organizationsPage.siteModal.addDescription', { organization: selectedOrg?.name })}
                </p>
              </div>
              {guidingFirstSite && (
                <button
                  type="button"
                  onClick={handleCloseSiteModal}
                  className="shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  {t('organizationsPage.siteModal.skip')}
                </button>
              )}
            </div>
            <SiteForm
              onSubmit={handleSiteSubmit}
              onCancel={handleCloseSiteModal}
              defaultValues={
                selectedSite
                  ? getSiteFormDefaults(selectedSite as Site & { address?: Record<string, string>; contact?: Record<string, string> })
                  : partnerTimezone
                    ? { timezone: partnerTimezone }
                    : undefined
              }
              submitLabel={
                siteModalMode === 'edit'
                  ? t('organizationsPage.siteModal.saveChanges')
                  : guidingFirstSite
                    ? t('organizationsPage.siteModal.createFirst')
                    : t('organizationsPage.siteModal.create')
              }
              loading={siteSubmitting}
            />
          </div>
        </div>
      )}

      {/* Site Delete Confirmation Modal */}
      {siteModalMode === 'delete' && selectedSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('organizationsPage.deleteSite.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('organizationsPage.deleteSite.messagePrefix')} <span className="font-medium">{selectedSite.name}</span>?
              {t('organizationsPage.deleteSite.messageSuffix')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseSiteModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteSite}
                disabled={siteSubmitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {siteSubmitting ? t('organizationsPage.actions.deleting') : t('common:actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
