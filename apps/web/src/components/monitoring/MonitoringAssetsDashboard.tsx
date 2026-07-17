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
  X,
  XCircle
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useOrgScope } from '@/hooks/useOrgScope';
import { OrgRequiredState } from '../shared/OrgRequiredState';
import { OrgLoadFailedState } from '../shared/OrgLoadFailedState';
import CreateMonitorForm from '../monitors/CreateMonitorForm';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';

type MonitoringAsset = {
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

type SNMPTemplate = {
  id: string;
  name: string;
  vendor?: string;
  deviceType?: string;
};

type AssetMonitoringDetail = {
  enabled: boolean;
  snmpDevice: {
    id: string;
    snmpVersion: string;
    templateId: string | null;
    pollingInterval: number;
    port?: number;
    isActive: boolean;
    lastPolled: string | null;
    lastStatus: string | null;
    username?: string | null;
  } | null;
  networkMonitors: {
    totalCount: number;
    activeCount: number;
  };
  recentMetrics: Array<{
    id: string;
    oid: string;
    name: string;
    value: string;
    valueType: string;
    timestamp: string;
  }>;
};

const statusColors: Record<string, string> = {
  online: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  offline: 'bg-destructive/15 text-destructive border-destructive/30',
  maintenance: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  unknown: 'bg-muted text-muted-foreground border-muted'
};

function getStatusLabel(status: string, t: (key: string) => string): string {
  const key = `longTail.monitoring.MonitoringAssetsDashboard.status.${status}`;
  const label = t(/* i18n-dynamic */ key);
  return label === key ? status : label;
}

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

  const [templates, setTemplates] = useState<SNMPTemplate[]>([]);

  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssetMonitoringDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
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

  useEffect(() => {
    fetchWithAuth('/snmp/templates')
      .then(async (res) => {
        if (!res.ok) {
          console.warn(`[MonitoringAssetsDashboard] Failed to load SNMP templates: HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        setTemplates(data.data ?? data.templates ?? data ?? []);
      })
      .catch((err) => {
        console.error('[MonitoringAssetsDashboard] Error loading SNMP templates:', err);
      });
  }, []);

  useEffect(() => {
    if (!initialAssetId) return;
    // If deep-linked to an asset, switch to "show all" mode (so unconfigured
    // assets are included) and open its editing panel.
    setShowAll(true);
    setEditingAssetId(initialAssetId);
  }, [initialAssetId]);

  const openEdit = useCallback(async (assetId: string) => {
    setEditingAssetId(assetId);
    setDetail(null);
    setDetailLoading(true);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/monitoring/assets/${assetId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? t('longTail.monitoring.MonitoringAssetsDashboard.errors.loadDetails'));
      }
      setDetail(await res.json());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('longTail.monitoring.MonitoringAssetsDashboard.errors.loadDetails'));
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!editingAssetId) return;
    void openEdit(editingAssetId);
  }, [editingAssetId, openEdit]);

  const configuredCount = useMemo(() => assets.filter((a) => a.monitoring.configured).length, [assets]);
  const activeCount = useMemo(() => assets.filter((a) => a.monitoring.active).length, [assets]);
  const pausedCount = useMemo(() => assets.filter((a) => a.monitoring.configured && !a.monitoring.active).length, [assets]);
  const snmpWarningOrOffline = useMemo(() => assets.filter((a) => {
    if (!a.snmp.configured || !a.snmp.isActive) return false;
    return a.snmp.lastStatus === 'warning' || a.snmp.lastStatus === 'offline';
  }).length, [assets]);

  const handleToggleSnmpActive = async (assetId: string, nextActive: boolean) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/monitoring/assets/${assetId}/snmp`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextActive })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? t('longTail.monitoring.MonitoringAssetsDashboard.errors.update'));
      }
      await fetchAssets();
      if (editingAssetId === assetId) {
        await openEdit(assetId);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisableAll = async (assetId: string) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/monitoring/assets/${assetId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? t('longTail.monitoring.MonitoringAssetsDashboard.errors.disableMonitoring'));
      }
      await fetchAssets();
      if (editingAssetId === assetId) {
        setEditingAssetId(null);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setActionLoading(null);
    }
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
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
            !asset.snmp.isActive
              ? statusColors.unknown
              : statusColors[asset.snmp.lastStatus ?? 'unknown'] ?? statusColors.unknown
          }`}>
            {!asset.snmp.isActive
              ? t('longTail.monitoring.MonitoringAssetsDashboard.paused')
              : getStatusLabel(asset.snmp.lastStatus ?? 'unknown', t)}
          </span>
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
          onClick={() => setEditingAssetId(asset.id)}
          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          title={t('longTail.monitoring.MonitoringAssetsDashboard.configureMonitoring')}
        >
          <Settings className="h-4 w-4" />
        </button>
        {asset.snmp.configured && (
          <button
            type="button"
            onClick={() => handleToggleSnmpActive(asset.id, !asset.snmp.isActive)}
            disabled={isLoadingAction}
            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
            title={asset.snmp.isActive ? t('longTail.monitoring.MonitoringAssetsDashboard.pauseSnmpPolling') : t('longTail.monitoring.MonitoringAssetsDashboard.resumeSnmpPolling')}
          >
            {isLoadingAction ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : asset.snmp.isActive ? (
              <PowerOff className="h-4 w-4 text-yellow-600" />
            ) : (
              <Power className="h-4 w-4 text-green-600" />
            )}
          </button>
        )}
        {asset.monitoring.active && (
          <button
            type="button"
            onClick={() => handleDisableAll(asset.id)}
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
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.snmp')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.networkChecks')}</th>
                  <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {assets.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
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

      {editingAssetId && (
        <EditMonitoringModal
          asset={assets.find((a) => a.id === editingAssetId) ?? null}
          detail={detail}
          loading={detailLoading}
          templates={templates}
          onClose={() => setEditingAssetId(null)}
          onDisable={() => handleDisableAll(editingAssetId)}
          disabling={actionLoading === editingAssetId}
          onSaved={async () => {
            await fetchAssets();
            await openEdit(editingAssetId);
          }}
        />
      )}
    </div>
  );
}

type EditModalProps = {
  asset: MonitoringAsset | null;
  detail: AssetMonitoringDetail | null;
  loading: boolean;
  templates: SNMPTemplate[];
  onClose: () => void;
  onSaved: () => void;
  onDisable: () => void;
  disabling: boolean;
};

function EditMonitoringModal({
  asset,
  detail,
  loading,
  templates,
  onClose,
  onSaved,
  onDisable,
  disabling
}: EditModalProps) {
  const { t } = useTranslation('common');
  const snmp = detail?.snmpDevice ?? null;

  const [snmpVersion, setSnmpVersion] = useState<'v1' | 'v2c' | 'v3'>((snmp?.snmpVersion as any) ?? 'v2c');
  const [community, setCommunity] = useState('');
  const [username, setUsername] = useState(snmp?.username ?? '');
  const [authProtocol, setAuthProtocol] = useState('sha');
  const [authPassword, setAuthPassword] = useState('');
  const [privProtocol, setPrivProtocol] = useState('aes');
  const [privPassword, setPrivPassword] = useState('');
  const [templateId, setTemplateId] = useState(snmp?.templateId ?? '');
  const [pollingInterval, setPollingInterval] = useState(snmp?.pollingInterval ?? 300);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showCreateMonitorForm, setShowCreateMonitorForm] = useState(false);

  useEffect(() => {
    setSnmpVersion((snmp?.snmpVersion as any) ?? 'v2c');
    setUsername(snmp?.username ?? '');
    setTemplateId(snmp?.templateId ?? '');
    setPollingInterval(snmp?.pollingInterval ?? 300);
    setCommunity('');
    setAuthPassword('');
    setPrivPassword('');
    setError(undefined);
    setConfirmRemove(false);
    setShowCreateMonitorForm(false);
  }, [snmp?.id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!asset) return;

    setError(undefined);
    setSaving(true);

    try {
      const payload: Record<string, unknown> = {
        snmpVersion,
        pollingInterval,
        templateId: templateId || null
      };

      if (snmpVersion === 'v1' || snmpVersion === 'v2c') {
        if (!snmp?.id && !community.trim()) {
          throw new Error(t('longTail.monitoring.MonitoringAssetsDashboard.errors.communityRequired'));
        }
        if (community.trim()) payload.community = community;
      } else {
        if (!snmp?.id && !username.trim()) {
          throw new Error(t('longTail.monitoring.MonitoringAssetsDashboard.errors.usernameRequired'));
        }
        if (username.trim()) payload.username = username;
        if (authProtocol) payload.authProtocol = authProtocol;
        if (authPassword) payload.authPassword = authPassword;
        if (privProtocol) payload.privProtocol = privProtocol;
        if (privPassword) payload.privPassword = privPassword;
      }

      const method = snmp?.id ? 'PATCH' : 'PUT';
      const res = await fetchWithAuth(`/monitoring/assets/${asset.id}/snmp`, {
        method,
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? t('longTail.monitoring.MonitoringAssetsDashboard.errors.saveSettings'));
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  if (!asset) return null;

  const recentMetrics = detail?.recentMetrics ?? [];
  const networkSummary = detail?.networkMonitors ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{t('longTail.monitoring.MonitoringAssetsDashboard.configureMonitoring')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.hostname || asset.ipAddress} &middot; {asset.assetType}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('longTail.monitoring.MonitoringAssetsDashboard.loadingDetails')}
          </div>
        )}

        {!loading && detail && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.snmp')}</p>
              <p className="mt-1 text-sm font-medium">
                {detail.snmpDevice
                  ? `${detail.snmpDevice.snmpVersion} • every ${detail.snmpDevice.pollingInterval}s`
                  : t('longTail.monitoring.MonitoringAssetsDashboard.notConfigured')}
              </p>
              {detail.snmpDevice && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('longTail.monitoring.MonitoringAssetsDashboard.statusLine', {
                    status: detail.snmpDevice.isActive
                      ? getStatusLabel(detail.snmpDevice.lastStatus ?? 'unknown', t)
                      : t('longTail.monitoring.MonitoringAssetsDashboard.paused'),
                  })}
                  {' • '}
                  {t('longTail.monitoring.MonitoringAssetsDashboard.lastPolled', { time: formatRelativeTime(detail.snmpDevice.lastPolled, t) })}
                </p>
              )}
            </div>
            <div className="rounded-md border bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.networkChecks')}</p>
              <p className="mt-1 text-sm font-medium">
                {networkSummary ? t('longTail.monitoring.MonitoringAssetsDashboard.activeRatio', { active: networkSummary.activeCount, total: networkSummary.totalCount }) : '—'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('longTail.monitoring.MonitoringAssetsDashboard.createManageChecks')}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateMonitorForm(true)}
                  className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  {t('longTail.monitoring.MonitoringAssetsDashboard.addNetworkCheck')}
                </button>
                <a
                  href={`/monitoring?assetId=${encodeURIComponent(asset.id)}#checks`}
                  className="inline-flex items-center h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('longTail.monitoring.MonitoringAssetsDashboard.openChecks')}
                </a>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 space-y-5">
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">{t('longTail.monitoring.MonitoringAssetsDashboard.snmpPolling')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('longTail.monitoring.MonitoringAssetsDashboard.snmpPollingDescription')}
            </p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitoring.MonitoringAssetsDashboard.snmpVersion')}</label>
                <select
                  value={snmpVersion}
                  onChange={(e) => setSnmpVersion(e.target.value as any)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="v1">{t('longTail.monitoring.MonitoringAssetsDashboard.snmpVersions.v1')}</option>
                  <option value="v2c">{t('longTail.monitoring.MonitoringAssetsDashboard.snmpVersions.v2c')}</option>
                  <option value="v3">{t('longTail.monitoring.MonitoringAssetsDashboard.snmpVersions.v3')}</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitoring.MonitoringAssetsDashboard.pollingIntervalSeconds')}</label>
                <input
                  type="number"
                  value={pollingInterval}
                  onChange={(e) => setPollingInterval(Number(e.target.value))}
                  min={30}
                  max={86400}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {(snmpVersion === 'v1' || snmpVersion === 'v2c') && (
              <div className="mt-4">
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {t('longTail.monitoring.MonitoringAssetsDashboard.communityString')}
                  <span className="ml-1 text-muted-foreground/60">{t('longTail.monitoring.MonitoringAssetsDashboard.leaveBlankToKeepCurrent')}</span>
                </label>
                <input
                  type="text"
                  value={community}
                  onChange={(e) => setCommunity(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  placeholder={t('longTail.monitoring.MonitoringAssetsDashboard.communityPlaceholder')}
                />
              </div>
            )}

            {snmpVersion === 'v3' && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    {t('longTail.monitoring.MonitoringAssetsDashboard.username')}
                    <span className="ml-1 text-muted-foreground/60">{t('longTail.monitoring.MonitoringAssetsDashboard.leaveBlankToKeepCurrent')}</span>
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitoring.MonitoringAssetsDashboard.authProtocol')}</label>
                    <select
                      value={authProtocol}
                      onChange={(e) => setAuthProtocol(e.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    >
                      <option value="md5">{t('longTail.monitoring.MonitoringAssetsDashboard.authProtocols.md5')}</option>
                      <option value="sha">{t('longTail.monitoring.MonitoringAssetsDashboard.authProtocols.sha')}</option>
                      <option value="sha256">{t('longTail.monitoring.MonitoringAssetsDashboard.authProtocols.sha256')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitoring.MonitoringAssetsDashboard.authPassword')}</label>
                    <input
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      placeholder={t('longTail.monitoring.MonitoringAssetsDashboard.leaveBlankToKeep')}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitoring.MonitoringAssetsDashboard.privacyProtocol')}</label>
                    <select
                      value={privProtocol}
                      onChange={(e) => setPrivProtocol(e.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    >
                      <option value="des">{t('longTail.monitoring.MonitoringAssetsDashboard.privacyProtocols.des')}</option>
                      <option value="aes">{t('longTail.monitoring.MonitoringAssetsDashboard.privacyProtocols.aes')}</option>
                      <option value="aes256">{t('longTail.monitoring.MonitoringAssetsDashboard.privacyProtocols.aes256')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitoring.MonitoringAssetsDashboard.privacyPassword')}</label>
                    <input
                      type="password"
                      value={privPassword}
                      onChange={(e) => setPrivPassword(e.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      placeholder={t('longTail.monitoring.MonitoringAssetsDashboard.leaveBlankToKeep')}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4">
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('longTail.monitoring.MonitoringAssetsDashboard.template')}</label>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('longTail.monitoring.MonitoringAssetsDashboard.noTemplate')}</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}{t.vendor ? ` (${t.vendor})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {recentMetrics.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-semibold mb-2">{t('longTail.monitoring.MonitoringAssetsDashboard.recentSnmpMetrics')}</h3>
                <div className="max-h-40 overflow-y-auto rounded-md border">
                  <table className="min-w-full divide-y text-xs">
                    <thead className="bg-muted/40 sticky top-0">
                      <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2">{t('common:labels.name')}</th>
                        <th className="px-3 py-2">{t('longTail.monitoring.MonitoringAssetsDashboard.oid')}</th>
                        <th className="px-3 py-2 text-right">{t('longTail.monitoring.MonitoringAssetsDashboard.value')}</th>
                        <th className="px-3 py-2 text-right">{t('longTail.monitoring.MonitoringAssetsDashboard.time')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {recentMetrics.map((m) => (
                        <tr key={m.id}>
                          <td className="px-3 py-1.5">{m.name}</td>
                          <td className="px-3 py-1.5 font-mono text-muted-foreground">{m.oid}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{m.value}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {formatRelativeTime(m.timestamp, t)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between border-t pt-4">
            <div>
              {detail?.enabled ? (
                !confirmRemove ? (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    className="text-xs text-destructive hover:underline"
                  >
                    {t('longTail.monitoring.MonitoringAssetsDashboard.disableActiveMonitoring')}
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-destructive">{t('longTail.monitoring.MonitoringAssetsDashboard.areYouSure')}</span>
                    <button
                      type="button"
                      onClick={onDisable}
                      disabled={disabling}
                      className="h-7 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {disabling ? t('longTail.monitoring.MonitoringAssetsDashboard.disabling') : t('longTail.monitoring.MonitoringAssetsDashboard.yesDisable')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(false)}
                      className="h-7 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      {t('common:actions.cancel')}
                    </button>
                  </div>
                )
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t('longTail.monitoring.MonitoringAssetsDashboard.monitoringNotActive')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                {t('common:actions.close')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70 flex items-center gap-2"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                {saving ? t('longTail.monitoring.MonitoringAssetsDashboard.saving') : t('common:actions.save')}
              </button>
            </div>
          </div>
        </form>
      </div>

      {showCreateMonitorForm && (
        <CreateMonitorForm
          assetId={asset.id}
          defaultTarget={asset.ipAddress}
          onCreated={() => {
            setShowCreateMonitorForm(false);
            void onSaved();
          }}
          onCancel={() => setShowCreateMonitorForm(false)}
        />
      )}
    </div>
  );
}
