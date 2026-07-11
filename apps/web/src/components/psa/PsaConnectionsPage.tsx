import { useCallback, useEffect, useState } from 'react';
import PsaConnectionList, { type PsaConnection } from './PsaConnectionList';
import PsaConnectionForm, { type PsaConnectionFormValues } from './PsaConnectionForm';
import PsaTicketList, { type PsaTicket } from './PsaTicketList';
import { fetchWithAuth } from '../../stores/auth';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('common');
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
        throw new Error(t('longTail.psa.PsaConnectionsPage.errors.fetchConnections'));
      }
      const data = await response.json();
      setConnections(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.psa.PsaConnectionsPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
        throw new Error(t('longTail.psa.PsaConnectionsPage.errors.startSync'));
      }

      await fetchConnections();
      await fetchTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.psa.PsaConnectionsPage.errors.generic'));
    }
  };

  const handleToggleStatus = async (connection: PsaConnection, newStatus: 'active' | 'paused') => {
    try {
      const response = await fetchWithAuth(`/psa/connections/${connection.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus })
      });

      if (!response.ok) {
        throw new Error(t('longTail.psa.PsaConnectionsPage.errors.updateStatus'));
      }

      await fetchConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.psa.PsaConnectionsPage.errors.generic'));
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
        error: err instanceof Error ? err.message : t('longTail.psa.PsaConnectionsPage.errors.testFailed')
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
        throw new Error(errorData.error || t('longTail.psa.PsaConnectionsPage.errors.saveConnection'));
      }

      await fetchConnections();
      await fetchTickets();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.psa.PsaConnectionsPage.errors.generic'));
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
        throw new Error(t('longTail.psa.PsaConnectionsPage.errors.deleteConnection'));
      }

      await fetchConnections();
      await fetchTickets();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.psa.PsaConnectionsPage.errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('longTail.psa.PsaConnectionsPage.loading')}</p>
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
          {t('longTail.psa.PsaConnectionsPage.actions.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('longTail.psa.PsaConnectionsPage.title')}</h1>
          <p className="text-muted-foreground">
            {t('longTail.psa.PsaConnectionsPage.subtitle')}
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
          {t('longTail.psa.PsaConnectionsPage.actions.addConnection')}
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
                {modalMode === 'add' ? t('longTail.psa.PsaConnectionsPage.modal.addTitle') : t('longTail.psa.PsaConnectionsPage.modal.editTitle')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {modalMode === 'add'
                  ? t('longTail.psa.PsaConnectionsPage.modal.addDescription')
                  : t('longTail.psa.PsaConnectionsPage.modal.editDescription')}
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
              submitLabel={modalMode === 'add' ? t('longTail.psa.PsaConnectionsPage.actions.createConnection') : t('longTail.psa.PsaConnectionsPage.actions.saveChanges')}
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
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('longTail.psa.PsaConnectionsPage.delete.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('longTail.psa.PsaConnectionsPage.delete.confirm', { name: selectedConnection.name })}
            </p>
            {selectedConnection.status === 'active' && (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  <strong>{t('longTail.psa.PsaConnectionsPage.delete.warningLabel')}</strong> {t('longTail.psa.PsaConnectionsPage.delete.activeWarning')}
                </p>
              </div>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
              {t('longTail.psa.PsaConnectionsPage.delete.irreversible')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('longTail.psa.PsaConnectionsPage.actions.deleting') : t('longTail.psa.PsaConnectionsPage.actions.deleteConnection')}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalMode === 'test' && selectedConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('longTail.psa.PsaConnectionsPage.test.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('longTail.psa.PsaConnectionsPage.test.testing', { name: selectedConnection.name })}
            </p>

            <div className="mt-6">
              {testResult?.success ? (
                <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
                  <svg
                    className="h-6 w-6 shrink-0 text-green-600 dark:text-green-400"
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
                    <h3 className="font-medium text-green-800 dark:text-green-200">{t('longTail.psa.PsaConnectionsPage.test.successTitle')}</h3>
                    <p className="text-sm text-green-700 dark:text-green-300">
                      {testResult.message || t('longTail.psa.PsaConnectionsPage.test.successMessage')}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4">
                  <svg
                    className="h-6 w-6 shrink-0 text-destructive"
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
                    <h3 className="font-medium text-destructive">{t('longTail.psa.PsaConnectionsPage.test.failedTitle')}</h3>
                    <p className="mt-1 text-sm text-destructive/90">
                      {testResult?.error || t('longTail.psa.PsaConnectionsPage.test.failedMessage')}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t('longTail.psa.PsaConnectionsPage.test.verifyHelp')}
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
                {t('common:actions.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
