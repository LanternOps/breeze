import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import CreateMonitorForm from '@/components/monitors/CreateMonitorForm';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { extractApiError } from '@/lib/apiError';
import { asList } from '@/lib/asList';
import { formatRelativeTime } from '@/lib/dateTimeFormat';
import { ActionError } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import { SettingsSectionShell } from './SettingsSectionShell';
import { SnmpConfigForm, type SnmpDraft, type SnmpTemplateOption } from './SnmpConfigForm';
import { useNetworkAssetMutations, type SnmpUpsertInput, type TemplateSuggestion } from './useNetworkAssetMutations';

type SnmpDevice = Partial<SnmpUpsertInput> & {
  id: string;
  isActive: boolean;
  lastStatus: string | null;
  lastPolled: string | null;
};
type AssetMonitoringDetail = {
  enabled: boolean;
  snmpDevice: SnmpDevice | null;
  networkMonitors?: { totalCount: number; activeCount: number };
};
type SuggestTemplateEnvelope = {
  sysObjectId: string | null;
  assetType: string | null;
  suggestion: TemplateSuggestion | null;
};
type AssetNetworkCheck = {
  id: string;
  name: string;
  monitorType: string;
  isActive: boolean;
  lastStatus: string | null;
  lastChecked: string | null;
};

function draftFrom(snmp?: SnmpDevice | null): SnmpDraft {
  return {
    snmpVersion: snmp?.snmpVersion ?? 'v2c',
    community: '',
    username: snmp?.username ?? '',
    authProtocol: snmp?.authProtocol ?? 'sha',
    authPassword: '',
    privProtocol: snmp?.privProtocol ?? 'aes',
    privPassword: '',
    templateId: snmp?.templateId ?? '',
    pollingInterval: snmp?.pollingInterval ?? 300,
    port: snmp?.port ?? 161,
  };
}

const buttonClass = 'rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const collectionStates = new Set(['ok', 'failing', 'no_template', 'no_agent', 'asset_moved', 'never_polled', 'paused', 'warning', 'offline', 'unknown']);

