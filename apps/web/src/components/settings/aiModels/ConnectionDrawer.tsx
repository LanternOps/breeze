import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, RefreshCw, Save, Unplug } from 'lucide-react';
import type { AiConnectionDto, AiModelsSnapshotDto } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { Drawer } from '../../shared/Drawer';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { registryFriendly } from './surfaceLabels';

type CatalogEntry = AiModelsSnapshotDto['catalog'][number];

export interface ConnectionDrawerProps {
  /** null = the "Add connection" form. */
  connection: AiConnectionDto | null;
  catalog: CatalogEntry[];
  catalogEnabled: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

export default function ConnectionDrawer({ connection, catalog, catalogEnabled, onClose, onSaved }: ConnectionDrawerProps) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(connection?.name ?? '');
  const [geo, setGeo] = useState<string | null>(connection?.inferenceGeo ?? null);
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState<string | null>(connection?.catalogEntryId ?? null);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  // Set when a Save stored a new endpoint but a later step failed: the prop may
  // still hold the old value until the parent reloads, and a retry must not re-post it.
  const [savedEndpoint, setSavedEndpoint] = useState<{ value: string | null } | null>(null);
  const busy = saving || disconnecting || refreshing;
  const friendly = registryFriendly(t);

  const storedEndpoint = savedEndpoint ? savedEndpoint.value : connection?.catalogEntryId ?? null;
  const keyDirty = apiKey.trim() !== '';
  const endpointDirty = connection !== null && endpoint !== storedEndpoint;
  const nameDirty = connection !== null && name !== connection.name;
  const geoDirty = connection !== null && geo !== connection.inferenceGeo;
  // A new key is probed against the STORED endpoint and a new endpoint against the
  // STORED key (partnerLlmConfig), so changing both in one Save would send the new
  // credential to the old destination. One credential change per Save.
  const bothCredentialsDirty = connection !== null && keyDirty && endpointDirty;
  const selectedEntry = endpoint === null ? null : catalog.find((e) => e.entryId === endpoint) ?? null;
  const consentMissing = endpointDirty && !!selectedEntry?.dataNote && !consent;
  const nameInvalid = connection !== null && name.trim() === '';

  const canSave = connection === null
    ? keyDirty
    : (keyDirty || endpointDirty || nameDirty || geoDirty) && !bothCredentialsDirty && !consentMissing && !nameInvalid;

  const geoOptions = useMemo(() => {
    const geos = new Set(connection?.supportedInferenceGeos ?? []);
    if (geo) geos.add(geo); // never hide a stored value the connection no longer lists
    return [...geos];
  }, [connection, geo]);

  const delisted = connection !== null && storedEndpoint !== null && !catalog.some((e) => e.entryId === storedEndpoint);
  const showEndpointSection = connection !== null && (catalog.length > 0 || storedEndpoint !== null);
  const selectableEntries = catalogEnabled ? catalog : catalog.filter((e) => e.entryId === storedEndpoint);

