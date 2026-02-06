import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Organization } from './OrganizationList';
import OrganizationForm from './OrganizationForm';
import SiteList, { type Site } from './SiteList';
import SiteForm from './SiteForm';
import { fetchWithAuth } from '../../stores/auth';

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

const statusLabels: Record<Organization['status'], string> = {
  active: 'Active',
  trial: 'Trial',
  suspended: 'Suspended',
  churned: 'Churned',
};

const statusColors: Record<Organization['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  trial: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  suspended: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  churned: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
};

export default function OrganizationsPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Sites state
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [siteModalMode, setSiteModalMode] = useState<SiteModalMode>('closed');
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [siteSubmitting, setSiteSubmitting] = useState(false);

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
          window.location.href = '/login';
          return;
        }
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
      setOrganizations(organizations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSites = useCallback(async (orgId: string) => {
    setSitesLoading(true);
    try {
      const response = await fetchWithAuth(`/orgs/sites?organizationId=${orgId}`);
      if (!response.ok) throw new Error('Failed to fetch sites');
      const data = await response.json();
      const siteList = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      setSites(siteList);
    } catch {
      setSites([]);
    } finally {
      setSitesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrganizations();
  }, [fetchOrganizations]);

  useEffect(() => {
    if (selectedOrg) {
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
    setSelectedOrg(org);
    setModalMode('edit');
  };

  const handleDelete = (org: Organization) => {
    setSelectedOrg(org);
    setModalMode('delete');
  };

  const handleSelectOrg = (org: Organization) => {
    setSelectedOrg(prev => prev?.id === org.id ? prev : org);
    setSiteModalMode('closed');
    setSelectedSite(null);
  };

  const handleCloseModal = () => {
    setModalMode('closed');
  };

  const handleSubmit = async (values: OrganizationFormValues) => {
    setSubmitting(true);
    try {
      const url = modalMode === 'edit' && selectedOrg
        ? `/orgs/organizations/${selectedOrg.id}`
        : '/orgs/organizations';
      const method = modalMode === 'edit' ? 'PUT' : 'POST';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(values)
      });

      if (!response.ok) {
        throw new Error('Failed to save organization');
      }

      await fetchOrganizations();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
        throw new Error('Failed to delete organization');
      }

      const deletedId = selectedOrg.id;
      await fetchOrganizations();
      handleCloseModal();

      if (selectedOrg?.id === deletedId) {
        setSelectedOrg(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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

      if (!response.ok) throw new Error('Failed to save site');

      await fetchSites(selectedOrg.id);
      handleCloseSiteModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
      if (!response.ok) throw new Error('Failed to delete site');

      await fetchSites(selectedOrg.id);
      handleCloseSiteModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
          <p className="mt-4 text-sm text-muted-foreground">Loading organizations...</p>
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
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Organizations & Sites</h1>
          <p className="text-muted-foreground">Manage organizations and their sites.</p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Add organization
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
        <div className="rounded-lg border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Organizations
            </h2>
            <input
              type="search"
              placeholder="Search..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="mt-2 h-8 w-full rounded-md border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
            {filteredOrgs.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {organizations.length === 0
                  ? 'No organizations yet.'
                  : 'No matching organizations.'}
              </div>
            ) : (
              <ul className="divide-y">
                {filteredOrgs.map(org => (
                  <li
                    key={org.id}
                    onClick={() => handleSelectOrg(org)}
                    className={`group relative cursor-pointer px-4 py-3 transition hover:bg-muted/50 ${
                      selectedOrg?.id === org.id
                        ? 'bg-muted/60 border-l-2 border-l-primary'
                        : 'border-l-2 border-l-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{org.name}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${statusColors[org.status]}`}
                          >
                            {statusLabels[org.status]}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {org.deviceCount} {org.deviceCount === 1 ? 'device' : 'devices'}
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
                          title="Edit organization"
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
                          title="Delete organization"
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
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Right panel - Detail view */}
        <div className="rounded-lg border bg-card shadow-sm">
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
                        {statusLabels[selectedOrg.status]}
                      </span>
                      <span>
                        {selectedOrg.deviceCount} {selectedOrg.deviceCount === 1 ? 'device' : 'devices'}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleEdit(selectedOrg)}
                      className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(selectedOrg)}
                      className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              {/* Sites section */}
              <div className="p-6">
                {sitesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                    <span className="ml-3 text-sm text-muted-foreground">Loading sites...</span>
                  </div>
                ) : (
                  <SiteList
                    sites={sites}
                    onAddSite={handleAddSite}
                    onEdit={handleEditSite}
                    onDelete={handleDeleteSite}
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
              <h3 className="mt-4 text-sm font-medium">No organization selected</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Select an organization from the list to view its sites.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Org Add/Edit Modal */}
      {(modalMode === 'add' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">
                {modalMode === 'add' ? 'Add Organization' : 'Edit Organization'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {modalMode === 'add'
                  ? 'Create a new organization with the details below.'
                  : 'Update the organization details below.'}
              </p>
            </div>
            <OrganizationForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              defaultValues={
                selectedOrg
                  ? {
                      name: selectedOrg.name,
                      status: selectedOrg.status
                    }
                  : undefined
              }
              submitLabel={modalMode === 'add' ? 'Create organization' : 'Save changes'}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {/* Org Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedOrg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Organization</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedOrg.name}</span>?
              This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Site Add/Edit Modal */}
      {(siteModalMode === 'add' || siteModalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">
                {siteModalMode === 'add' ? 'Add Site' : 'Edit Site'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {siteModalMode === 'add'
                  ? `Add a new site to ${selectedOrg?.name}.`
                  : 'Update the site details below.'}
              </p>
            </div>
            <SiteForm
              onSubmit={handleSiteSubmit}
              onCancel={handleCloseSiteModal}
              defaultValues={
                selectedSite
                  ? getSiteFormDefaults(selectedSite as Site & { address?: Record<string, string>; contact?: Record<string, string> })
                  : undefined
              }
              submitLabel={siteModalMode === 'add' ? 'Create site' : 'Save changes'}
              loading={siteSubmitting}
            />
          </div>
        </div>
      )}

      {/* Site Delete Confirmation Modal */}
      {siteModalMode === 'delete' && selectedSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Site</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedSite.name}</span>?
              This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseSiteModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteSite}
                disabled={siteSubmitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {siteSubmitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
