import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  XCircle
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useOrgScope } from '@/hooks/useOrgScope';
import { OrgRequiredState } from '../shared/OrgRequiredState';
import { OrgLoadFailedState } from '../shared/OrgLoadFailedState';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import { navigateTo } from '@/lib/navigation';
import { ActionError } from '@/lib/runAction';
import { useNetworkAssetMutations } from '../devices/networkDevice/settings/useNetworkAssetMutations';
import { buildDetailHash } from '../devices/networkDevice/settings/settingsHash';

/** W01 (spec §4.2). Absent on a pre-W01 API — treat every field as optional. */
type Reachability = {
  state: 'responding' | 'not_responding' | 'unverified';
  source: 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp' | null;
  observedAt: string | null;
};

const SETTINGS_HASH = `#${buildDetailHash('overview', 'monitoring')}`;
const settingsHref = (assetId: string) => `/devices/network/${assetId}${SETTINGS_HASH}`;

const REACHABILITY_STATE_KEYS: Record<Reachability['state'], string> = {
  responding: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.responding',
  not_responding: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.notResponding',
  unverified: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.unverified',
};
const REACHABILITY_SOURCE_KEYS: Record<string, string> = {
  network_check: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.networkCheck',
  probe: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.probe',
  scan: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.scan',
  unifi: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.unifi',
  snmp: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.snmp',
};

/**
 * What the LIST route can honestly say about collection. Spec §6.2's per-OID
 * `collection` object lives on GET /monitoring/assets/:id and is W05's OID
 * table; this is the row-level summary derived from the fields the list
 * already carries, including W01's new `no_template` last_status (§6.1).
 */
type CollectionState = 'not_configured' | 'paused' | 'no_template' | 'never_polled' | 'collecting' | 'partial' | 'failing';

function collectionStateOf(snmp: MonitoringAsset['snmp']): CollectionState {
  if (!snmp.configured) return 'not_configured';
  if (!snmp.isActive) return 'paused';
  if (snmp.lastStatus === 'no_template') return 'no_template';
  if (!snmp.lastPolled) return 'never_polled';
  if (snmp.lastStatus === 'online') return 'collecting';
  if (snmp.lastStatus === 'warning') return 'partial';
  return 'failing';
}

const COLLECTION_STYLES: Record<CollectionState, string> = {
  collecting: 'bg-success/15 text-success border-success/30',
  partial: 'bg-warning/15 text-warning border-warning/30',
  no_template: 'bg-warning/15 text-warning border-warning/30',
  failing: 'bg-destructive/15 text-destructive border-destructive/30',
  paused: 'bg-muted text-muted-foreground border-muted',
  never_polled: 'bg-muted text-muted-foreground border-muted',
  not_configured: 'bg-muted text-muted-foreground border-muted',
};

type MonitoringAsset = {
  reachability?: Reachability | null;
  id: string;
  hostname: string | null;
  ipAddress: string;
  assetType: string;
  lastSeenAt: string | null;
  monitoring: {
    configured: boolean;
    active: boolean;
  };
  snmp: {
    configured: boolean;
    deviceId: string | null;
    snmpVersion: string | null;
    templateId: string | null;
    pollingInterval: number | null;
    port: number | null;
    isActive: boolean;
    lastPolled: string | null;
    lastStatus: string | null;
  };
  network: {
    configured: boolean;
    totalCount: number;
    activeCount: number;
  };
};

