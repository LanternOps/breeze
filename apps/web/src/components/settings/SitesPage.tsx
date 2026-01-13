import { useState, useEffect, useCallback } from 'react';
import SiteList, { type Site } from './SiteList';
import SiteForm from './SiteForm';
import { type Organization } from './OrganizationList';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete';

type SiteFormValues = {
  name: string;
  timezone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
};

export default function SitesPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchOrganizations = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/organizations');
      if (!response.ok) {
        throw new Error('Failed to fetch organizations');
      }
      const data = await response.json();
      const orgs = data.organizations ?? data ?? [];
      setOrganizations(orgs);
      if (orgs.length > 0 && !selectedOrgId) {
        setSelectedOrgId(orgs[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [selectedOrgId]);

  const fetchSites = useCallback(async () => {
    if (!selectedOrgId) {
      setSites([]);
      return;
    }

    try {
      setSitesLoading(true);
      setError(undefined);
      const response = await fetch(`/api/sites?organizationId=${selectedOrgId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch sites');
      }
      const data = await response.json();
      setSites(data.sites ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSitesLoading(false);
    }
  }, [selectedOrgId]);

  useEffect(() => {
    fetchOrganizations();
  }, [fetchOrganizations]);

  useEffect(() => {
    fetchSites();
  }, [fetchSites]);

  const handleOrgChange = (orgId: string) => {
    setSelectedOrgId(orgId);
  };

  const handleAddSite = () => {
    setSelectedSite(null);
    setModalMode('add');
  };

  const handleEdit = (site: Site) => {
    setSelectedSite(site);
    setModalMode('edit');
  };

  const handleDelete = (site: Site) => {
    setSelectedSite(site);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedSite(null);
  };

  const handleSubmit = async (values: SiteFormValues) => {
    setSubmitting(true);
    try {
      const url = modalMode === 'edit' && selectedSite
        ? `/api/sites/${selectedSite.id}`
        : '/api/sites';
      const method = modalMode === 'edit' ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          organizationId: selectedOrgId
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save site');
      }

      await fetchSites();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedSite) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/sites/${selectedSite.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete site');
      }

      await fetchSites();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sites</h1>
          <p className="text-muted-foreground">Manage locations and site-specific settings.</p>
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="org-select" className="text-sm font-medium">
            Organization:
          </label>
          <select
            id="org-select"
            value={selectedOrgId}
            onChange={(e) => handleOrgChange(e.target.value)}
            className="h-10 w-48 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {organizations.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No organizations found. Create an organization first to manage sites.
          </p>
          <a
            href="/settings/organizations"
            className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Go to Organizations
          </a>
        </div>
      ) : sitesLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
            <p className="mt-4 text-sm text-muted-foreground">Loading sites...</p>
          </div>
        </div>
      ) : (
        <SiteList
          sites={sites}
          onAddSite={handleAddSite}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      )}

      {/* Add/Edit Modal */}
      {(modalMode === 'add' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-2xl my-8">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">
                {modalMode === 'add' ? 'Add Site' : 'Edit Site'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {modalMode === 'add'
                  ? 'Create a new site with the details below.'
                  : 'Update the site details below.'}
              </p>
            </div>
            <SiteForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              defaultValues={
                selectedSite
                  ? {
                      name: selectedSite.name,
                      timezone: selectedSite.timezone
                    }
                  : undefined
              }
              submitLabel={modalMode === 'add' ? 'Create site' : 'Save changes'}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Site</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedSite.name}</span>?
              This action cannot be undone and will affect {selectedSite.deviceCount} device(s).
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
    </div>
  );
}
