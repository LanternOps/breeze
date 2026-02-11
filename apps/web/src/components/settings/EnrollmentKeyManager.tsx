import { useState, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';

interface EnrollmentKey {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string;
  key?: string | null;
  usageCount: number;
  maxUsage: number | null;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface CreateFormValues {
  orgId: string;
  siteId?: string;
  name: string;
  maxUsage?: number;
  expiresAt?: string;
}

type ModalMode = 'closed' | 'create' | 'delete';

export default function EnrollmentKeyManager() {
  const [keys, setKeys] = useState<EnrollmentKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedKey, setSelectedKey] = useState<EnrollmentKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Create form state
  const [formName, setFormName] = useState('');
  const [formMaxUsage, setFormMaxUsage] = useState('');
  const [formExpiresAt, setFormExpiresAt] = useState('');

  const fetchKeys = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/enrollment-keys?page=${page}`);
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch enrollment keys');
      }
      const data = await response.json();
      setKeys(data.data ?? []);
      const total = data.pagination?.total ?? 0;
      const limit = data.pagination?.limit ?? 50;
      setTotalPages(Math.max(1, Math.ceil(total / limit)));
      setCurrentPage(data.pagination?.page ?? page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCopyKey = async (key: string, id: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback for older browsers
    }
  };

  const handleOpenCreate = () => {
    setFormName('');
    setFormMaxUsage('');
    setFormExpiresAt('');
    setModalMode('create');
  };

  const handleOpenDelete = (key: EnrollmentKey) => {
    setSelectedKey(key);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedKey(null);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { name: formName };

      // Use first available orgId from existing keys, or let the server resolve it
      if (keys.length > 0) {
        body.orgId = keys[0].orgId;
      }

      if (formMaxUsage) {
        body.maxUsage = parseInt(formMaxUsage, 10);
      }
      if (formExpiresAt) {
        body.expiresAt = new Date(formExpiresAt).toISOString();
      }

      const response = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create enrollment key');
      }

      const created = await response.json().catch(() => ({} as Record<string, unknown>));
      if (typeof created.key === 'string' && created.key.length > 0) {
        setNewlyCreatedKey(created.key);
      }

      await fetchKeys(currentPage);
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedKey) return;
    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/enrollment-keys/${selectedKey.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete enrollment key');
      }

      await fetchKeys(currentPage);
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRotateKey = async (key: EnrollmentKey) => {
    const proceed = window.confirm(
      `Rotate "${key.name}" now? Existing enrollments will continue to work, but new enrollments must use the new key.`
    );
    if (!proceed) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/enrollment-keys/${key.id}/rotate`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to rotate enrollment key');
      }

      const rotated = await response.json().catch(() => ({} as Record<string, unknown>));
      if (typeof rotated.key === 'string' && rotated.key.length > 0) {
        setNewlyCreatedKey(rotated.key);
      }
      await fetchKeys(currentPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const isExpired = (key: EnrollmentKey) =>
    key.expiresAt && new Date(key.expiresAt) < new Date();

  const isExhausted = (key: EnrollmentKey) =>
    key.maxUsage !== null && key.usageCount >= key.maxUsage;

  const getKeyStatus = (key: EnrollmentKey) => {
    if (isExpired(key)) return { label: 'Expired', className: 'bg-red-500/10 text-red-400 border-red-500/30' };
    if (isExhausted(key)) return { label: 'Exhausted', className: 'bg-amber-500/10 text-amber-400 border-amber-500/30' };
    return { label: 'Active', className: 'bg-green-500/10 text-green-400 border-green-500/30' };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading enrollment keys...</p>
        </div>
      </div>
    );
  }

  if (error && keys.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchKeys()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Enrollment Keys</h1>
          <p className="text-muted-foreground">
            Create and manage keys for agent enrollment. Use these keys with{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">breeze-agent enroll &lt;key&gt;</code>
          </p>
        </div>
        <button
          type="button"
          onClick={handleOpenCreate}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create Key
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {newlyCreatedKey && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Save this enrollment key now. It will not be shown again.
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs">
            {newlyCreatedKey}
          </code>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => handleCopyKey(newlyCreatedKey, '__newly-created__')}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              {copiedId === '__newly-created__' ? 'Copied' : 'Copy key'}
            </button>
            <button
              type="button"
              onClick={() => setNewlyCreatedKey(null)}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Keys Table */}
      <div className="rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Usage</th>
                <th className="px-4 py-3 font-medium">Expires</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No enrollment keys found. Create one to get started.
                  </td>
                </tr>
              ) : (
                keys.map((key) => {
                  const status = getKeyStatus(key);
                  return (
                    <tr key={key.id} className="border-b last:border-b-0 hover:bg-muted/50">
                      <td className="px-4 py-3 font-medium">{key.name}</td>
                      <td className="px-4 py-3">
                        {key.key ? (
                          <div className="flex items-center gap-2">
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                              {key.key.slice(0, 12)}...
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopyKey(key.key as string, key.id)}
                              className="text-muted-foreground hover:text-foreground"
                              title="Copy full key"
                            >
                              {copiedId === key.id ? (
                                <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              ) : (
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Hidden</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.className}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {key.usageCount}{key.maxUsage !== null ? ` / ${key.maxUsage}` : ''}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {key.expiresAt
                          ? new Date(key.expiresAt).toLocaleDateString()
                          : 'Never'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(key.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleRotateKey(key)}
                          disabled={submitting}
                          className="mr-1 rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenDelete(key)}
                          className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <span className="text-xs text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fetchKeys(currentPage - 1)}
                disabled={currentPage <= 1}
                className="rounded-md border px-3 py-1 text-xs disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => fetchKeys(currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="rounded-md border px-3 py-1 text-xs disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {modalMode === 'create' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Create Enrollment Key</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Generate a new key for agent enrollment.
            </p>
            <form onSubmit={handleCreateSubmit} className="mt-4 space-y-4">
              <div>
                <label className="text-sm font-medium">Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g., Production servers"
                  required
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Max Usage (optional)</label>
                <input
                  type="number"
                  value={formMaxUsage}
                  onChange={(e) => setFormMaxUsage(e.target.value)}
                  placeholder="Unlimited"
                  min={1}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Maximum number of agents that can enroll with this key.
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">Expires At (optional)</label>
                <input
                  type="datetime-local"
                  value={formExpiresAt}
                  onChange={(e) => setFormExpiresAt(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !formName.trim()}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Creating...' : 'Create Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Enrollment Key</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">{selectedKey.name}</span>? This action cannot be undone.
            </p>
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-xs text-destructive">
                Agents will no longer be able to enroll using this key.
              </p>
            </div>
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
                {submitting ? 'Deleting...' : 'Delete Key'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
