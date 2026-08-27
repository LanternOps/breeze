import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Save, Unplug } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { Dialog } from '../shared/Dialog';

/** One platform-vetted catalog entry, as summarized by GET /ai/provider (#3922 W4). */
type CatalogEntry = {
  entryId: string;
  slug: string;
  name: string;
  dataNote: string | null;
  models: string[];
};

/** Shape of GET /ai/provider. The API never returns the key itself. */
type ProviderStatus = {
  configured: boolean;
  provider: string | null;
  keyLast4: string | null;
  defaultModel: string | null;
  /** The model the resolver will actually send (`defaultModel ?? platform
   *  default`). Verification banners must compare against this, not the
   *  stored pin — an unpinned partner still routes a concrete model (#3922 W4). */
  effectiveDefaultModel: string | null;
  status: 'platform' | 'active' | 'error';
  verifiedAt: string | null;
  lastError: string | null;
  supportedModels: string[];
  /** The platform-catalog endpoint this partner has selected, or null for
   *  direct Anthropic (#3922 W3/W4). */
  catalogEntryId: string | null;
  /** Platform-vetted third-party endpoints available for selection. Empty
   *  when the catalog feature is disabled or nothing is listed. */
  catalog: CatalogEntry[];
};

/** Mutation responses (POST /key, DELETE) omit these read-only fields — preserve them. */
type ProviderMutationResult = Omit<
  Partial<ProviderStatus>,
  'supportedModels' | 'catalog' | 'effectiveDefaultModel'
>;

