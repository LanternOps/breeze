import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import SsoProviderList, { type SsoProvider } from './SsoProviderList';
import SsoProviderForm, { type SsoProviderFormValues, type ProviderPreset, type Role } from './SsoProviderForm';
import { fetchWithAuth } from '../../stores/auth';
import { getJwtClaims } from '../../lib/authScope';
import { getOrgScope, useOrgScope } from '@/hooks/useOrgScope';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';

type ModalMode = 'closed' | 'add' | 'edit' | 'delete' | 'test';

// #4068: lockout preflight for enabling Enforce SSO. Mirrors the API's
// POST /sso/providers/enforcement-preflight response.
type EnforcementPreflight = {
  totalActiveUsers: number;
  unlinkedCount: number;
  selfLockedOut: boolean;
  truncated: boolean;
  loginProvider: { id: string; name: string; type: 'oidc' | 'saml' } | null;
  unlinked: Array<{ id: string; email: string; name: string; isSelf: boolean; hasPasskey: boolean }>;
};

type PendingEnforceAction =
  | { kind: 'save'; values: SsoProviderFormValues }
  | { kind: 'activate'; provider: SsoProvider };

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
  // #4068: the lockout confirm renders as an OVERLAY on top of whatever is
  // open (the add/edit form keeps its state underneath; the activate toggle
  // has no modal at all), so it's independent of modalMode.
  const [enforcePreflight, setEnforcePreflight] = useState<EnforcementPreflight | null>(null);
  const [pendingEnforceAction, setPendingEnforceAction] = useState<PendingEnforceAction | null>(null);
  const [lockoutAcknowledged, setLockoutAcknowledged] = useState(false);

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

  // #3524 Finding 1: fetchProviders and fetchRoles both read the CURRENT org
  // scope (via getOrgScope / the ?orgId injected by fetchWithAuth). On a cold
  // load the org store is still unresolved, so the first fetch misses the focused
  // org and the org default-role picker comes up empty. Re-run when the resolved
  // org scope changes (loading → org, or a switch) so the org's providers and
  // org-scoped roles load without a manual reload.
  const orgScope = useOrgScope();
  useEffect(() => {
    fetchProviders();
    fetchPresets();
    fetchRoles();
  }, [fetchProviders, fetchPresets, fetchRoles, orgScope.scope, orgScope.orgId]);

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
      // runaction-exempt: read-only connection test — the outcome renders
      // inline in the Test Result modal below, not as a toast.
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

  // #4068: who loses sign-in if enforcement goes live for this change.
  // Three-valued: 'aborted' (session dead — the caller must NOT fire the
  // mutation, the redirect is the feedback), 'unavailable' (preflight read
  // failed — the caller falls through to the save, because the API's own
  // confirm-through 409 is the backstop and both mutation paths route that
  // 409 back into this same confirm dialog), or the population itself.
  const fetchEnforcementPreflight = useCallback(async (
    body: Record<string, unknown>
  ): Promise<EnforcementPreflight | 'unavailable' | 'aborted'> => {
    try {
      // runaction-exempt: read-only preflight probe — its result feeds the
      // lockout confirm dialog (or is silently unavailable), never a toast.
      const response = await fetchWithAuth('/sso/providers/enforcement-preflight', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (response.status === 401) {
        void navigateTo('/login', { replace: true });
        return 'aborted';
      }
      if (response.ok) {
        const data = (await response.json()).data;
        if (data) return data as EnforcementPreflight;
      }
      // A persistently broken preflight silently degrades the UX to
      // raw-409-driven confirms — leave a trace of why.
      console.error('[sso] enforcement preflight unavailable', response.status);
    } catch (err) {
      console.error('[sso] enforcement preflight failed', err);
    }
    return 'unavailable';
  }, []);

  const openLockoutConfirm = (preflight: EnforcementPreflight, action: PendingEnforceAction) => {
    setEnforcePreflight(preflight);
    setPendingEnforceAction(action);
    setLockoutAcknowledged(false);
  };

  const closeLockoutConfirm = () => {
    setEnforcePreflight(null);
    setPendingEnforceAction(null);
    setLockoutAcknowledged(false);
  };

  const performToggleStatus = async (provider: SsoProvider, newStatus: 'active' | 'inactive', acknowledgeLockout: boolean) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/sso/providers/${provider.id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: newStatus, ...(acknowledgeLockout ? { acknowledgeLockout: true } : {}) })
        }),
        errorFallback: t('ssoProvidersPage.failedToUpdateProviderStatus'),
        successMessage: newStatus === 'active'
          ? t('ssoProvidersPage.providerEnabled')
          : t('ssoProvidersPage.providerDisabled'),
        // Same softening as the save path: the raw 409 message is written for
        // API callers, the web user gets the confirm dialog instead (below).
        friendly: (code) => code === 'sso_enforcement_lockout_confirmation_required'
          ? t('ssoProvidersPage.enforceLockoutConfirmationNeeded')
          : undefined,
        onUnauthorized: () => navigateTo('/login', { replace: true })
      });

      await fetchProviders();
    } catch (err) {
      // The server backstop refused an unconfirmed lockout (the preflight
      // read failed, or someone became unlinked between preflight and save):
      // converge on the same confirm dialog, fed by the 409's own payload.
      if (err instanceof ActionError && err.code === 'sso_enforcement_lockout_confirmation_required') {
        const preflight = (err.body as { preflight?: EnforcementPreflight } | undefined)?.preflight;
        if (preflight) {
          openLockoutConfirm(preflight, { kind: 'activate', provider });
          return;
        }
      }
      handleActionError(err, t('ssoProvidersPage.anErrorOccurred'));
    }
  };

  const handleToggleStatus = async (provider: SsoProvider, newStatus: 'active' | 'inactive') => {
    // Activating an enforcing provider is a lockout moment — preflight it.
    if (newStatus === 'active' && provider.enforceSSO) {
      const preflight = await fetchEnforcementPreflight({ providerId: provider.id });
      if (preflight === 'aborted') return;
      if (preflight !== 'unavailable' && preflight.unlinkedCount > 0) {
        openLockoutConfirm(preflight, { kind: 'activate', provider });
        return;
      }
    }
    await performToggleStatus(provider, newStatus, false);
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
      // runaction-exempt: read-only connection test — the outcome renders
      // inline in the Test Result modal below, not as a toast.
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
    // #4068: enabling Enforce SSO on an EDIT (newly — keeping it on isn't a
    // transition) can lock out every unlinked user on the axis. Preflight and
    // demand explicit confirmation naming them before the save goes out.
    // Deliberately NOT on create, and NOT on an INACTIVE provider: providers
    // are born inactive and enforcement only bites while status is 'active'
    // (the server guard has the same status term), so neither transition can
    // lock anyone out — the warning fires at the activation toggle, where
    // it's true. Warning earlier would cry lockout (including a false
    // self-lockout) on 100% of first-time setups.
    const newlyEnforcing = values.enforceSSO
      && modalMode === 'edit'
      && !selectedProviderDetails?.enforceSSO
      && (selectedProviderDetails?.status ?? selectedProvider?.status) === 'active';
    if (newlyEnforcing && selectedProvider) {
      setSubmitting(true);
      const preflight = await fetchEnforcementPreflight({ providerId: selectedProvider.id });
      setSubmitting(false);
      if (preflight === 'aborted') return;
      if (preflight !== 'unavailable' && preflight.unlinkedCount > 0) {
        openLockoutConfirm(preflight, { kind: 'save', values });
        return;
      }
    }
    await submitProvider(values, false);
  };

  const submitProvider = async (values: SsoProviderFormValues, acknowledgeLockout: boolean) => {
    setSubmitting(true);
    try {
      const url = modalMode === 'edit' && selectedProvider
        ? `/sso/providers/${selectedProvider.id}`
        : '/sso/providers';
      const method = modalMode === 'edit' ? 'PATCH' : 'POST';

      // Don't send empty client secret on edit
      const payload: Record<string, unknown> = { ...values };
      if (modalMode === 'edit') {
        if (!payload.clientSecret) delete payload.clientSecret;
        // ownerScope is create-only (the update schema omits it); never PATCH it.
        delete payload.ownerScope;
        // #4068: confirm-through for the API's lockout guard. Only PATCH (and
        // the status route) accept it — a create can't lock anyone out because
        // providers are born inactive.
        if (acknowledgeLockout) payload.acknowledgeLockout = true;
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
        successMessage: modalMode === 'edit'
          ? t('ssoProvidersPage.providerUpdated')
          : t('ssoProvidersPage.providerCreated'),
        // The raw 409 message is written for API callers ("resend with
        // acknowledgeLockout: true") — the web user gets the confirm dialog
        // instead (below), so soften the toast to match.
        friendly: (code) => code === 'sso_enforcement_lockout_confirmation_required'
          ? t('ssoProvidersPage.enforceLockoutConfirmationNeeded')
          : undefined,
        onUnauthorized: () => navigateTo('/login', { replace: true })
      });

      await fetchProviders();
      handleCloseModal();
    } catch (err) {
      // Server backstop refused an unconfirmed lockout (preflight was
      // unavailable, or the population changed between preflight and save):
      // open the same confirm dialog from the 409's own payload so the admin
      // can actually proceed — never leave them looping on a toast.
      if (err instanceof ActionError && err.code === 'sso_enforcement_lockout_confirmation_required') {
        const preflight = (err.body as { preflight?: EnforcementPreflight } | undefined)?.preflight;
        if (preflight) {
          openLockoutConfirm(preflight, { kind: 'save', values });
          return;
        }
      }
      handleActionError(err, t('ssoProvidersPage.anErrorOccurred'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmEnforceLockout = async () => {
    if (!pendingEnforceAction || !lockoutAcknowledged) return;
    const action = pendingEnforceAction;
    closeLockoutConfirm();
    if (action.kind === 'save') {
      await submitProvider(action.values, true);
    } else {
      await performToggleStatus(action.provider, 'active', true);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedProvider) return;

    setSubmitting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/sso/providers/${selectedProvider.id}`, { method: 'DELETE' }),
        errorFallback: t('ssoProvidersPage.failedToDeleteProvider'),
        successMessage: t('ssoProvidersPage.providerDeleted'),
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
                      enforceSSO: selectedProviderDetails.enforceSSO ?? false,
                      trustsIdpMfa: selectedProviderDetails.trustsIdpMfa ?? false
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

      {/* #4068: Enforce-SSO lockout confirmation. Rendered ABOVE any open
          modal (z-60 > z-50) so the add/edit form keeps its state when the
          admin cancels. */}
      {enforcePreflight && pendingEnforceAction && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs" data-testid="enforce-lockout-modal">
            <h2 className="text-lg font-semibold text-destructive">
              {t('ssoProvidersPage.enforceLockoutTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('ssoProvidersPage.enforceLockoutSummary', {
                unlinked: enforcePreflight.unlinkedCount,
                total: enforcePreflight.totalActiveUsers
              })}
            </p>

            <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-3 text-sm">
              {enforcePreflight.unlinked.map(user => (
                <li key={user.id} data-testid="enforce-lockout-user" className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{user.email}</span>
                  {user.isSelf && (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                      {t('ssoProvidersPage.enforceLockoutSelfBadge')}</span>
                  )}
                  {user.hasPasskey && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t('ssoProvidersPage.enforceLockoutHasPasskey')}</span>
                  )}
                </li>
              ))}
              {enforcePreflight.truncated && (
                <li className="text-xs text-muted-foreground">{t('ssoProvidersPage.enforceLockoutTruncated')}</li>
              )}
            </ul>

            {enforcePreflight.selfLockedOut && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <p className="text-sm font-medium text-destructive">
                  {t('ssoProvidersPage.enforceLockoutSelfWarning')}</p>
              </div>
            )}

            <label className="mt-4 flex items-start gap-3">
              <input
                type="checkbox"
                data-testid="enforce-lockout-ack"
                checked={lockoutAcknowledged}
                onChange={e => setLockoutAcknowledged(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              <span className="text-sm">{t('ssoProvidersPage.enforceLockoutAcknowledge')}</span>
            </label>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                data-testid="enforce-lockout-cancel"
                onClick={closeLockoutConfirm}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('ssoProvidersPage.cancel')}</button>
              <button
                type="button"
                data-testid="enforce-lockout-confirm"
                onClick={handleConfirmEnforceLockout}
                disabled={!lockoutAcknowledged || submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('ssoProvidersPage.enforceLockoutConfirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
