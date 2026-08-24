import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Save, Unplug } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';

/** Shape of GET /ai/provider. The API never returns the key itself. */
type ProviderStatus = {
  configured: boolean;
  provider: string | null;
  keyLast4: string | null;
  defaultModel: string | null;
  status: 'platform' | 'active' | 'error';
  verifiedAt: string | null;
  lastError: string | null;
  supportedModels: string[];
};

/** Mutation responses (POST /key, DELETE) omit supportedModels — preserve it. */
type ProviderMutationResult = Omit<Partial<ProviderStatus>, 'supportedModels'>;

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
      setStatus({ ...data, supportedModels: Array.isArray(data.supportedModels) ? data.supportedModels : [] });
    } catch {
      setLoadError('failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

  const applyMutationResult = (result: ProviderMutationResult) => {
    setStatus(prev => prev
      ? { ...prev, ...result, supportedModels: prev.supportedModels }
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
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('partnerAiProvider.disconnectFailed') });
    } finally {
      setDisconnecting(false);
    }
  };

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

      {/* Spec §3 non-goal disclosure: workspace enrichment stays on the platform key. */}
      <p className="text-xs text-muted-foreground" data-testid="ai-provider-workspace-note">
        {t('partnerAiProvider.workspaceDisclosure')}
      </p>
    </div>
  );
}
