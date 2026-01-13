import { useState, useEffect, useCallback } from 'react';
import OrganizationList, { type Organization } from './OrganizationList';
import OrganizationForm from './OrganizationForm';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete';

type OrganizationFormValues = {
  name: string;
  slug: string;
  type: 'enterprise' | 'growth' | 'startup' | 'nonprofit';
  status: 'active' | 'trial' | 'suspended' | 'inactive';
  maxDevices: number;
  contractStart?: string;
  contractEnd?: string;
};

export default function OrganizationsPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
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
      setOrganizations(data.organizations ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrganizations();
  }, [fetchOrganizations]);

  const handleAdd = () => {
    setSelectedOrg(null);
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

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedOrg(null);
  };

  const handleSubmit = async (values: OrganizationFormValues) => {
    setSubmitting(true);
    try {
      const url = modalMode === 'edit' && selectedOrg
        ? `/api/organizations/${selectedOrg.id}`
        : '/api/organizations';
      const method = modalMode === 'edit' ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
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
      const response = await fetch(`/api/organizations/${selectedOrg.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete organization');
      }

      await fetchOrganizations();
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Organizations</h1>
          <p className="text-muted-foreground">Manage organizations and their settings.</p>
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

      <OrganizationList
        organizations={organizations}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      {/* Add/Edit Modal */}
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

      {/* Delete Confirmation Modal */}
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
    </div>
  );
}
