import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import BaselineFormModal, { type Baseline } from './BaselineFormModal';

const osLabel: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const profileLabel: Record<string, string> = { cis_l1: 'CIS L1', cis_l2: 'CIS L2', custom: 'Custom' };
const osBadge: Record<string, string> = {
  windows: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  macos: 'bg-purple-500/15 text-purple-700 border-purple-500/30',
  linux: 'bg-orange-500/15 text-orange-700 border-orange-500/30',
};

export default function BaselineList() {
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalBaseline, setModalBaseline] = useState<Baseline | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Baseline | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchBaselines = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      const response = await fetchWithAuth(`/audit-baselines?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch baselines');
      const data = await response.json();
      setBaselines(Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [currentOrgId]);

  useEffect(() => {
    fetchBaselines();
  }, [fetchBaselines]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetchWithAuth(`/audit-baselines/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete baseline');
      await fetchBaselines();
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleActive = async (baseline: Baseline) => {
    try {
      const body: Record<string, unknown> = {
        id: baseline.id,
        name: baseline.name,
        osType: baseline.osType,
        profile: baseline.profile,
        isActive: !baseline.isActive,
      };
      if (currentOrgId) body.orgId = currentOrgId;

      const response = await fetchWithAuth('/audit-baselines', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Failed to toggle baseline');
      await fetchBaselines();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading baselines...</p>
        </div>
      </div>
    );
  }

  if (error && baselines.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchBaselines}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {baselines.length} baseline{baselines.length !== 1 ? 's' : ''}
        </p>
        <button
          type="button"
          onClick={() => setModalBaseline(null)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Baseline
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="border-b">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">OS</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Profile</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Active</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Updated</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {baselines.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No baselines found. Create one to get started.
                </td>
              </tr>
            ) : (
              baselines.map((bl) => (
                <tr key={bl.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <a
                      href={`/audit-baselines/${bl.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {bl.name}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium',
                        osBadge[bl.osType] ?? ''
                      )}
                    >
                      {osLabel[bl.osType] ?? bl.osType}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full border bg-muted/30 px-2.5 py-0.5 text-xs font-medium">
                      {profileLabel[bl.profile] ?? bl.profile}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(bl)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition',
                        bl.isActive
                          ? 'bg-green-500/15 text-green-700 border-green-500/30'
                          : 'bg-gray-500/15 text-gray-600 border-gray-500/30'
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          bl.isActive ? 'bg-green-500' : 'bg-gray-400'
                        )}
                      />
                      {bl.isActive ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(bl.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setModalBaseline(bl)}
                        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(bl)}
                        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalBaseline !== undefined && (
        <BaselineFormModal
          baseline={modalBaseline}
          onClose={() => setModalBaseline(undefined)}
          onSaved={() => {
            setModalBaseline(undefined);
            fetchBaselines();
          }}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Baseline</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">{deleteTarget.name}</span>? This will also remove all
              compliance results. This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  'Delete'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