  const handleSave = async () => {
    if (!canSave || busy) return;
    setSaving(true);
    // Which credential step (key or endpoint) already committed in THIS Save.
    let credentialSaved = false;
    try {
      if (connection === null) {
        await runAction({
          request: () => fetchWithAuth('/ai/models/connections', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'anthropic_byok',
              apiKey: apiKey.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
            }),
          }),
          successMessage: t('aiModels.connections.created'),
          errorFallback: t('aiModels.connections.saveFailed'),
          friendly,
          onUnauthorized,
        });
      } else {
        const base = `/ai/models/connections/${connection.id}`;
        // Guarded by bothCredentialsDirty (Save disabled): never key AND endpoint in one Save.
        if (keyDirty) {
          await runAction({
            request: () => fetchWithAuth(`${base}/key`, { method: 'POST', body: JSON.stringify({ apiKey: apiKey.trim() }) }),
            errorFallback: t('aiModels.connections.keyFailed'),
            friendly,
            onUnauthorized,
          });
          credentialSaved = true;
        } else if (endpointDirty) {
          await runAction({
            request: () => fetchWithAuth(`${base}/endpoint`, {
              method: 'POST',
              body: JSON.stringify({ catalogEntryId: endpoint, acknowledgeDataNote: !!selectedEntry?.dataNote && consent }),
            }),
            errorFallback: t('aiModels.connections.endpointFailed'),
            friendly,
            onUnauthorized,
          });
          credentialSaved = true;
        }
        const patch: Record<string, unknown> = {};
        if (nameDirty) patch.name = name.trim();
        if (geoDirty) patch.inferenceGeo = geo;
        if (Object.keys(patch).length > 0) {
          await runAction({
            request: () => fetchWithAuth(base, { method: 'PATCH', body: JSON.stringify(patch) }),
            errorFallback: t('aiModels.connections.saveFailed'),
            friendly,
            onUnauthorized,
          });
        }
        // One success toast for the whole multi-step Save: the steps above pass no successMessage.
        showToast({ type: 'success', message: t('aiModels.connections.saved') });
      }
      await onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.connections.saveFailed') });
      // non-401 ActionError already toasted by runAction; the drawer stays open
      if (credentialSaved) {
        // The key/endpoint step committed before a later step failed: clear that
        // draft so a retry cannot rotate again, say what did save, and reload.
        if (keyDirty) setApiKey('');
        if (endpointDirty) { setSavedEndpoint({ value: endpoint }); setConsent(false); }
        showToast({ type: 'warning', message: t('aiModels.connections.credentialSavedSettingsFailed') });
        try { await onSaved(); } catch (reloadErr) { console.error('[ConnectionDrawer] reload after partial save failed', reloadErr); }
      }
    } finally {
      setSaving(false);
    }
  };

  // The platform connection has no id (nothing to discover); the Add form has no connection yet.
  const canRefresh = connection !== null && connection.id !== null;

  const handleRefresh = async () => {
    if (connection === null || connection.id === null || busy) return;
    setRefreshing(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/models/connections/${connection.id}/refresh`, { method: 'POST' }),
        successMessage: t('aiModels.connections.refreshQueued'),
        errorFallback: t('aiModels.connections.refreshFailed'),
        friendly,
        onUnauthorized,
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.connections.refreshFailed') });
      // other ActionErrors already toasted by runAction; the drawer stays open
    } finally {
      setRefreshing(false);
    }
  };

  const handleDisconnect = async () => {
    if (connection === null || busy) return;
    setDisconnecting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/models/connections/${connection.id}`, { method: 'DELETE' }),
        successMessage: t('aiModels.connections.disconnected'),
        errorFallback: t('aiModels.connections.disconnectFailed'),
        friendly,
        onUnauthorized,
      });
      setConfirmDisconnect(false);
      await onSaved();
      onClose();
    } catch (err) {
      setConfirmDisconnect(false);
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.connections.disconnectFailed') });
    } finally {
      setDisconnecting(false);
    }
  };

  const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

  return (
    <Drawer
      open
      onClose={onClose}
      title={connection === null ? t('aiModels.drawer.titleCreate') : t('aiModels.drawer.titleEdit', { name: connection.name })}
      dataTestId="ai-connection-drawer"
      closeDisabled={busy}
    >
      <div className="space-y-5">
        {connection?.status === 'error' && (
          <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('aiModels.drawer.errorTitle')}
            </p>
            {connection.lastError && <p>{connection.lastError}</p>}
            <p>{t('aiModels.drawer.reconnectHint')}</p>
          </div>
        )}

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="ai-connection-name">{t('aiModels.drawer.name')}</label>
          <input id="ai-connection-name" data-testid="ai-connection-name" className={inputClass} value={name} maxLength={80}
            onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>

        {connection !== null && (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="ai-connection-geo">{t('aiModels.drawer.geo')}</label>
            <select id="ai-connection-geo" data-testid="ai-connection-geo" className={inputClass} value={geo ?? ''}
              onChange={(e) => setGeo(e.target.value === '' ? null : e.target.value)} disabled={busy}>
              <option value="">{t('aiModels.drawer.geoProviderDefault')}</option>
              {geoOptions.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">{t('aiModels.drawer.geoHint')}</p>
          </div>
        )}

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="ai-connection-key">
            {connection === null ? t('aiModels.drawer.keyLabel') : t('aiModels.drawer.replaceKey')}
          </label>
          <input id="ai-connection-key" data-testid="ai-connection-key" type="password" autoComplete="new-password"
            className={inputClass} value={apiKey} placeholder="sk-ant-…" onChange={(e) => setApiKey(e.target.value)} disabled={busy} />
          <p className="text-xs text-muted-foreground">{t('aiModels.drawer.writeOnlyHint')}</p>
        </div>

        {showEndpointSection && (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="text-sm font-medium">{t('aiModels.drawer.endpoint')}</legend>
            {delisted && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t('aiModels.drawer.endpointDelisted')}</span>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="ai-connection-endpoint" data-testid="ai-connection-endpoint-direct"
                checked={endpoint === null} onChange={() => { setEndpoint(null); setConsent(false); }} />
              {t('aiModels.drawer.endpointDirect')}
            </label>
            {selectableEntries.map((entry) => (
              <div key={entry.entryId} className="space-y-1 rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="ai-connection-endpoint" data-testid={`ai-connection-endpoint-${entry.entryId}`}
                    checked={endpoint === entry.entryId} onChange={() => { setEndpoint(entry.entryId); setConsent(false); }} />
                  <span className="font-medium">{entry.name}</span>
                </label>
                <p className="ml-6 text-xs text-muted-foreground">
                  {entry.models.length > 0
                    ? t('aiModels.drawer.verifiedModels', { models: entry.models.join(', ') })
                    : t('aiModels.drawer.noVerifiedModels')}
                </p>
                {entry.dataNote && endpoint === entry.entryId && (
                  <blockquote className="ml-6 whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{entry.dataNote}</blockquote>
                )}
              </div>
            ))}
            {endpointDirty && selectedEntry?.dataNote && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" data-testid="ai-connection-datanote-consent" className="mt-0.5"
                  checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                {t('aiModels.drawer.consent', { name: selectedEntry.name })}
              </label>
            )}
          </fieldset>
        )}

        {bothCredentialsDirty && (
          <p data-testid="ai-connection-one-credential-change" role="status" className="rounded-md border bg-muted/30 p-3 text-sm">
            {t('aiModels.drawer.oneCredentialChange')}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 border-t pt-4">
          <div className="flex flex-wrap gap-2">
            {canRefresh && (
              <button type="button" data-testid="ai-connection-refresh" onClick={() => { void handleRefresh(); }} disabled={busy}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
                {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {t('aiModels.drawer.refresh')}
              </button>
            )}
            {connection !== null && (
              <button type="button" data-testid="ai-connection-disconnect" onClick={() => setConfirmDisconnect(true)} disabled={busy}
                className="inline-flex items-center gap-2 rounded-md border border-destructive/60 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
                <Unplug className="h-4 w-4" />
                {t('aiModels.drawer.disconnect')}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" data-testid="ai-connection-cancel" onClick={onClose} disabled={busy}
              className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
              {t('common:actions.cancel')}
            </button>
            <button type="button" data-testid="ai-connection-save" onClick={() => { void handleSave(); }} disabled={!canSave || busy}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? t('common:states.saving') : t('common:actions.save')}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => { if (!disconnecting) setConfirmDisconnect(false); }}
        onConfirm={() => { void handleDisconnect(); }}
        title={t('aiModels.drawer.disconnectTitle')}
        message={t('aiModels.drawer.disconnectMessage')}
        confirmLabel={t('aiModels.drawer.disconnect')}
        confirmTestId="ai-connection-disconnect-confirm"
        isLoading={disconnecting}
      />
    </Drawer>
  );
}
