import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, PauseCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type PolicyStatus = 'active' | 'paused' | 'draft' | 'archived';

type BackupPolicy = {
  id: string;
  name: string;
  schedule?: string;
  retention?: string;
  status: PolicyStatus;
  targets?: number;
  updatedAt?: string;
};

type PolicyFormState = {
  name: string;
  schedule: string;
  retention: string;
  status: PolicyStatus;
};

const statusConfig: Record<PolicyStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  active: {
    label: 'Active',
    className: 'text-success bg-success/10',
    icon: CheckCircle2
  },
  paused: {
    label: 'Paused',
    className: 'text-warning bg-warning/10',
    icon: PauseCircle
  },
  draft: {
    label: 'Draft',
    className: 'text-muted-foreground bg-muted',
    icon: PauseCircle
  },
  archived: {
    label: 'Archived',
    className: 'text-destructive bg-destructive/10',
    icon: PauseCircle
  }
};

const defaultFormState: PolicyFormState = {
  name: '',
  schedule: '',
  retention: '',
  status: 'draft'
};

export default function BackupPolicyList() {
  const [policies, setPolicies] = useState<BackupPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<PolicyFormState>(defaultFormState);

  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/policies');
      if (!response.ok) {
        throw new Error('Failed to fetch backup policies');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setPolicies(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleEdit = (policy: BackupPolicy) => {
    setEditingId(policy.id);
    setFormState({
      name: policy.name ?? '',
      schedule: policy.schedule ?? '',
      retention: policy.retention ?? '',
      status: policy.status ?? 'draft'
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setFormState(defaultFormState);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setSaving(true);
      setError(undefined);
      const method = editingId ? 'PATCH' : 'POST';
      const endpoint = editingId ? `/backup/policies/${editingId}` : '/backup/policies';
      const response = await fetchWithAuth(endpoint, {
        method,
        body: JSON.stringify(formState)
      });

      if (!response.ok) {
        throw new Error('Failed to save backup policy');
      }

      await fetchPolicies();
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save backup policy');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (policy: BackupPolicy) => {
    if (!confirm(`Delete policy "${policy.name}"?`)) {
      return;
    }
    try {
      setDeletingId(policy.id);
      setError(undefined);
      const response = await fetchWithAuth(`/backup/policies/${policy.id}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        throw new Error('Failed to delete backup policy');
      }
      setPolicies((prev) => prev.filter((item) => item.id !== policy.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete backup policy');
    } finally {
      setDeletingId(null);
    }
  };

  const formatDate = (value?: string) => {
    if (!value) {
      return '--';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading backup policies...</p>
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
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Backup Policies</h2>
        <p className="text-sm text-muted-foreground">
          Create and manage backup policies with schedules and retention rules.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {editingId ? 'Edit policy' : 'New policy'}
            </h3>
            <p className="text-xs text-muted-foreground">
              {editingId ? 'Update the policy settings.' : 'Define schedule and retention.'}
            </p>
          </div>
          {editingId ? (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel edit
            </button>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Policy name</label>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={formState.name}
              onChange={(event) => setFormState((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Primary database policy"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Schedule</label>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={formState.schedule}
              onChange={(event) => setFormState((prev) => ({ ...prev, schedule: event.target.value }))}
              placeholder="Daily at 02:00"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Retention</label>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={formState.retention}
              onChange={(event) => setFormState((prev) => ({ ...prev, retention: event.target.value }))}
              placeholder="30 days"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={formState.status}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, status: event.target.value as PolicyStatus }))
              }
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={resetForm}
            className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {editingId ? 'Save changes' : 'Create policy'}
          </button>
        </div>
      </form>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="w-full">
          <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Retention</th>
              <th className="px-4 py-3">Targets</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {policies.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No backup policies found.
                </td>
              </tr>
            ) : (
              policies.map((policy) => {
                const status = statusConfig[policy.status] ?? statusConfig.draft;
                const StatusIcon = status.icon;
                return (
                  <tr key={policy.id} className="text-sm text-foreground">
                    <td className="px-4 py-3 font-medium">{policy.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{policy.schedule ?? '--'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{policy.retention ?? '--'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{policy.targets ?? '--'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
                          status.className
                        )}
                      >
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(policy.updatedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleEdit(policy)}
                          className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(policy)}
                          disabled={deletingId === policy.id}
                          className="rounded-md border px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          {deletingId === policy.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
