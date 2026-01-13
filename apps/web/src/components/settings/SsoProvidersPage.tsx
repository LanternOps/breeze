import { useState, useEffect, useCallback } from 'react';
import SsoProviderList, { type SsoProvider } from './SsoProviderList';
import SsoProviderForm, { type SsoProviderFormValues, type ProviderPreset, type Role } from './SsoProviderForm';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete' | 'test';

type TestResult = {
  success: boolean;
  message?: string;
  error?: string;
  discovery?: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
  };
};

export default function SsoProvidersPage() {
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedProvider, setSelectedProvider] = useState<SsoProvider | null>(null);
  const [selectedProviderDetails, setSelectedProviderDetails] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/sso/providers');
      if (!response.ok) {
        throw new Error('Failed to fetch SSO providers');
      }
      const data = await response.json();
      setProviders(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPresets = useCallback(async () => {
    try {
      const response = await fetch('/api/sso/presets');
      if (response.ok) {
        const data = await response.json();
        setPresets(data.data ?? []);
      }
    } catch {
      // Presets are optional, don't show error
    }
  }, []);

  const fetchRoles = useCallback(async () => {
    try {
      const response = await fetch('/api/roles');
      if (response.ok) {
        const data = await response.json();
        setRoles(data.roles ?? data.data ?? []);
      }
    } catch {
      // Roles are optional for form, don't show error
    }
  }, []);

  const fetchProviderDetails = useCallback(async (providerId: string) => {
    try {
      const response = await fetch(`/api/sso/providers/${providerId}`);
      if (response.ok) {
        const data = await response.json();
        return data.data;
      }
    } catch {
      // Details fetch failed
    }
    return null;
  }, []);

  useEffect(() => {
    fetchProviders();
    fetchPresets();
    fetchRoles();
  }, [fetchProviders, fetchPresets, fetchRoles]);

  const handleAdd = () => {
    setSelectedProvider(null);
    setSelectedProviderDetails(null);
    setModalMode('add');
  };

  const handleEdit = async (provider: SsoProvider) => {
    setSelectedProvider(provider);
    const details = await fetchProviderDetails(provider.id);
    setSelectedProviderDetails(details);
    setModalMode('edit');
  };

  const handleTest = async (provider: SsoProvider) => {
    setSelectedProvider(provider);
    setTestResult(null);
    setTestingConnection(true);

    try {
      const response = await fetch(`/api/sso/providers/${provider.id}/test`, {
        method: 'POST'
      });
      const data = await response.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : 'Test failed'
      });
    } finally {
      setTestingConnection(false);
      setModalMode('test');
    }
  };

  const handleToggleStatus = async (provider: SsoProvider, newStatus: 'active' | 'inactive') => {
    try {
      const response = await fetch(`/api/sso/providers/${provider.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });

      if (!response.ok) {
        throw new Error('Failed to update provider status');
      }

      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleDelete = (provider: SsoProvider) => {
    setSelectedProvider(provider);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedProvider(null);
    setSelectedProviderDetails(null);
    setTestResult(null);
  };

  const handleTestFromForm = async () => {
    if (!selectedProvider) return;

    setTestingConnection(true);
    try {
      const response = await fetch(`/api/sso/providers/${selectedProvider.id}/test`, {
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

  const handleSubmit = async (values: SsoProviderFormValues) => {
    setSubmitting(true);
    try {
      const url = modalMode === 'edit' && selectedProvider
        ? `/api/sso/providers/${selectedProvider.id}`
        : '/api/sso/providers';
      const method = modalMode === 'edit' ? 'PATCH' : 'POST';

      // Don't send empty client secret on edit
      const payload = { ...values };
      if (modalMode === 'edit' && !payload.clientSecret) {
        delete payload.clientSecret;
      }

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to save provider');
      }

      await fetchProviders();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedProvider) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/sso/providers/${selectedProvider.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete provider');
      }

      await fetchProviders();
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
          <p className="mt-4 text-sm text-muted-foreground">Loading SSO providers...</p>
        </div>
      </div>
    );
  }

  if (error && providers.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchProviders}
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
          <h1 className="text-2xl font-bold">Single Sign-On</h1>
          <p className="text-muted-foreground">
            Configure SSO providers for secure authentication.
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
          Add provider
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <SsoProviderList
        providers={providers}
        onEdit={handleEdit}
        onTest={handleTest}
        onToggleStatus={handleToggleStatus}
        onDelete={handleDelete}
      />

      {/* Add/Edit Modal */}
      {(modalMode === 'add' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">
                {modalMode === 'add' ? 'Add SSO Provider' : 'Edit SSO Provider'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {modalMode === 'add'
                  ? 'Configure a new SSO provider for your organization.'
                  : 'Update the SSO provider configuration.'}
              </p>
            </div>
            <SsoProviderForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              onTestConnection={modalMode === 'edit' ? handleTestFromForm : undefined}
              presets={presets}
              roles={roles}
              defaultValues={
                selectedProviderDetails
                  ? {
                      name: selectedProviderDetails.name,
                      type: selectedProviderDetails.type,
                      preset: selectedProviderDetails.preset || '',
                      issuer: selectedProviderDetails.issuer || '',
                      clientId: selectedProviderDetails.clientId || '',
                      clientSecret: '',
                      scopes: selectedProviderDetails.scopes || 'openid profile email',
                      attributeMapping: selectedProviderDetails.attributeMapping || {
                        email: 'email',
                        name: 'name'
                      },
                      autoProvision: selectedProviderDetails.autoProvision ?? true,
                      defaultRoleId: selectedProviderDetails.defaultRoleId || '',
                      allowedDomains: selectedProviderDetails.allowedDomains || '',
                      enforceSSO: selectedProviderDetails.enforceSSO ?? false
                    }
                  : undefined
              }
              submitLabel={modalMode === 'add' ? 'Create provider' : 'Save changes'}
              loading={submitting}
              testingConnection={testingConnection}
              isEditing={modalMode === 'edit'}
              hasClientSecret={selectedProviderDetails?.hasClientSecret}
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete SSO Provider</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedProvider.name}</span>?
            </p>
            {selectedProvider.status === 'active' && (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  <strong>Warning:</strong> This provider is currently active. Users who rely on this
                  provider for SSO login will no longer be able to sign in.
                </p>
              </div>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
              This will also remove all linked SSO identities. This action cannot be undone.
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
                {submitting ? 'Deleting...' : 'Delete provider'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test Result Modal */}
      {modalMode === 'test' && selectedProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Connection Test Result</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Testing <span className="font-medium">{selectedProvider.name}</span>
            </p>

            <div className="mt-6">
              {testResult?.success ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
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
                      <h3 className="font-medium text-green-800 dark:text-green-200">
                        Connection successful
                      </h3>
                      <p className="text-sm text-green-700 dark:text-green-300">
                        {testResult.message || 'Provider configuration is valid.'}
                      </p>
                    </div>
                  </div>

                  {testResult.discovery && (
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">Discovered endpoints:</h4>
                      <div className="rounded-md border bg-muted/40 p-3 text-xs font-mono space-y-1">
                        <p><span className="text-muted-foreground">Issuer:</span> {testResult.discovery.issuer}</p>
                        <p><span className="text-muted-foreground">Auth:</span> {testResult.discovery.authorizationEndpoint}</p>
                        <p><span className="text-muted-foreground">Token:</span> {testResult.discovery.tokenEndpoint}</p>
                        <p><span className="text-muted-foreground">UserInfo:</span> {testResult.discovery.userInfoEndpoint}</p>
                      </div>
                    </div>
                  )}
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
                      {testResult?.error || 'Unable to connect to the identity provider.'}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Please verify your issuer URL and credentials are correct.
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
