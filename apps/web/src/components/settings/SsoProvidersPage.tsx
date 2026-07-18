import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import SsoProviderList, { type SsoProvider } from './SsoProviderList';
import SsoProviderForm, { type SsoProviderFormValues, type ProviderPreset, type Role } from './SsoProviderForm';
import { fetchWithAuth } from '../../stores/auth';
import { getJwtClaims } from '../../lib/authScope';
import { getOrgScope } from '@/hooks/useOrgScope';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';

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
  const { t } = useTranslation('settings');
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

  // Partner-scope viewers additionally own partner-wide (technician-login)
  // providers. Gate on the JWT scope, never partners.length (known-broken).
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const isPartnerScope = jwtScope === 'partner' && !!jwtPartnerId;

  const fetchProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      // Track fetch failures separately from rows: a partial failure must still
      // render whatever loaded AND surface the error — never silently swallow it.
      let hadError = false;

      // In fleet view (All organizations) there is no org to resolve for the
      // org-scoped list — the API is guaranteed to 400 — so don't fire the
      // request at all; the partner-wide providers below are the whole list.
      let orgProviders: SsoProvider[] = [];
      if (getOrgScope().scope !== 'all') {
        const response = await fetchWithAuth('/sso/providers');
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (response.ok) {
          orgProviders = (await response.json()).data ?? [];
        } else if (isPartnerScope && response.status === 400) {
          // Expected: a partner viewer with no single-org context can't resolve an
          // org for the org-scoped list (API returns 400 "Organization ID
          // required"). Their partner-wide providers still load below — not an
          // error worth surfacing. Any OTHER non-ok status is a real failure.
        } else {
          hadError = true;
        }
      }

      // Also pull partner-wide providers for partner-scope viewers and merge
      // them in (deduped by id). Additive: a failure here must not wipe the
      // org list, and vice-versa — but it MUST surface, not vanish.
      let partnerProviders: SsoProvider[] = [];
      if (isPartnerScope) {
        const partnerRes = await fetchWithAuth('/sso/providers?scope=partner');
        if (partnerRes.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (partnerRes.ok) {
          partnerProviders = (await partnerRes.json()).data ?? [];
        } else {
          hadError = true;
        }
      }

      const byId = new Map<string, SsoProvider>();
      for (const p of [...orgProviders, ...partnerProviders]) byId.set(p.id, p);
      setProviders(Array.from(byId.values()));

      if (hadError) {
        setError(t('ssoProvidersPage.failedToFetchSSOProviders'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssoProvidersPage.anErrorOccurred'));
    } finally {
      setLoading(false);
    }
  }, [isPartnerScope]);

  const fetchPresets = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/sso/presets');
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
      const response = await fetchWithAuth('/roles');
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
      const response = await fetchWithAuth(`/sso/providers/${providerId}`);
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
      const response = await fetchWithAuth(`/sso/providers/${provider.id}/test`, {
        method: 'POST'
      });
      const data = await response.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : t('ssoProvidersPage.testFailed')
      });
    } finally {
      setTestingConnection(false);
      setModalMode('test');
    }
  };

  const handleToggleStatus = async (provider: SsoProvider, newStatus: 'active' | 'inactive') => {
    try {
      const response = await fetchWithAuth(`/sso/providers/${provider.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus })
      });

      if (!response.ok) {
        throw new Error(t('ssoProvidersPage.failedToUpdateProviderStatus'));
      }

      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssoProvidersPage.anErrorOccurred'));
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
      const response = await fetchWithAuth(`/sso/providers/${selectedProvider.id}/test`, {
        method: 'POST'
      });
      const data = await response.json();
      setTestResult(data);
      setModalMode('test');
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : t('ssoProvidersPage.testFailed')
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
        ? `/sso/providers/${selectedProvider.id}`
        : '/sso/providers';
      const method = modalMode === 'edit' ? 'PATCH' : 'POST';

      // Don't send empty client secret on edit
      const payload = { ...values };
      if (modalMode === 'edit') {
        if (!payload.clientSecret) delete payload.clientSecret;
        // ownerScope is create-only (the update schema omits it); never PATCH it.
        delete payload.ownerScope;
      }

      // A blank optional field (e.g. defaultRoleId reset to "Select a role",
      // issuer backspaced out) is posted as '' here. The API normalizes ''
      // to an explicit NULL — clearing the column — rather than leaving it
      // untouched, so the admin can actually unset a previously-configured
      // default role. Mutation outcome (success or failure) must always
      // reach the user — runAction is the repo convention for that.
      await runAction({
        request: () => fetchWithAuth(url, { method, body: JSON.stringify(payload) }),
        errorFallback: t('ssoProvidersPage.failedToSaveProvider'),
        onUnauthorized: () => navigateTo('/login', { replace: true })
      });

      await fetchProviders();
      handleCloseModal();
    } catch (err) {
      handleActionError(err, t('ssoProvidersPage.anErrorOccurred'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedProvider) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/sso/providers/${selectedProvider.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('ssoProvidersPage.failedToDeleteProvider'));
      }

      await fetchProviders();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssoProvidersPage.anErrorOccurred'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('ssoProvidersPage.loadingSSOProviders')}</p>
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
          {t('ssoProvidersPage.tryAgain')}</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('ssoProvidersPage.singleSignOn')}</h1>
          <p className="text-muted-foreground">
            {t('ssoProvidersPage.configureSSOProvidersForSecureAuthentication')}</p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('ssoProvidersPage.addProvider')}</button>
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
                {modalMode === 'add' ? t('ssoProvidersPage.addSSOProvider') : t('ssoProvidersPage.editSSOProvider')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {modalMode === 'add'
                  ? t('ssoProvidersPage.configureANewSSOProviderForYourOrganization')
                  : t('ssoProvidersPage.updateTheSSOProviderConfiguration')}
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
              submitLabel={modalMode === 'add'
                ? t('ssoProvidersPage.createProvider')
                : t('ssoProvidersPage.saveChanges')}
              loading={submitting}
              testingConnection={testingConnection}
              isEditing={modalMode === 'edit'}
              hasClientSecret={selectedProviderDetails?.hasClientSecret}
              showOwnerScope={isPartnerScope}
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('ssoProvidersPage.deleteSSOProvider')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('ssoProvidersPage.areYouSureYouWantToDelete')}<span className="font-medium">{selectedProvider.name}</span>?
            </p>
            {selectedProvider.status === 'active' && (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  <strong>{t('ssoProvidersPage.warning')}</strong> {t('ssoProvidersPage.thisProviderIsCurrentlyActiveUsersWhoRelyOnThisProviderF')}</p>
              </div>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
              {t('ssoProvidersPage.thisWillAlsoRemoveAllLinkedSSOIdentitiesThisActionCannot')}</p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('ssoProvidersPage.cancel')}</button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('ssoProvidersPage.deleting') : t('ssoProvidersPage.deleteProvider')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test Result Modal */}
      {modalMode === 'test' && selectedProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('ssoProvidersPage.connectionTestResult')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('ssoProvidersPage.testing')}<span className="font-medium">{selectedProvider.name}</span>
            </p>

            <div className="mt-6">
              {testResult?.success ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
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
                      <h3 className="font-medium text-green-800 dark:text-green-200">
                        {t('ssoProvidersPage.connectionSuccessful')}</h3>
                      <p className="text-sm text-green-700 dark:text-green-300">
                        {testResult.message || t('ssoProvidersPage.providerConfigurationIsValid')}
                      </p>
                    </div>
                  </div>

                  {testResult.discovery && (
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">{t('ssoProvidersPage.discoveredEndpoints')}</h4>
                      <div className="rounded-md border bg-muted/40 p-3 text-xs font-mono space-y-1">
                        <p><span className="text-muted-foreground">{t('ssoProvidersPage.issuer')}</span> {testResult.discovery.issuer}</p>
                        <p><span className="text-muted-foreground">{t('ssoProvidersPage.auth')}</span> {testResult.discovery.authorizationEndpoint}</p>
                        <p><span className="text-muted-foreground">{t('ssoProvidersPage.token')}</span> {testResult.discovery.tokenEndpoint}</p>
                        <p><span className="text-muted-foreground">{t('ssoProvidersPage.userInfo')}</span> {testResult.discovery.userInfoEndpoint}</p>
                      </div>
                    </div>
                  )}
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
                    <h3 className="font-medium text-destructive">{t('ssoProvidersPage.connectionFailed')}</h3>
                    <p className="mt-1 text-sm text-destructive/90">
                      {testResult?.error || t('ssoProvidersPage.unableToConnectToTheIdentityProvider')}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t('ssoProvidersPage.pleaseVerifyYourIssuerURLAndCredentialsAreCorrect')}</p>
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
                {t('ssoProvidersPage.close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
