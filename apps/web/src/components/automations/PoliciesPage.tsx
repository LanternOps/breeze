import { useState, useEffect, useCallback } from 'react';
import { Plus, Shield } from 'lucide-react';
import PolicyList, { type Policy } from './PolicyList';

type ModalMode = 'closed' | 'delete';

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/policies');
      if (!response.ok) {
        throw new Error('Failed to fetch policies');
      }
      const data = await response.json();
      setPolicies(data.policies ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleEdit = (policy: Policy) => {
    window.location.href = `/policies/${policy.id}`;
  };

  const handleDelete = (policy: Policy) => {
    setSelectedPolicy(policy);
    setModalMode('delete');
  };

  const handleViewCompliance = (policy: Policy) => {
    window.location.href = `/policies/compliance?policyId=${policy.id}`;
  };

  const handleToggle = async (policy: Policy, enabled: boolean) => {
    try {
      const response = await fetch(`/api/policies/${policy.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });

      if (!response.ok) {
        throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} policy`);
      }

      setPolicies(prev =>
        prev.map(p => (p.id === policy.id ? { ...p, enabled } : p))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedPolicy(null);
  };

  const handleConfirmDelete = async () => {
    if (!selectedPolicy) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/policies/${selectedPolicy.id}`, {
        method: 'DELETE'
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

  // Calculate summary stats
  const totalCompliant = policies.reduce((sum, p) => sum + p.compliance.compliant, 0);
  const totalDevices = policies.reduce((sum, p) => sum + p.compliance.total, 0);
  const overallPercent = totalDevices > 0 ? Math.round((totalCompliant / totalDevices) * 100) : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading policies...</p>
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
          <h1 className="text-2xl font-bold">Policies</h1>
          <p className="text-muted-foreground">Define and enforce compliance policies across your devices.</p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/policies/compliance"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Shield className="h-4 w-4" />
            Compliance Dashboard
          </a>
          <a
            href="/policies/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New Policy
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Quick Stats */}
      {policies.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">Active Policies</p>
            <p className="text-2xl font-bold">{policies.filter(p => p.enabled).length}</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">Overall Compliance</p>
            <p className="text-2xl font-bold">{overallPercent}%</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">Devices Monitored</p>
            <p className="text-2xl font-bold">{totalDevices}</p>
          </div>
        </div>
      )}

      <PolicyList
        policies={policies}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onViewCompliance={handleViewCompliance}
        onToggle={handleToggle}
      />

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Policy</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedPolicy.name}</span>?
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
