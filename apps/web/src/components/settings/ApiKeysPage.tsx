import { useState, useEffect, useCallback } from 'react';
import ApiKeyList, { type ApiKey } from './ApiKeyList';
import ApiKeyForm, { CreatedKeyModal, type ApiKeyFormValues } from './ApiKeyForm';
import { fetchWithAuth } from '../../stores/auth';

type ModalMode = 'closed' | 'create' | 'view' | 'rotate' | 'revoke';

export default function ApiKeysPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedKey, setSelectedKey] = useState<ApiKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isAdmin, setIsAdmin] = useState(false);

  const fetchApiKeys = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/api-keys?page=${page}`);
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch API keys');
      }
      const data = await response.json();
      setApiKeys(data.apiKeys ?? data ?? []);
      setTotalPages(data.totalPages ?? 1);
      setCurrentPage(data.currentPage ?? page);
      setIsAdmin(data.isAdmin ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApiKeys();
  }, [fetchApiKeys]);

  const handleCreate = () => {
    setSelectedKey(null);
    setModalMode('create');
  };

  const handleView = (apiKey: ApiKey) => {
    setSelectedKey(apiKey);
    setModalMode('view');
  };

  const handleRotate = (apiKey: ApiKey) => {
    setSelectedKey(apiKey);
    setModalMode('rotate');
  };

  const handleRevoke = (apiKey: ApiKey) => {
    setSelectedKey(apiKey);
    setModalMode('revoke');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedKey(null);
  };

  const handleCloseCreatedKeyModal = () => {
    setCreatedKey(null);
  };

  const handlePageChange = (page: number) => {
    fetchApiKeys(page);
  };

  const handleCreateSubmit = async (values: ApiKeyFormValues) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth('/api-keys', {
        method: 'POST',
        body: JSON.stringify(values)
      });

      if (!response.ok) {
        throw new Error('Failed to create API key');
      }

      const data = await response.json();
      setCreatedKey(data.apiKey);
      await fetchApiKeys(currentPage);
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmRotate = async () => {
    if (!selectedKey) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/api-keys/${selectedKey.id}/rotate`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to rotate API key');
      }

      const data = await response.json();
      setCreatedKey(data.apiKey);
      await fetchApiKeys(currentPage);
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmRevoke = async () => {
    if (!selectedKey) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/api-keys/${selectedKey.id}/revoke`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to revoke API key');
      }

      await fetchApiKeys(currentPage);
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
          <p className="mt-4 text-sm text-muted-foreground">Loading API keys...</p>
        </div>
      </div>
    );
  }

  if (error && apiKeys.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchApiKeys()}
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
          <h1 className="text-2xl font-bold">API Keys</h1>
          <p className="text-muted-foreground">
            Manage API keys for programmatic access to your account.
          </p>
        </div>
        <button
          type="button"
          onClick={handleCreate}
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

      <ApiKeyList
        apiKeys={apiKeys}
        onView={handleView}
        onRotate={handleRotate}
        onRevoke={handleRevoke}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={handlePageChange}
      />

      {/* Create Modal */}
      {modalMode === 'create' && (
        <ApiKeyForm
          isOpen
          onSubmit={handleCreateSubmit}
          onCancel={handleCloseModal}
          loading={submitting}
          title="Create API Key"
          description="Create a new API key with specific permissions."
          isAdmin={isAdmin}
        />
      )}

      {/* View Modal */}
      {modalMode === 'view' && selectedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">API Key Details</h2>
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Name</label>
                <p className="mt-1 text-sm font-medium">{selectedKey.name}</p>
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Key Prefix</label>
                <p className="mt-1 font-mono text-sm">{selectedKey.keyPrefix}...</p>
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Status</label>
                <p className="mt-1 text-sm capitalize">{selectedKey.status}</p>
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Scopes</label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {selectedKey.scopes.map(scope => (
                    <span
                      key={scope}
                      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
                    >
                      {scope}
                    </span>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Created</label>
                  <p className="mt-1 text-sm">
                    {new Date(selectedKey.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Last Used</label>
                  <p className="mt-1 text-sm">
                    {selectedKey.lastUsedAt
                      ? new Date(selectedKey.lastUsedAt).toLocaleDateString()
                      : 'Never'}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Expires</label>
                  <p className="mt-1 text-sm">
                    {selectedKey.expiresAt
                      ? new Date(selectedKey.expiresAt).toLocaleDateString()
                      : 'Never'}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Rate Limit</label>
                  <p className="mt-1 text-sm">
                    {selectedKey.rateLimit
                      ? `${selectedKey.rateLimit} req/hour`
                      : 'Default'}
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rotate Confirmation Modal */}
      {modalMode === 'rotate' && selectedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Rotate API Key</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to rotate{' '}
              <span className="font-medium">{selectedKey.name}</span>? This will generate a new key
              and invalidate the current one immediately.
            </p>
            <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-xs text-amber-800">
                Any applications using this key will need to be updated with the new key.
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
                onClick={handleConfirmRotate}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Rotating...' : 'Rotate Key'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revoke Confirmation Modal */}
      {modalMode === 'revoke' && selectedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Revoke API Key</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to revoke{' '}
              <span className="font-medium">{selectedKey.name}</span>? This action cannot be undone.
            </p>
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-xs text-destructive">
                Any applications using this key will immediately lose access.
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
                onClick={handleConfirmRevoke}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Revoking...' : 'Revoke Key'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Created Key Modal */}
      <CreatedKeyModal
        isOpen={!!createdKey}
        apiKey={createdKey ?? ''}
        onClose={handleCloseCreatedKeyModal}
      />
    </div>
  );
}