export function MonitoringSection({ asset, assetId, onSaved, onAnnounce }: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | boolean | Promise<void | boolean>;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  const { putSnmp, patchSnmp, disableMonitoring, deleteCheck } = useNetworkAssetMutations();
  const [detail, setDetail] = useState<AssetMonitoringDetail | null>(null);
  const [checks, setChecks] = useState<AssetNetworkCheck[]>([]);
  const [templates, setTemplates] = useState<SnmpTemplateOption[]>([]);
  const [suggestion, setSuggestion] = useState<TemplateSuggestion | null>(null);
  const [detailError, setDetailError] = useState<string>();
  const [suggestionsError, setSuggestionsError] = useState(false);
  const [checksError, setChecksError] = useState(false);
  const [templatesError, setTemplatesError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [removeCheck, setRemoveCheck] = useState<AssetNetworkCheck | null>(null);
  const [addingCheck, setAddingCheck] = useState(false);
  const [draft, setDraft] = useState<SnmpDraft>(() => draftFrom());
  const generation = useRef(0);
  const actionPending = useRef(false);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    // Keep independent read failures local: missing templates/checks must not
    // turn an existing SNMP configuration into a create, or erase its draft.
    const read = async (url: string) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw Object.assign(new Error(extractApiError(body, t('networkDeviceDetailPage.settings.monitoring.loadFailed'))), { status: response.status });
      }
      return response.json();
    };
    const [detailResult, checksResult, templatesResult, suggestResult] = await Promise.allSettled([
      read(`/monitoring/assets/${assetId}`),
      read(`/monitors?assetId=${encodeURIComponent(assetId)}`),
      read('/snmp/templates'),
      read(`/monitoring/templates/suggest?assetId=${encodeURIComponent(assetId)}`),
    ]);
    if (request !== generation.current) return;
    const nextDetail = detailResult.status === 'fulfilled' ? detailResult.value as AssetMonitoringDetail | null : null;
    if (nextDetail) {
      setDetail(nextDetail);
      setDraft(draftFrom(nextDetail.snmpDevice));
      setDetailError(undefined);
    } else {
      setDetailError(detailResult.status === 'rejected' && detailResult.reason instanceof Error
        ? detailResult.reason.message : t('networkDeviceDetailPage.settings.monitoring.loadFailed'));
    }
    setChecks(checksResult.status === 'fulfilled' ? asList<AssetNetworkCheck>(checksResult.value) : []);
    setChecksError(checksResult.status === 'rejected');
    setTemplates(templatesResult.status === 'fulfilled' ? asList<SnmpTemplateOption>(templatesResult.value, 'templates') : []);
    setTemplatesError(templatesResult.status === 'rejected');
    // W03 is optional only when its route is absent. Other failures remain visible.
    const suggestionFailed = suggestResult.status === 'rejected' && suggestResult.reason?.status !== 404;
    setSuggestionsError(suggestionFailed);
    if (suggestionFailed && suggestResult.status === 'rejected') {
      console.warn('[network-settings] template suggestion failed', assetId, suggestResult.reason);
    }
    setSuggestion(suggestResult.status === 'fulfilled'
      ? (suggestResult.value as SuggestTemplateEnvelope | null)?.suggestion ?? null
      : null);
    setLoading(false);
  }, [assetId, t]);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    setDraft(draftFrom());
    setDetailError(undefined);
    setError(undefined);
    setConflict(false);
    setDisableOpen(false);
    setRemoveCheck(null);
    setAddingCheck(false);
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  const snmp = detail?.snmpDevice;
  const baseline = useMemo(() => draftFrom(snmp), [snmp]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const blocked = loading || saving || Boolean(detailError);
  const hasStoredCommunity = Boolean(snmp?.community);

  const notifySaved = async () => {
    if (await onSaved() === false) {
      showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
    }
  };

  const perform = async (action: () => Promise<void>, fallback: string) => {
    if (actionPending.current || blocked) return;
    actionPending.current = true;
    setSaving(true);
    setError(undefined);
    setConflict(false);
    try {
      await action();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.status === 409) {
        setConflict(true);
        await refresh(); // Re-baseline even if the server returns the same config.
        return;
      }
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
    } finally {
      actionPending.current = false;
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (blocked || !dirty) return;
    if (draft.snmpVersion !== 'v3' && !hasStoredCommunity && !draft.community.trim()) {
      setError(t('networkDeviceDetailPage.settings.monitoring.communityRequired'));
      return;
    }
    if (draft.snmpVersion === 'v3' && !draft.username.trim()) {
      setError(t('networkDeviceDetailPage.settings.monitoring.usernameRequired'));
      return;
    }
    if (!Number.isInteger(draft.pollingInterval) || draft.pollingInterval < 30 || draft.pollingInterval > 86400) {
      setError(t('networkDeviceDetailPage.settings.monitoring.invalidInterval'));
      return;
    }
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
      setError(t('networkDeviceDetailPage.settings.monitoring.invalidPort'));
      return;
    }
    const payload: SnmpUpsertInput = {
      snmpVersion: draft.snmpVersion,
      pollingInterval: draft.pollingInterval,
      port: draft.port,
    };
    // #6099: the server treats an ABSENT templateId as "no explicit choice,
    // auto-apply a suggestion" and an explicit `null` as "clear it" — two
    // different requests. Only include the key when the user actually
    // touched the template selector in this edit (a pick or an explicit
    // clear); leaving it untouched must omit the key so server-side
    // auto-apply stays reachable.
    if (draft.templateId !== baseline.templateId) {
      payload.templateId = draft.templateId || null;
    }
    if (draft.snmpVersion === 'v3') {
      if (draft.username.trim()) payload.username = draft.username.trim();
      payload.authProtocol = draft.authProtocol;
      payload.privProtocol = draft.privProtocol;
      if (draft.authPassword) payload.authPassword = draft.authPassword;
      if (draft.privPassword) payload.privPassword = draft.privPassword;
    } else if (draft.community.trim()) {
      payload.community = draft.community.trim();
    }
    void perform(async () => {
      const result = await (snmp ? patchSnmp(assetId, payload) : putSnmp(assetId, payload));
      await refresh();
      if (result && 'templateSuggestion' in result) setSuggestion(result.templateSuggestion ?? null);
      await notifySaved();
      onAnnounce(t('networkDeviceDetailPage.settings.toasts.snmpSaved'));
    }, t('networkDeviceDetailPage.settings.toasts.snmpSaveFailed'));
  };

  const collectionStatus = !snmp?.isActive ? 'paused'
    : snmp.lastStatus === 'online' ? 'ok'
      : !snmp.lastStatus ? 'never_polled'
        : collectionStates.has(snmp.lastStatus) ? snmp.lastStatus : 'unknown';
  const age = (value: string | null) => formatRelativeTime(value, { fallback: t('networkDeviceDetailPage.settings.monitoring.never') });

  return (
    <SettingsSectionShell section="monitoring"
      title={t('networkDeviceDetailPage.settings.sections.monitoring')}
      description={t('networkDeviceDetailPage.settings.monitoring.description')}
      dirty={dirty} saving={saving} saveDisabled={loading || Boolean(detailError)}
      onSave={handleSave}
      onCancel={() => { setDraft(baseline); setError(undefined); setConflict(false); }}>
      <div className="space-y-5">
        {loading && <p role="status" className="text-sm text-muted-foreground">{t('common:states.loading')}</p>}
        {!loading && detailError && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm text-destructive">{detailError}</p>
            <button type="button" className={buttonClass} disabled={saving}
              data-testid="network-settings-monitoring-retry" onClick={() => void refresh()}>
              {t('common:actions.retry')}
            </button>
          </div>
        )}
        {!loading && detail && <SnmpConfigForm draft={draft} onChange={(patch) => setDraft((value) => ({ ...value, ...patch }))}
          templates={templates} templatesError={templatesError} suggestion={suggestion}
          onUseSuggestion={() => { if (suggestion) setDraft((value) => ({ ...value, templateId: suggestion.templateId })); }}
          hasStoredCommunity={hasStoredCommunity} hasStoredAuthPassword={Boolean(snmp?.authPassword)}
          hasStoredPrivPassword={Boolean(snmp?.privPassword)} disabled={saving} />}
        {!loading && suggestionsError && <p className="text-xs text-muted-foreground">
          {t('networkDeviceDetailPage.settings.monitoring.suggestionsUnavailable')}
        </p>}
        {error && <p role="alert" data-testid="network-settings-monitoring-error" className="text-sm text-destructive">{error}</p>}
        {conflict && <p role="alert" data-testid="network-settings-monitoring-conflict" className="text-sm text-destructive">{t('networkDeviceDetailPage.settings.monitoring.conflict')}</p>}
        {!loading && snmp && (
          <>
            <p data-testid="network-settings-monitoring-status" className="text-xs text-muted-foreground">
              {t(/* i18n-dynamic */ `networkDeviceDetailPage.settings.monitoring.collectionStatus.${collectionStatus}`)} · SNMP {age(snmp.lastPolled)}
            </p>
            <button type="button" className={buttonClass} disabled={blocked}
              data-testid={snmp.isActive ? 'network-settings-snmp-pause' : 'network-settings-snmp-resume'}
              onClick={() => void perform(async () => {
                await patchSnmp(assetId, { isActive: !snmp.isActive });
                await refresh();
                await notifySaved();
                onAnnounce(snmp.isActive ? t('networkDeviceDetailPage.settings.toasts.pollingPaused') : t('networkDeviceDetailPage.settings.toasts.pollingResumed'));
              }, t('networkDeviceDetailPage.settings.toasts.snmpSaveFailed'))}>
              {snmp.isActive ? t('networkDeviceDetailPage.settings.monitoring.pause') : t('networkDeviceDetailPage.settings.monitoring.resume')}
            </button>
          </>
        )}
        {!loading && (snmp?.isActive || checks.some((check) => check.isActive) || (detail?.networkMonitors?.activeCount ?? 0) > 0) && (
          <div><button type="button" className={`${buttonClass} text-destructive`} disabled={blocked}
            data-testid="network-settings-monitoring-disable" onClick={() => setDisableOpen(true)}>
            {t('networkDeviceDetailPage.settings.monitoring.disable')}
          </button></div>
        )}
        <div className="space-y-3 border-t pt-4">
          <h4 className="text-sm font-semibold">{t('networkDeviceDetailPage.settings.monitoring.checksTitle')}</h4>
          {checksError && <p role="alert" className="text-sm text-destructive">{t('networkDeviceDetailPage.settings.monitoring.checksLoadFailed')}</p>}
          {!loading && !checksError && checks.length === 0 && <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.settings.monitoring.noChecks')}</p>}
          {!loading && checks.map((check) => {
            const state = !check.isActive ? 'paused' : check.lastStatus === 'online' ? 'responding'
              : check.lastStatus === 'degraded' ? 'degraded' : check.lastStatus === 'offline' ? 'notResponding' : 'unverified';
            return (
              <div key={check.id} data-testid={`network-settings-check-${check.id}`} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{check.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(/* i18n-dynamic */ `networkDeviceDetailPage.settings.monitoring.checkState.${state}`)} · {t(/* i18n-dynamic */ `networkDeviceDetailPage.settings.monitoring.checkSource.${check.monitorType}`, { defaultValue: check.monitorType })} {age(check.lastChecked)}
                  </p>
                </div>
                <button type="button" className={buttonClass} disabled={blocked}
                  data-testid={`network-settings-check-remove-${check.id}`} onClick={() => setRemoveCheck(check)}>
                  {t('networkDeviceDetailPage.settings.monitoring.removeCheck')}
                </button>
              </div>
            );
          })}
          <button type="button" className={buttonClass} disabled={blocked || addingCheck}
            data-testid="network-settings-check-add" onClick={() => setAddingCheck(true)}>
            {t('networkDeviceDetailPage.settings.monitoring.addCheck')}
          </button>
        </div>
      </div>
      <ConfirmDialog open={disableOpen} onClose={() => { if (!saving) setDisableOpen(false); }} isLoading={saving}
        title={t('networkDeviceDetailPage.settings.monitoring.disableTitle')}
        message={t('networkDeviceDetailPage.settings.monitoring.disableMessage')}
        confirmTestId="network-settings-monitoring-disable-confirm"
        onConfirm={() => void perform(async () => {
          await disableMonitoring(assetId);
          setDisableOpen(false);
          await refresh();
          await notifySaved();
          onAnnounce(t('networkDeviceDetailPage.settings.toasts.monitoringDisabled'));
        }, t('networkDeviceDetailPage.settings.toasts.monitoringDisableFailed'))} />
      <ConfirmDialog open={Boolean(removeCheck)} onClose={() => { if (!saving) setRemoveCheck(null); }} isLoading={saving}
        title={t('networkDeviceDetailPage.settings.monitoring.removeCheckTitle')}
        message={t('networkDeviceDetailPage.settings.monitoring.removeCheckMessage', { name: removeCheck?.name })}
        confirmTestId="network-settings-check-remove-confirm"
        onConfirm={() => void perform(async () => {
          if (!removeCheck) return;
          await deleteCheck(removeCheck.id);
          setRemoveCheck(null);
          await refresh();
          await notifySaved();
          onAnnounce(t('networkDeviceDetailPage.settings.toasts.checkRemoved'));
        }, t('networkDeviceDetailPage.settings.toasts.checkRemoveFailed'))} />
      {addingCheck && <CreateMonitorForm assetId={assetId} defaultTarget={asset.ip}
        onCancel={() => setAddingCheck(false)} onCreated={() => {
          setAddingCheck(false);
          void perform(async () => {
            await refresh();
            await notifySaved();
            onAnnounce(t('networkDeviceDetailPage.settings.toasts.checkCreated'));
          }, t('networkDeviceDetailPage.settings.toasts.checkCreateFailed'));
        }} />}
    </SettingsSectionShell>
  );
}