function formatRelativeTime(dateString: string | null, t: (key: string, options?: Record<string, unknown>) => string) {
  if (!dateString) return t('longTail.monitoring.MonitoringAssetsDashboard.relative.never');
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 1) return t('longTail.monitoring.MonitoringAssetsDashboard.relative.justNow');
  if (diffMins < 60) return t('longTail.monitoring.MonitoringAssetsDashboard.relative.minutesAgo', { count: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return t('longTail.monitoring.MonitoringAssetsDashboard.relative.hoursAgo', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  return t('longTail.monitoring.MonitoringAssetsDashboard.relative.daysAgo', { count: diffDays });
}

function formatInterval(seconds: number | null) {
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

type Props = {
  initialAssetId?: string | null;
  onOpenChecks?: () => void;
};

export default function MonitoringAssetsDashboard({ initialAssetId, onOpenChecks }: Props) {
  const { t } = useTranslation('common');
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  // Monitoring assets are scoped to a single org; the API returns 400
  // ("orgId is required when partner has multiple organizations") for a
  // multi-org partner with no orgId. Resolve the full context so the render
  // gate can tell fleet view / zero-org (prompt for one org) from a load
  // failure (retry) and the transient pre-hydration frame (spinner) — never
  // collapsing a failure into a confident "no assets" empty state.
  const scope = useOrgScope();
  const [assets, setAssets] = useState<MonitoringAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>();

  const fetchAssets = useCallback(async () => {
    // Don't fire a per-org request with no org — it 400s. The render gate above
    // shows the right non-org state (prompt / retry / spinner) in this case, so
    // bailing here must NOT leave a confident empty asset list behind.
    if (!currentOrgId) {
      setAssets([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (showAll) params.set('includeUnconfigured', 'true');
      params.set('orgId', currentOrgId);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetchWithAuth(`/monitoring/assets${qs}`);
      if (!res.ok) throw new Error(t('longTail.monitoring.MonitoringAssetsDashboard.errors.fetchAssets'));
      const data = await res.json();
      setAssets(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [showAll, currentOrgId, t]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  const configuredCount = useMemo(() => assets.filter((a) => a.monitoring.configured).length, [assets]);
  const activeCount = useMemo(() => assets.filter((a) => a.monitoring.active).length, [assets]);
  const pausedCount = useMemo(() => assets.filter((a) => a.monitoring.configured && !a.monitoring.active).length, [assets]);
  const snmpWarningOrOffline = useMemo(() => assets.filter((a) => {
    if (!a.snmp.configured || !a.snmp.isActive) return false;
    return a.snmp.lastStatus === 'warning' || a.snmp.lastStatus === 'offline';
  }).length, [assets]);

  const { patchSnmp, disableMonitoring } = useNetworkAssetMutations();

  // The ?assetId= deep link used to open an in-page editor. That editor is
  // gone, so send the operator to the surface that replaced it rather than
  // silently dropping the parameter.
  useEffect(() => {
    if (!initialAssetId) return;
    void navigateTo(settingsHref(initialAssetId), { replace: true });
  }, [initialAssetId]);

  const handleToggleSnmpActive = async (assetId: string, nextActive: boolean) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      await patchSnmp(assetId, { isActive: nextActive });
      await fetchAssets();
    } catch (err) {
      if (err instanceof ActionError) return; // 401 redirects; everything else was toasted
      setActionError(t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisableAll = async (assetId: string) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      await disableMonitoring(assetId);
      await fetchAssets();
    } catch (err) {
      if (err instanceof ActionError) return;
      setActionError(t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setActionLoading(null);
    }
  };

  // Spec §10 copy rule: state · source · age. A bare "Online" here is exactly
  // the claim this spec exists to stop making.
  const renderReachabilityCell = (asset: MonitoringAsset) => {
    const r = asset.reachability;
    if (!r?.source || !r.observedAt) {
      return (
        <span
          className="text-xs text-muted-foreground"
          data-testid={`monitoring-asset-reachability-${asset.id}`}
          aria-label={t('common:states.unknown').toLowerCase()}
        >
          —
        </span>
      );
    }
    return (
      <span className="text-xs" data-testid={`monitoring-asset-reachability-${asset.id}`}>
        {t(/* i18n-dynamic */ REACHABILITY_STATE_KEYS[r.state])}
        {' · '}
        {t(/* i18n-dynamic */ REACHABILITY_SOURCE_KEYS[r.source] ?? REACHABILITY_SOURCE_KEYS.scan)}
        {' '}
        {formatRelativeTime(r.observedAt, t)}
      </span>
    );
  };

  const renderCollectionCell = (asset: MonitoringAsset) => {
    const state = collectionStateOf(asset.snmp);
    return (
      <div className="space-y-1" data-testid={`monitoring-asset-collection-${asset.id}`}>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${COLLECTION_STYLES[state]}`}>
          {t(/* i18n-dynamic */ `longTail.monitoring.MonitoringAssetsDashboard.collectionState.${state}`)}
        </span>
        {asset.snmp.configured && asset.snmp.lastPolled && (
          <div className="text-xs text-muted-foreground">
            {t('longTail.monitoring.MonitoringAssetsDashboard.lastPolled', {
              time: formatRelativeTime(asset.snmp.lastPolled, t),
            })}
          </div>
        )}
      </div>
    );
  };

  // Row pieces shared by the desktop table and the mobile cards so the two
  // representations can never drift. Each takes a single asset.
  const renderOverallBadge = (asset: MonitoringAsset) => {
    const overall = asset.monitoring.configured
      ? (asset.monitoring.active ? 'active' : 'paused')
      : 'unconfigured';
    return (
      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
        overall === 'active'
          ? 'bg-success/15 text-success border-success/30'
          : overall === 'paused'
            ? 'bg-warning/15 text-warning border-warning/30'
            : 'bg-muted text-muted-foreground border-muted'
      }`}>
        {overall === 'active'
          ? t('common:states.active')
          : overall === 'paused'
            ? t('longTail.monitoring.MonitoringAssetsDashboard.configuredPaused')
            : t('longTail.monitoring.MonitoringAssetsDashboard.notConfigured')}
      </span>
    );
  };

  const renderSnmpCell = (asset: MonitoringAsset) => {
    if (!asset.snmp.configured) {
      return <span className="text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.notConfigured')}</span>;
    }
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {asset.snmp.snmpVersion ?? '—'} • {t('longTail.monitoring.MonitoringAssetsDashboard.everyInterval', { interval: formatInterval(asset.snmp.pollingInterval) })}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('longTail.monitoring.MonitoringAssetsDashboard.lastPolled', { time: formatRelativeTime(asset.snmp.lastPolled, t) })}
        </div>
      </div>
    );
  };

  const renderActions = (asset: MonitoringAsset) => {
    const isLoadingAction = actionLoading === asset.id;
    return (
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          data-testid={`monitoring-asset-settings-${asset.id}`}
          onClick={() => void navigateTo(settingsHref(asset.id))}
          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          title={t('longTail.monitoring.MonitoringAssetsDashboard.openSettings')}
        >
          <Settings className="h-4 w-4" />
        </button>
        {asset.snmp.configured && (
          <button
            type="button"
            data-testid={`monitoring-asset-${asset.snmp.isActive ? 'pause' : 'resume'}-${asset.id}`}
            onClick={() => void handleToggleSnmpActive(asset.id, !asset.snmp.isActive)}
            disabled={isLoadingAction}
            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
            title={asset.snmp.isActive
              ? t('longTail.monitoring.MonitoringAssetsDashboard.pauseSnmpPolling')
              : t('longTail.monitoring.MonitoringAssetsDashboard.resumeSnmpPolling')}
          >
            {isLoadingAction ? <Loader2 className="h-4 w-4 animate-spin" />
              : asset.snmp.isActive ? <PowerOff className="h-4 w-4 text-yellow-600" />
              : <Power className="h-4 w-4 text-green-600" />}
          </button>
        )}
        {asset.monitoring.active && (
          <button
            type="button"
            data-testid={`monitoring-asset-disable-${asset.id}`}
            onClick={() => void handleDisableAll(asset.id)}
            disabled={isLoadingAction}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-50"
            title={t('longTail.monitoring.MonitoringAssetsDashboard.disableAllActiveMonitoring')}
          >
            <XCircle className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  };

  if (scope.status === 'error') {
    return <OrgLoadFailedState error={scope.error} />;
  }

  if (scope.scope === 'all' || scope.status === 'empty') {
    return (
      <OrgRequiredState
        description={t('longTail.monitoring.MonitoringAssetsDashboard.needsOrgSelection')}
      />
    );
  }

  // scope.status === 'loading' (context still resolving) falls through to the
  // spinner below alongside the normal per-org loading frame.
  if (scope.status === 'loading' || (loading && assets.length === 0)) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.loadingAssets')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            {showAll ? t('longTail.monitoring.MonitoringAssetsDashboard.showingAllDiscoveredAssets') : t('longTail.monitoring.MonitoringAssetsDashboard.showingMonitoredAssets')}
          </button>
          {onOpenChecks && (
            <button
              type="button"
              onClick={onOpenChecks}
              className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              {t('longTail.monitoring.MonitoringAssetsDashboard.manageNetworkChecks')}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={fetchAssets}
          className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('common:actions.refresh')}
        </button>
      </div>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{configuredCount}</p>
              <p className="text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.summary.configured')}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{activeCount}</p>
              <p className="text-xs text-muted-foreground">{t('common:states.active')}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <PowerOff className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{pausedCount}</p>
              <p className="text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.paused')}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{snmpWarningOrOffline}</p>
              <p className="text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.summary.snmpWarnings')}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{assets.length}</p>
              <p className="text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.summary.shown')}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('longTail.monitoring.MonitoringAssetsDashboard.assets')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('longTail.monitoring.MonitoringAssetsDashboard.assetsDescription')}
            </p>
          </div>
        </div>

        <ResponsiveTable
          className="mt-6"
          table={
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.table.asset')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.ip')}</th>
                  <th className="px-4 py-3">{t('common:labels.type')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.table.overall')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.table.reachability')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.table.collection')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.snmp')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.networkChecks')}</th>
                  <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {assets.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      {t('longTail.monitoring.MonitoringAssetsDashboard.emptyAssets')}
                    </td>
                  </tr>
                ) : (
                  assets.map((asset) => (
                    <tr key={asset.id} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {asset.hostname || asset.ipAddress || '—'}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {t('longTail.monitoring.MonitoringAssetsDashboard.lastSeen', { time: formatRelativeTime(asset.lastSeenAt, t) })}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm font-mono">{asset.ipAddress || '—'}</td>
                      <td className="px-4 py-3 text-sm capitalize">{asset.assetType}</td>
                      <td className="px-4 py-3">{renderOverallBadge(asset)}</td>
                      <td className="px-4 py-3">{renderReachabilityCell(asset)}</td>
                      <td className="px-4 py-3">{renderCollectionCell(asset)}</td>
                      <td className="px-4 py-3">{renderSnmpCell(asset)}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {asset.network.totalCount > 0
                          ? t('longTail.monitoring.MonitoringAssetsDashboard.activeRatio', { active: asset.network.activeCount, total: asset.network.totalCount })
                          : '—'}
                      </td>
                      <td className="px-4 py-3">{renderActions(asset)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          }
          cards={
            assets.length === 0 ? (
              <DataCard>
                <p className="py-2 text-center text-sm text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.emptyAssets')}</p>
              </DataCard>
            ) : (
              assets.map((asset) => (
                <DataCard key={asset.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{asset.hostname || asset.ipAddress || '—'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {t('longTail.monitoring.MonitoringAssetsDashboard.lastSeen', { time: formatRelativeTime(asset.lastSeenAt, t) })}
                      </p>
                    </div>
                    {renderOverallBadge(asset)}
                  </div>
                  <div className="mt-3 space-y-2 border-t pt-3">
                    <CardField label={t('longTail.monitoring.MonitoringAssetsDashboard.ip')}>
                      <span className="font-mono text-sm">{asset.ipAddress || '—'}</span>
                    </CardField>
                    <CardField label={t('common:labels.type')}>
                      <span className="text-sm capitalize">{asset.assetType}</span>
                    </CardField>
                    <CardField label={t('longTail.monitoring.MonitoringAssetsDashboard.table.reachability')}>
                      {renderReachabilityCell(asset)}
                    </CardField>
                    <CardField label={t('longTail.monitoring.MonitoringAssetsDashboard.table.collection')}>
                      {renderCollectionCell(asset)}
                    </CardField>
                    <CardField label={t('longTail.monitoring.MonitoringAssetsDashboard.networkChecks')}>
                      <span className="text-sm text-muted-foreground">
                        {asset.network.totalCount > 0
                          ? t('longTail.monitoring.MonitoringAssetsDashboard.activeRatio', { active: asset.network.activeCount, total: asset.network.totalCount })
                          : '—'}
                      </span>
                    </CardField>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.snmp')}</span>
                      <div className="mt-1">{renderSnmpCell(asset)}</div>
                    </div>
                  </div>
                  <CardActions>{renderActions(asset)}</CardActions>
                </DataCard>
              ))
            )
          }
        />
      </div>

    </div>
  );
}