export default function PartnerAiProviderTab() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Track fetch failures separately: a 403 means "not allowed to manage this",
  // anything else is an outage — neither should read as the platform-key state.
  const [loadError, setLoadError] = useState<'forbidden' | 'failed' | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchWithAuth('/ai/provider');
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        setLoadError(response.status === 403 ? 'forbidden' : 'failed');
        return;
      }
      const data: ProviderStatus = await response.json();
      setStatus({
        ...data,
        supportedModels: Array.isArray(data.supportedModels) ? data.supportedModels : [],
        catalog: Array.isArray(data.catalog) ? data.catalog : [],
        catalogEntryId: data.catalogEntryId ?? null,
        effectiveDefaultModel: data.effectiveDefaultModel ?? null,
      });
    } catch (err) {
      // This load IS the recovery surface for a delisted endpoint pin (the
      // "Anthropic (direct)" escape hatch lives on it), so a silent failure is
      // the same dead end it exists to prevent. The banner below tells the
      // user; the log tells whoever has to explain why.
      console.error('[PartnerAiProviderTab] failed to load /ai/provider', err);
      setLoadError('failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

  const applyMutationResult = (result: ProviderMutationResult) => {
    setStatus(prev => prev
      ? {
          ...prev,
          ...result,
          supportedModels: prev.supportedModels,
          catalog: prev.catalog,
          effectiveDefaultModel: prev.effectiveDefaultModel,
        }
      : prev);
  };

  const handleSaveKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed || savingKey) return;
    setSavingKey(true);
    try {
      await runAction<ProviderMutationResult>({
        request: () => fetchWithAuth('/ai/provider/key', {
          method: 'POST',
          body: JSON.stringify({ apiKey: trimmed }),
        }),
        successMessage: t('partnerAiProvider.keySaved'),
        errorFallback: t('partnerAiProvider.keySaveFailed'),
        onUnauthorized,
      });
      // Write-only field: never keep the key around after a successful save.
      setApiKey('');
      // Refetch rather than merging the POST echo: the route reports the
      // *effective* model (stored ?? platform default), which is not the
      // stored value — merging it would show a pin that was never saved.
      await fetchStatus();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('partnerAiProvider.keySaveFailed') });
      // non-401 ActionError already toasted by runAction (it surfaces the API's `error` message)
    } finally {
      setSavingKey(false);
    }
  };

  const handleModelChange = async (raw: string) => {
    if (!status) return;
    const next = raw === '' ? null : raw;
    const previous = status.defaultModel;
    // Keep the select bound to state so the rendered value always reflects the
    // fetched (or just-chosen) model — never an orphan '' read.
    setStatus(prev => (prev ? { ...prev, defaultModel: next } : prev));
    try {
      await runAction({
        request: () => fetchWithAuth('/ai/provider', {
          method: 'PATCH',
          body: JSON.stringify({ defaultModel: next }),
        }),
        successMessage: t('partnerAiProvider.modelUpdated'),
        errorFallback: t('partnerAiProvider.modelUpdateFailed'),
        onUnauthorized,
      });
      // Refetch like every other mutation here: changing the pin changes the
      // model the resolver ACTUALLY routes (`defaultModel ?? platform default`),
      // and the endpoint verification banner is computed from that. Un-pinning
      // without a refetch keeps the pre-un-pin effectiveDefaultModel, which
      // hides (or falsely keeps) the banner while every AI call 503s.
      await fetchStatus();
    } catch (err) {
      // Revert the optimistic selection — the server kept the old model.
      setStatus(prev => (prev ? { ...prev, defaultModel: previous } : prev));
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('partnerAiProvider.modelUpdateFailed') });
    }
  };

  const handleDisconnect = async () => {
    if (disconnecting) return;
    if (!window.confirm(t('partnerAiProvider.disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/ai/provider', { method: 'DELETE' }),
        successMessage: t('partnerAiProvider.disconnected'),
        errorFallback: t('partnerAiProvider.disconnectFailed'),
        onUnauthorized,
      });
      applyMutationResult({
        configured: false,
        keyLast4: null,
        defaultModel: null,
        status: 'platform',
        verifiedAt: null,
        lastError: null,
        catalogEntryId: null,
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('partnerAiProvider.disconnectFailed') });
    } finally {
      setDisconnecting(false);
    }
  };

  // The catalog entry a non-direct radio click is confirming — non-null opens
  // the consent dialog. Direct selection never sets this (submits immediately).
  const [pendingEntry, setPendingEntry] = useState<CatalogEntry | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [switchingEndpoint, setSwitchingEndpoint] = useState(false);
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());

  const submitEndpoint = useCallback(async (catalogEntryId: string | null, acknowledgeDataNote: boolean) => {
    setSwitchingEndpoint(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/ai/provider/endpoint', {
          method: 'POST',
          body: JSON.stringify({ catalogEntryId, acknowledgeDataNote }),
        }),
        successMessage: t('partnerAiProvider.endpointUpdated'),
        errorFallback: t('partnerAiProvider.endpointUpdateFailed'),
        onUnauthorized,
      });
      setPendingEntry(null);
      setConsentChecked(false);
      // Refetch: the write only echoes `catalogEntryId`/`configVersion`, and the
      // model-mapping/verified-models the endpoint card renders live on the
      // GET payload's `catalog` array, not the mutation response.
      await fetchStatus();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('partnerAiProvider.endpointUpdateFailed') });
      // non-401 ActionError already toasted by runAction
    } finally {
      setSwitchingEndpoint(false);
    }
  }, [t, fetchStatus]);

  const handleSelectDirect = () => {
    if (!status || status.catalogEntryId === null || switchingEndpoint) return;
    void submitEndpoint(null, false);
  };

  const handleSelectEntry = (entry: CatalogEntry) => {
    if (!status || status.catalogEntryId === entry.entryId || switchingEndpoint) return;
    setPendingEntry(entry);
    setConsentChecked(false);
  };

  const closeEndpointDialog = () => {
    if (switchingEndpoint) return;
    setPendingEntry(null);
    setConsentChecked(false);
  };

  const handleConfirmEntry = () => {
    if (!pendingEntry) return;
    if (pendingEntry.dataNote && !consentChecked) return;
    void submitEndpoint(pendingEntry.entryId, !!pendingEntry.dataNote && consentChecked);
  };

  const toggleDataNote = (entryId: string) => {
    setExpandedNotes(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };

  const selectedCatalogEntry = useMemo(() => {
    if (!status || status.catalogEntryId === null) return null;
    return status.catalog.find(entry => entry.entryId === status.catalogEntryId) ?? null;
  }, [status]);
  const isEndpointDelisted = !!status && status.catalogEntryId !== null && selectedCatalogEntry === null;
  // The resolver routes `defaultModel ?? platform default`, so an unpinned
  // partner still has a concrete model that can fall out of an entry's
  // verified set. Prefer the stored pin (kept live by the optimistic model
  // select) and fall back to the server-reported effective default.
  // Deliberate: null means "unknown", and the banner stays suppressed. An older
  // API image mid rolling-deploy omits `effectiveDefaultModel` entirely, so for
  // an unpinned partner this is null until the next refetch lands on a new pod
  // — a transient false negative we accept over a banner we cannot substantiate.
  const effectiveModel = status ? status.defaultModel ?? status.effectiveDefaultModel : null;
  const isEndpointModelUnverified = !!status
    && selectedCatalogEntry !== null
    && effectiveModel !== null
    && !selectedCatalogEntry.models.includes(effectiveModel);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="ai-provider-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError === 'forbidden') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ai-provider-forbidden">
        {t('partnerAiProvider.permissionDenied')}
      </p>
    );
  }

  if (loadError === 'failed' || !status) {
    return (
      <div className="space-y-3" data-testid="ai-provider-load-error">
        <p className="text-sm text-destructive">{t('partnerAiProvider.loadFailed')}</p>
        <button
          type="button"
          onClick={() => { void fetchStatus(); }}
          className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  const connected = status.configured;

  return (
    <div className="space-y-6" data-testid="partner-ai-provider-tab">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('partnerAiProvider.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('partnerAiProvider.subtitle')}</p>
      </div>

      {/* Status card */}
      <div className="rounded-md border bg-muted/30 p-4" data-testid="ai-provider-status-card">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          {connected ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {t('partnerAiProvider.yourKey', { last4: status.keyLast4 ?? '' })}
              </p>
              <p className="text-xs text-muted-foreground">
                {status.verifiedAt
                  ? t('partnerAiProvider.verifiedAt', { date: formatDateTime(status.verifiedAt) })
                  : t('partnerAiProvider.notVerifiedYet')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('partnerAiProvider.defaultModelValue', {
                  model: status.defaultModel ?? t('partnerAiProvider.platformDefault'),
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('partnerAiProvider.platformKey')}</p>
              <p className="text-xs text-muted-foreground">{t('partnerAiProvider.platformKeyDescription')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Error state: the saved key stopped working — fail-loud, never a silent fallback. */}
      {connected && status.status === 'error' && (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-destructive"
          data-testid="ai-provider-error-banner"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t('partnerAiProvider.keyErrorTitle')}
          </p>
          {status.lastError && <p className="text-sm">{status.lastError}</p>}
          <p className="text-sm">{t('partnerAiProvider.reconnectHint')}</p>
        </div>
      )}

      {/* Endpoint card: whenever the platform-vetted catalog has entries, OR
          this partner is still pinned to one. The second half is the recovery
          path — a delisted entry (or a switched-off catalog flag) returns an
          EMPTY catalog while the resolver 503s every AI request and key
          rotation 409s, so the "Anthropic (direct)" radio below must stay
          reachable; without it, DELETE (which destroys the stored key) is the
          only way out.
          Selecting an endpoint requires a saved key — attempting it without
          one fails loud via the API's own message, surfaced by runAction. */}
      {(status.catalog.length > 0 || status.catalogEntryId !== null) && (
        <div className="space-y-3 rounded-md border p-4" data-testid="ai-provider-endpoint-card">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{t('partnerAiProvider.endpointCardTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('partnerAiProvider.endpointCardSubtitle')}</p>
          </div>

          {isEndpointDelisted && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              data-testid="ai-provider-endpoint-delisted-banner"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('partnerAiProvider.endpointDelistedBanner')}</span>
            </div>
          )}
          {!isEndpointDelisted && isEndpointModelUnverified && effectiveModel && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              data-testid="ai-provider-endpoint-model-unverified-banner"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('partnerAiProvider.endpointModelUnverifiedBanner', { model: effectiveModel })}</span>
            </div>
          )}

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="ai-provider-endpoint"
                data-testid="ai-provider-endpoint-direct-radio"
                checked={status.catalogEntryId === null}
                onChange={handleSelectDirect}
                disabled={switchingEndpoint}
              />
              {t('partnerAiProvider.directOptionLabel')}
            </label>

            {status.catalog.map(entry => (
              <div key={entry.entryId} className="space-y-1 rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ai-provider-endpoint"
                    data-testid={`ai-provider-endpoint-radio-${entry.entryId}`}
                    checked={status.catalogEntryId === entry.entryId}
                    onChange={() => handleSelectEntry(entry)}
                    disabled={switchingEndpoint}
                  />
                  <span className="font-medium">{entry.name}</span>
                </label>
                <p className="ml-6 text-xs text-muted-foreground">
                  {entry.models.length > 0
                    ? t('partnerAiProvider.verifiedModelsLabel', { models: entry.models.join(', ') })
                    : t('partnerAiProvider.noVerifiedModels')}
                </p>
                {entry.dataNote && (
                  <div className="ml-6">
                    <button
                      type="button"
                      data-testid={`ai-provider-endpoint-datanote-toggle-${entry.entryId}`}
                      onClick={() => toggleDataNote(entry.entryId)}
                      className="text-xs font-medium text-muted-foreground underline hover:text-foreground"
                    >
                      {expandedNotes.has(entry.entryId)
                        ? t('partnerAiProvider.hideDataNote')
                        : t('partnerAiProvider.viewDataNote')}
                    </button>
                    {expandedNotes.has(entry.entryId) && (
                      <p
                        data-testid={`ai-provider-endpoint-datanote-${entry.entryId}`}
                        className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground"
                      >
                        {entry.dataNote}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connect / replace form */}
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">
          {connected ? t('partnerAiProvider.replaceKeyTitle') : t('partnerAiProvider.connectKeyTitle')}
        </h3>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="ai-provider-key-input">
            {t('partnerAiProvider.keyLabel')}
          </label>
          <input
            id="ai-provider-key-input"
            data-testid="ai-provider-key-input"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-ant-…"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
          <p className="text-xs text-muted-foreground">{t('partnerAiProvider.writeOnlyHint')}</p>
        </div>
        <button
          type="button"
          data-testid="ai-provider-save-key"
          onClick={() => { void handleSaveKey(); }}
          disabled={savingKey || apiKey.trim() === ''}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {savingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {savingKey ? t('common:states.saving') : t('partnerAiProvider.saveKey')}
        </button>
      </div>

      {/* Default model + disconnect only apply while a partner key is connected. */}
      {connected && (
        <>
          <div className="space-y-2 rounded-md border p-4">
            <label className="text-sm font-medium" htmlFor="ai-provider-model-select">
              {t('partnerAiProvider.defaultModelLabel')}
            </label>
            <select
              id="ai-provider-model-select"
              data-testid="ai-provider-model-select"
              value={status.defaultModel ?? ''}
              onChange={e => { void handleModelChange(e.target.value); }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('partnerAiProvider.platformDefault')}</option>
              {status.supportedModels.map(model => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('partnerAiProvider.defaultModelHint')}</p>
          </div>

          <div className="flex items-center justify-between rounded-md border border-destructive/40 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('partnerAiProvider.disconnectTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('partnerAiProvider.disconnectDescription')}</p>
            </div>
            <button
              type="button"
              data-testid="ai-provider-disconnect"
              onClick={() => { void handleDisconnect(); }}
              disabled={disconnecting}
              className="inline-flex items-center gap-2 rounded-md border border-destructive/60 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              {t('partnerAiProvider.disconnect')}
            </button>
          </div>
        </>
      )}

      {/* Workspace enrichment now routes through the configured provider (platform key or BYOK) and is metered under the caller's usage. */}
      <p className="text-xs text-muted-foreground" data-testid="ai-provider-workspace-note">
        {t('partnerAiProvider.workspaceDisclosure')}
      </p>

      {/* Non-direct endpoint confirm dialog. Consent is only required when the
          entry carries a data note — an entry with none has nothing to confirm
          beyond the switch itself, so the checkbox does not render. */}
      <Dialog
        open={pendingEntry !== null}
        onClose={closeEndpointDialog}
        title={pendingEntry ? t('partnerAiProvider.confirmDialogTitle', { name: pendingEntry.name }) : ''}
        maxWidth="md"
        className="p-6"
      >
        {pendingEntry && (
          <div className="space-y-4" data-testid="ai-provider-endpoint-confirm-dialog">
            <p className="text-sm text-muted-foreground">
              {pendingEntry.dataNote
                ? t('partnerAiProvider.confirmDialogMessageWithNote', { name: pendingEntry.name })
                : t('partnerAiProvider.confirmDialogMessageNoNote', { name: pendingEntry.name })}
            </p>
            {pendingEntry.dataNote && (
              <blockquote
                data-testid="ai-provider-endpoint-confirm-datanote"
                className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm"
              >
                {pendingEntry.dataNote}
              </blockquote>
            )}
            {pendingEntry.dataNote && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="ai-provider-endpoint-consent-checkbox"
                  checked={consentChecked}
                  onChange={e => setConsentChecked(e.target.checked)}
                  className="mt-0.5"
                />
                {t('partnerAiProvider.consentCheckboxLabel', { name: pendingEntry.name })}
              </label>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                data-testid="ai-provider-endpoint-confirm-cancel"
                onClick={closeEndpointDialog}
                disabled={switchingEndpoint}
                className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                data-testid="ai-provider-endpoint-confirm-submit"
                onClick={handleConfirmEntry}
                disabled={switchingEndpoint || (!!pendingEntry.dataNote && !consentChecked)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {switchingEndpoint ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common:actions.confirm')}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
