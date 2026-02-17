import { useState, useEffect, useCallback } from 'react';
import { Plus, Layers } from 'lucide-react';
import ConfigPolicyList, { type ConfigPolicy } from './ConfigPolicyList';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

type ModalMode = 'closed' | 'delete';

export default function ConfigurationPoliciesPage() {
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [policies, setPolicies] = useState<ConfigPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedPolicy, setSelectedPolicy] = useState<ConfigPolicy | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      const response = await fetchWithAuth(`/configuration-policies?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch configuration policies');
      }
      const data = await response.json();
      const items = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];
      setPolicies(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [currentOrgId]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleEdit = (policy: ConfigPolicy) => {
    window.location.href = `/configuration-policies/${policy.id}`;
  };

  const handleDelete = (policy: ConfigPolicy) => {
    setSelectedPolicy(policy);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedPolicy(null);
  };

  const handleConfirmDelete = async () => {
    if (!selectedPolicy) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/configuration-policies/${selectedPolicy.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete policy');
      }

      await fetchPolicies();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const activeCount = policies.filter((p) => p.status === 'active').length;
  const inactiveCount = policies.filter((p) => p.status === 'inactive').length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading configuration policies...</p>
        </div>
      </div>
    );
  }

  if (error && policies.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchPolicies}
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
          <h1 className="text-2xl font-bold">Configuration Policies</h1>
          <p className="text-muted-foreground">
            Bundle feature settings into reusable policies and assign them across your hierarchy.
          </p>
        </div>
        <a
          href="/configuration-policies/new"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Policy
        </a>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {policies.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Layers className="h-4 w-4" />
              Total Policies
            </div>
            <p className="mt-2 text-2xl font-bold">{policies.length}</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">Active</p>
            <p className="mt-2 text-2xl font-bold">{activeCount}</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">Inactive</p>
            <p className="mt-2 text-2xl font-bold">{inactiveCount}</p>
          </div>
        </div>
      )}

      <ConfigPolicyList policies={policies} onEdit={handleEdit} onDelete={handleDelete} />

      {modalMode === 'delete' && selectedPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Policy</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">{selectedPolicy.name}</span>? This will also remove all
              feature links and assignments. This action cannot be undone.
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
