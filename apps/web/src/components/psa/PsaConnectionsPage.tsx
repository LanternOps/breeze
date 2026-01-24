import { useCallback, useEffect, useState } from 'react';
import PsaConnectionList, { type PsaConnection } from './PsaConnectionList';
import PsaConnectionForm, { type PsaConnectionFormValues } from './PsaConnectionForm';
import PsaTicketList, { type PsaTicket } from './PsaTicketList';
import { fetchWithAuth } from '../../stores/auth';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete' | 'test';

type TestResult = {
  success: boolean;
  message?: string;
  error?: string;
};

type PsaConnectionDetails = PsaConnectionFormValues & {
  id: string;
  hasCredentials?: {
    password?: boolean;
    apiToken?: boolean;
    clientSecret?: boolean;
  };
};

export default function PsaConnectionsPage() {
  const [connections, setConnections] = useState<PsaConnection[]>([]);
  const [tickets, setTickets] = useState<PsaTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedConnection, setSelectedConnection] = useState<PsaConnection | null>(null);
  const [selectedConnectionDetails, setSelectedConnectionDetails] = useState<PsaConnectionDetails | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/psa/connections');
      if (!response.ok) {
        throw new Error('Failed to fetch PSA connections');
      }
      const data = await response.json();
      setConnections(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTickets = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/psa/tickets?limit=25');
      if (response.ok) {
        const data = await response.json();
        setTickets(data.data ?? []);
      }
    } catch {
      // Tickets are optional, don't block the page
    }
  }, []);

  const fetchConnectionDetails = useCallback(async (connectionId: string) => {
    try {
      const response = await fetchWithAuth(`/psa/connections/${connectionId}`);
      if (response.ok) {
        const data = await response.json();
        return data.data as PsaConnectionDetails;
      }
    } catch {
      // Details fetch failed
    }
    return null;
  }, []);

  useEffect(() => {
    fetchConnections();
    fetchTickets();
  }, [fetchConnections, fetchTickets]);

  const handleAdd = () => {
    setSelectedConnection(null);
    setSelectedConnectionDetails(null);
    setModalMode('add');
  };

  const handleEdit = async (connection: PsaConnection) => {
    setSelectedConnection(connection);
    const details = await fetchConnectionDetails(connection.id);
    setSelectedConnectionDetails(details);
    setModalMode('edit');
  };

  const handleSyncNow = async (connection: PsaConnection) => {
    try {
      const response = await fetchWithAuth(`/psa/connections/${connection.id}/sync`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to start sync');
      }

      await fetchConnections();
      await fetchTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleToggleStatus = async (connection: PsaConnection, newStatus: 'active' | 'paused') => {
    try {
      const response = await fetchWithAuth(`/psa/connections/${connection.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus })
      });

      if (!response.ok) {
        throw new Error('Failed to update connection status');
      }

      await fetchConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleDelete = (connection: PsaConnection) => {
    setSelectedConnection(connection);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedConnection(null);
    setSelectedConnectionDetails(null);
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    if (!selectedConnection) return;

    setTestingConnection(true);
    setTestResult(null);

    try {
      const response = await fetchWithAuth(`/psa/connections/${selectedConnection.id}/test`, {
        method: 'POST'
      });
      const data = await response.json();
      setTestResult(data);
      setModalMode('test');
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : 'Test failed'
      });
      setModalMode('test');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSubmit = async (values: PsaConnectionFormValues) => {
    setSubmitting(true);
    try {
      const url = modalMode === 'edit' && selectedConnection
        ? `/psa/connections/${selectedConnection.id}`
        : '/psa/connections';
      const method = modalMode === 'edit' ? 'PATCH' : 'POST';

      const payload = { ...values } as Partial<PsaConnectionFormValues>;
      if (modalMode === 'edit') {
        if (!payload.password) delete payload.password;
        if (!payload.apiToken) delete payload.apiToken;
        if (!payload.clientSecret) delete payload.clientSecret;
      }

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to save connection');
      }

      await fetchConnections();
      await fetchTickets();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedConnection) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/psa/connections/${selectedConnection.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete connection');
      }

      await fetchConnections();
      await fetchTickets();
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
          <p className="mt-4 text-sm text-muted-foreground">Loading PSA connections...</p>
        </div>
      </div>
    );
  }

  if (error && connections.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchConnections}
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
          <h1 className="text-2xl font-bold">PSA Integrations</h1>
          <p className="text-muted-foreground">
            Connect your PSA to sync tickets and link alerts.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add connection
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <PsaConnectionList
        connections={connections}
        onEdit={handleEdit}
        onSyncNow={handleSyncNow}
        onToggleStatus={handleToggleStatus}
        onDelete={handleDelete}
      />

      <PsaTicketList tickets={tickets} />

      {(modalMode === 'add' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">
                {modalMode === 'add' ? 'Add PSA Connection' : 'Edit PSA Connection'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {modalMode === 'add'
                  ? 'Set up a new PSA connection for your organization.'
                  : 'Update the PSA connection details and sync preferences.'}
              </p>
            </div>
            <PsaConnectionForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              onTestConnection={modalMode === 'edit' ? handleTestConnection : undefined}
              defaultValues={
                selectedConnectionDetails
                  ? {
                      name: selectedConnectionDetails.name,
                      provider: selectedConnectionDetails.provider,
                      baseUrl: selectedConnectionDetails.baseUrl || '',
                      defaultQueue: selectedConnectionDetails.defaultQueue || '',
                      username: selectedConnectionDetails.username || '',
                      password: '',
                      apiToken: '',
                      clientId: selectedConnectionDetails.clientId || '',
                      clientSecret: '',
                      syncEnabled: selectedConnectionDetails.syncEnabled ?? true,
                      syncInterval: selectedConnectionDetails.syncInterval || '1h',
                      syncDirection: selectedConnectionDetails.syncDirection || 'bidirectional',
                      syncOnClose: selectedConnectionDetails.syncOnClose ?? true,
                      includeNotes: selectedConnectionDetails.includeNotes ?? true
                    }
                  : undefined
              }
              submitLabel={modalMode === 'add' ? 'Create connection' : 'Save changes'}
              loading={submitting}
              testingConnection={testingConnection}
              isEditing={modalMode === 'edit'}
              hasCredentials={selectedConnectionDetails?.hasCredentials}
            />
          </div>
        </div>
      )}

      {modalMode === 'delete' && selectedConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete PSA Connection</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedConnection.name}</span>?
            </p>
            {selectedConnection.status === 'active' && (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  <strong>Warning:</strong> This connection is active. Ticket syncing will stop immediately.
                </p>
              </div>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
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
                {submitting ? 'Deleting...' : 'Delete connection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalMode === 'test' && selectedConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Connection Test Result</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Testing <span className="font-medium">{selectedConnection.name}</span>
            </p>

            <div className="mt-6">
              {testResult?.success ? (
                <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
                  <svg
                    className="h-6 w-6 flex-shrink-0 text-green-600 dark:text-green-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <div>
                    <h3 className="font-medium text-green-800 dark:text-green-200">Connection successful</h3>
                    <p className="text-sm text-green-700 dark:text-green-300">
                      {testResult.message || 'PSA credentials are valid.'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4">
                  <svg
                    className="h-6 w-6 flex-shrink-0 text-destructive"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <div>
                    <h3 className="font-medium text-destructive">Connection failed</h3>
                    <p className="mt-1 text-sm text-destructive/90">
                      {testResult?.error || 'Unable to connect to the PSA provider.'}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Verify the credentials and API permissions for this connection.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
