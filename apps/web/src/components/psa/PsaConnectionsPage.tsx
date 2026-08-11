import { useCallback, useEffect, useState } from 'react';
import PsaConnectionList, { type PsaConnection } from './PsaConnectionList';
import PsaConnectionForm, {
  type PsaConnectionFormValues,
  type PsaCredentialField
} from './PsaConnectionForm';
import PsaTicketList, { type PsaTicket } from './PsaTicketList';
import PsaCompanyImport from './PsaCompanyImport';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { useOrgStore } from '../../stores/orgStore';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete' | 'test' | 'import';

type TestResult = {
  success: boolean;
  message?: string;
  error?: string;
};

// Server round-trip contract (see serializeConnection in apps/api/src/routes/psa.ts):
// GET /psa/connections/:id returns nested `settings`, and — only for callers
// holding organizations:write — the NON-SECRET credential fields for edit
// prefill plus `credentialFields`, the per-field presence map for the stored
// secrets. Secrets themselves are never returned, and a read-only caller gets
// neither block, so both are optional here.
type PsaConnectionDetails = {
  id: string;
  name: string;
  /** 'partner' = partner-wide ("All orgs"), epic #2135. Immutable after create. */
  ownerScope?: 'organization' | 'partner';
  provider: PsaConnectionFormValues['provider'];
  /** True when ANY credential material is stored (not permission-gated). */
  hasCredentials?: boolean;
  /** Deprecated server-side; no PSA sync worker writes it. */
  lastSyncedAt?: string | null;
  settings?: {
    defaultQueue?: string;
    syncEnabled?: boolean;
    syncInterval?: PsaConnectionFormValues['syncInterval'];
    syncDirection?: PsaConnectionFormValues['syncDirection'];
    syncOnClose?: boolean;
    includeNotes?: boolean;
  };
  credentials?: Partial<Record<'baseUrl' | PsaCredentialField, string>>;
  credentialFields?: Partial<Record<PsaCredentialField, boolean>>;
};

// Every credential key the form can produce; the server decides which ones a
// given provider requires. Keep in sync with PROVIDER_CREDENTIAL_FIELDS.
const CREDENTIAL_FIELDS = [
  'baseUrl',
  'username',
  'password',
  'apiToken',
  'clientId',
  'clientSecret',
  'email',
  'companyId',
  'publicKey',
  'privateKey',
  'integrationCode',
  'secret',
  'apiKey',
  'personalAccessToken'
] as const;

