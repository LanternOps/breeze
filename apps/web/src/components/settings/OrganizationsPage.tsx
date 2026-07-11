import { useState, useEffect, useCallback, useMemo, useRef, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from './OrganizationList';
import OrganizationForm from './OrganizationForm';
import SiteList, { type Site } from './SiteList';
import SiteForm from './SiteForm';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { extractApiError } from '@/lib/apiError';
import { navigateTo } from '@/lib/navigation';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete';
type SiteModalMode = 'closed' | 'add' | 'edit' | 'delete';

type OrganizationFormValues = {
  name: string;
  slug: string;
  type: 'customer' | 'internal';
  status: 'active' | 'trial' | 'suspended' | 'churned';
  maxDevices: number;
  contractStart?: string;
  contractEnd?: string;
};

const statusLabelKeys: Record<Organization['status'], string> = {
  active: 'organizationsPage.status.active',
  trial: 'organizationsPage.status.trial',
  suspended: 'organizationsPage.status.suspended',
  churned: 'organizationsPage.status.churned',
};

const statusColors: Record<Organization['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  trial: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  suspended: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  churned: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
};

export default function OrganizationsPage() {
  const { t } = useTranslation('settings');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [initialOrgId] = useState(() => {
    if (typeof window === 'undefined') return null;
    return window.location.hash.replace('#', '') || null;
  });
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [draggedOrgId, setDraggedOrgId] = useState<string | null>(null);
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

  const fetchOrganizations = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/orgs/organizations');
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(t('organizationsPage.errors.fetchOrganizations'));
      }
      const data = await response.json();
      const organizations = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.organizations)
          ? data.organizations
          : Array.isArray(data)
            ? data
            : [];
      setOrganizations(organizations);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
    } finally {
      setLoading(false);
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
        const tz = data?.settings?.timezone;
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
    try {
      const res = await fetchWithAuth('/orgs/organizations/order', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds })
      });
      if (!res.ok) throw new Error(`Reorder failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.saveOrder'));
      // Revert by re-fetching the authoritative order from the server.
      void fetchOrganizations();
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
      const response = await fetchWithAuth('/orgs/organizations', {
        method: 'POST',
        body: JSON.stringify(values)
      });

      if (!response.ok) {
        throw new Error(t('organizationsPage.errors.saveOrganization'));
      }

      const createdOrg = await response.json().catch(() => null) as { id?: string } | null;

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
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedOrg) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/orgs/organizations/${selectedOrg.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('organizationsPage.errors.deleteOrganization'));
      }

      const deletedId = selectedOrg.id;
      await refreshOrgs();
      handleCloseModal();

      if (selectedOrg?.id === deletedId) {
        setSelectedOrg(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
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

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(extractApiError(data, t('organizationsPage.errors.saveSite', { status: response.status })));
      }

      await fetchSites(selectedOrg.id);
      handleCloseSiteModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
    } finally {
      setSiteSubmitting(false);
    }
  };

  const handleConfirmDeleteSite = async () => {
    if (!selectedSite || !selectedOrg) return;
    setSiteSubmitting(true);
    try {
      const response = await fetchWithAuth(`/orgs/sites/${selectedSite.id}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error(t('organizationsPage.errors.deleteSite'));

      await fetchSites(selectedOrg.id);
      handleCloseSiteModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
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
          onClick={fetchOrganizations}
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
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('organizationsPage.actions.addOrganization')}
        </button>
      </div>

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
                  const dragEnabled = searchQuery.trim().length === 0;
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
                            {t(statusLabelKeys[org.status])}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t('organizationsPage.deviceCount', { count: org.deviceCount })}
                          </span>
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
                        {t(statusLabelKeys[selectedOrg.status])}
                      </span>
                      <span>
                        {t('organizationsPage.deviceCount', { count: selectedOrg.deviceCount })}
                      </span>
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