// Map flat form values onto the server's nested {credentials, settings} payload.
// Empty credential fields are omitted: on PATCH the server merges provided keys
// over the stored blob, so omitting an untouched secret keeps it.
function toConnectionPayload(values: PsaConnectionFormValues) {
  const credentials: Record<string, string> = {};
  for (const field of CREDENTIAL_FIELDS) {
    const value = values[field];
    if (typeof value === 'string' && value.trim() !== '') {
      credentials[field] = value;
    }
  }

  return {
    name: values.name,
    credentials,
    settings: {
      ...(values.defaultQueue && values.defaultQueue.trim() !== '' ? { defaultQueue: values.defaultQueue } : {}),
      syncEnabled: values.syncEnabled,
      syncInterval: values.syncInterval,
      syncDirection: values.syncDirection,
      syncOnClose: values.syncOnClose,
      includeNotes: values.includeNotes
    }
  };
}

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

  // Same UX gate as ScriptForm/ScriptBundleImport (#3262): partner-wide is only
  // meaningful for partner-scope callers, and within partner scope only for
  // users holding the partner-wide capability. Absent = capable; the server
  // (canManagePartnerWidePolicies) enforces regardless — this is UX only.
  const canManagePartnerWide = useAuthStore(s => s.user?.canManagePartnerWide ?? true);
  // Repo-wide rule for "what does a new config object default to" — do not
  // inline a literal here (epic #2135; 8 surfaces share this hook).
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const showOwnerScope = isPartnerScope && canManagePartnerWide;
  const organizations = useOrgStore(s => s.organizations);
  const currentOrgId = useOrgStore(s => s.currentOrgId);
  const ownerOrgOptions = showOwnerScope
    ? organizations.map(o => ({ id: o.id, name: o.name }))
    : [];

  /**
   * A partner-wide connection the caller may SEE but not MUTATE. Mirrors the
   * server's canManagePartnerWidePolicies gate so restricted users don't meet a
   * 403 toast after clicking (finding 7) — the server still enforces.
   */
  const isLockedPartnerWide = useCallback(
    (connection: PsaConnection) =>
      connection.ownerScope === 'partner' && !canManagePartnerWide,
    [canManagePartnerWide]
  );

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

  const handleToggleStatus = async (connection: PsaConnection, newStatus: 'active' | 'paused') => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/psa/connections/${connection.id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: newStatus })
        }),
        errorFallback: t('longTail.psa.PsaConnectionsPage.errors.updateStatus')
      });
      await fetchConnections();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('longTail.psa.PsaConnectionsPage.errors.updateStatus') });
      }
    }
  };

  const handleDelete = (connection: PsaConnection) => {
    setSelectedConnection(connection);
    setModalMode('delete');
  };

  const handleImportCompanies = (connection: PsaConnection) => {
    setSelectedConnection(connection);
    setModalMode('import');
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
      // The route answers HTTP 200 with {success:false} on a rejected
      // credential, which runAction treats as a failure (and toasts). The
      // result modal still opens in both branches — it carries the provider's
      // own message, which the toast alone would truncate the context of.
      const data = await runAction<TestResult>({
        request: () => fetchWithAuth(`/psa/connections/${selectedConnection.id}/test`, {
          method: 'POST'
        }),
        errorFallback: t('longTail.psa.PsaConnectionsPage.errors.testFailed')
      });
      setTestResult(data);
      setModalMode('test');
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('longTail.psa.PsaConnectionsPage.errors.testFailed') });
      }
      const body = err instanceof ActionError ? (err.body as TestResult | undefined) : undefined;
      setTestResult({
        success: false,
        error: body?.error
          ?? (err instanceof Error ? err.message : t('longTail.psa.PsaConnectionsPage.errors.testFailed'))
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

      const base = toConnectionPayload(values);
      // ownerScope is create-only (epic #2135) — the PATCH schema rejects it,
      // and re-homing a connection is deliberately not a supported operation.
      // Only sent when the selector was actually shown, so an org-scope user's
      // create keeps the server's 'organization' default.
      const payload = modalMode === 'edit'
        ? base
        : {
            ...base,
            provider: values.provider,
            ...(showOwnerScope && values.ownerScope ? { ownerScope: values.ownerScope } : {}),
            // Only meaningful on the org-owned branch. A partner with 2+ orgs
            // MUST send it or the API 400s; org-scope callers omit it and the
            // server derives the org from their token.
            ...(showOwnerScope && values.ownerScope === 'organization' && values.orgId
              ? { orgId: values.orgId }
              : {})
          };

      await runAction({
        request: () => fetchWithAuth(url, { method, body: JSON.stringify(payload) }),
        errorFallback: t('longTail.psa.PsaConnectionsPage.errors.saveConnection')
      });

      await fetchConnections();
      await fetchTickets();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('longTail.psa.PsaConnectionsPage.errors.saveConnection') });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedConnection) return;

    setSubmitting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/psa/connections/${selectedConnection.id}`, {
          method: 'DELETE'
        }),
        errorFallback: t('longTail.psa.PsaConnectionsPage.errors.deleteConnection')
      });

      await fetchConnections();
      await fetchTickets();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('longTail.psa.PsaConnectionsPage.errors.deleteConnection') });
      }
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
        onToggleStatus={handleToggleStatus}
        onDelete={handleDelete}
        onImportCompanies={handleImportCompanies}
        isLockedPartnerWide={isLockedPartnerWide}
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
              showOwnerScope={showOwnerScope}
              ownerOrgOptions={ownerOrgOptions}
              onTestConnection={modalMode === 'edit' ? handleTestConnection : undefined}
              defaultValues={
                selectedConnectionDetails
                  ? {
                      name: selectedConnectionDetails.name,
                      provider: selectedConnectionDetails.provider,
                      baseUrl: selectedConnectionDetails.credentials?.baseUrl || '',
                      defaultQueue: selectedConnectionDetails.settings?.defaultQueue || '',
                      // Non-secret fields prefill from the server; secrets are
                      // never returned, so they stay empty and an untouched
                      // field is omitted from the PATCH (the form shows a
                      // "keep existing" placeholder instead).
                      username: selectedConnectionDetails.credentials?.username || '',
                      email: selectedConnectionDetails.credentials?.email || '',
                      clientId: selectedConnectionDetails.credentials?.clientId || '',
                      companyId: selectedConnectionDetails.credentials?.companyId || '',
                      publicKey: selectedConnectionDetails.credentials?.publicKey || '',
                      password: '',
                      apiToken: '',
                      clientSecret: '',
                      privateKey: '',
                      integrationCode: '',
                      secret: '',
                      apiKey: '',
                      personalAccessToken: '',
                      syncEnabled: selectedConnectionDetails.settings?.syncEnabled ?? true,
                      syncInterval: selectedConnectionDetails.settings?.syncInterval || '1h',
                      syncDirection: selectedConnectionDetails.settings?.syncDirection || 'bidirectional',
                      syncOnClose: selectedConnectionDetails.settings?.syncOnClose ?? true,
                      includeNotes: selectedConnectionDetails.settings?.includeNotes ?? true
                    }
                  : {
                      // Create defaults. ownerScope comes from the shared hook,
                      // not a literal, so this form follows the repo-wide rule.
                      ownerScope: defaultOwnerScope,
                      orgId: currentOrgId ?? ownerOrgOptions[0]?.id ?? ''
                    }
              }
              submitLabel={modalMode === 'add' ? t('longTail.psa.PsaConnectionsPage.actions.createConnection') : t('longTail.psa.PsaConnectionsPage.actions.saveChanges')}
              loading={submitting}
              testingConnection={testingConnection}
              isEditing={modalMode === 'edit'}
              credentialFields={selectedConnectionDetails?.credentialFields}
            />
          </div>
        </div>
      )}

      {modalMode === 'import' && selectedConnection && (
        // A company import creates organizations, not connections — nothing on
        // this page changes, so there is no `onImported` refetch to do here.
        <PsaCompanyImport connection={selectedConnection} onClose={handleCloseModal} />
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
