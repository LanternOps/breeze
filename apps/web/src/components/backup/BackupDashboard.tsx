import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Database, HardDrive, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import BackupOverviewContent from './BackupOverviewContent';
import BackupVerificationOverview from './BackupVerificationOverview';
import {
  type AttentionItem,
  type BackupJob,
  type BackupStat,
  type OverdueDevice,
  type StatChangeType,
  type StorageProvider,
  type UsageHistoryPoint,
  formatBytes,
  parseUsageHistory,
  statIconMap
} from './backupDashboardHelpers';

const MssqlDashboard = lazy(() => import('./MssqlDashboard'));
const HypervDashboard = lazy(() => import('./HypervDashboard'));
const VMRestoreWizard = lazy(() => import('./VMRestoreWizard'));
const InstantBootStatus = lazy(() => import('./InstantBootStatus'));
const VaultDashboard = lazy(() => import('./VaultDashboard'));
const SLADashboard = lazy(() => import('./SLADashboard'));
const EncryptionKeyList = lazy(() => import('./EncryptionKeyList'));
const RecoveryBootstrapTab = lazy(() => import('./RecoveryBootstrapTab'));
const SnapshotBrowser = lazy(() => import('./SnapshotBrowser'));

type BackupTab = 'overview' | 'verification' | 'snapshots' | 'mssql' | 'hyperv' | 'vault' | 'sla' | 'encryption' | 'recovery-bootstrap';

const ALL_TABS: BackupTab[] = ['overview', 'verification', 'snapshots', 'mssql', 'hyperv', 'vault', 'sla', 'encryption', 'recovery-bootstrap'];

const TAB_LABELS: Record<BackupTab, string> = {
  overview: 'Overview',
  verification: 'Verification',
  snapshots: 'Snapshots',
  mssql: 'SQL Server',
  hyperv: 'Hyper-V',
  vault: 'Vault',
  sla: 'SLA',
  encryption: 'Encryption',
  'recovery-bootstrap': 'Recovery Bootstrap',
};

function isValidTab(hash: string): hash is BackupTab {
  return ALL_TABS.includes(hash as BackupTab);
}

function TabFallback() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

export default function BackupDashboard() {
  const [activeTab, setActiveTab] = useState<BackupTab>(() => {
    if (typeof window === 'undefined') return 'overview';
    const hash = window.location.hash.replace('#', '');
    return isValidTab(hash) ? hash : 'overview';
  });
  const [stats, setStats] = useState<BackupStat[]>([]);
  const [recentJobs, setRecentJobs] = useState<BackupJob[]>([]);
  const [overdueDevices, setOverdueDevices] = useState<OverdueDevice[]>([]);
  const [storageProviders, setStorageProviders] = useState<StorageProvider[]>([]);
  const [usageHistory, setUsageHistory] = useState<UsageHistoryPoint[]>([]);
  const [usageHistoryError, setUsageHistoryError] = useState<string>();
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
  const [showAllJobs, setShowAllJobs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [runAllPreview, setRunAllPreview] = useState<{ deviceCount: number; alreadyRunning: number; offline: number } | null>(null);
  const [runAllLoading, setRunAllLoading] = useState(false);
  const [runAllResult, setRunAllResult] = useState<string>();
  const [runOverdueLoading, setRunOverdueLoading] = useState(false);
  const [runOverdueResult, setRunOverdueResult] = useState<string>();
  const runAllDialogRef = useRef<HTMLDialogElement>(null);

  const fetchOverview = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      setUsageHistoryError(undefined);
      const response = await fetchWithAuth('/backup/dashboard');
      if (!response.ok) {
        throw new Error('Failed to fetch backup overview');
      }
      const payload = await response.json();
      const overview = payload?.data ?? payload ?? {};

      // Build stats from structured API response or accept pre-built stats array
      if (Array.isArray(overview.stats)) {
        setStats(overview.stats);
      } else if (overview.jobsLast24h || overview.totals) {
        const builtStats: BackupStat[] = [];
        if (overview.totals) {
          builtStats.push({ id: 'total_backups', name: 'Total Jobs', value: overview.totals.jobs ?? 0 });
          builtStats.push({ id: 'snapshots', name: 'Snapshots', value: overview.totals.snapshots ?? 0 });
        }
        if (overview.jobsLast24h) {
          const j = overview.jobsLast24h;
          const total24h = (j.completed ?? 0) + (j.failed ?? 0);
          const rate = total24h > 0 ? Math.round(((j.completed ?? 0) / total24h) * 100) : 0;
          builtStats.push({ id: 'success_rate', name: 'Success Rate (24h)', value: `${rate}%`, changeType: rate >= 90 ? 'positive' : rate >= 70 ? 'neutral' : 'negative' });
        }
        if (overview.coverage) {
          builtStats.push({ id: 'devices_covered', name: 'Devices Protected', value: overview.coverage.protectedDevices ?? 0 });
        }
        if (overview.storage) {
          builtStats.push({ id: 'storage_used', name: 'Storage Used', value: formatBytes(overview.storage.totalBytes ?? 0) });
        }
        setStats(builtStats);
      } else {
        setStats([]);
      }
      setRecentJobs(
        Array.isArray(overview.recentJobs)
          ? overview.recentJobs
          : Array.isArray(overview.latestJobs)
            ? overview.latestJobs
            : []
      );
      setOverdueDevices(
        Array.isArray(overview.overdueDevices)
          ? overview.overdueDevices
          : Array.isArray(overview.devicesOverdue)
            ? overview.devicesOverdue
            : []
      );
      setStorageProviders(
        Array.isArray(overview.storageProviders)
          ? overview.storageProviders
          : Array.isArray(overview.providers)
            ? overview.providers
            : []
      );
      setAttentionItems(
        Array.isArray(overview.attentionItems)
          ? overview.attentionItems
          : Array.isArray(overview.alerts)
            ? overview.alerts
            : []
      );

      try {
        const usageResponse = await fetchWithAuth('/backup/usage-history?days=14');
        if (!usageResponse.ok) {
          throw new Error('Usage history is currently unavailable');
        }

        const usagePayload = await usageResponse.json();
        setUsageHistory(parseUsageHistory(usagePayload));
      } catch (usageErr) {
        setUsageHistory([]);
        setUsageHistoryError(
          usageErr instanceof Error ? usageErr.message : 'Usage history is currently unavailable'
        );
      }
    } catch (err) {
      console.error('[BackupDashboard] fetchOverview:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      setActiveTab(isValidTab(hash) ? hash : 'overview');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleRunAllClick = useCallback(async () => {
    try {
      setRunAllLoading(true);
      setRunAllResult(undefined);
      const response = await fetchWithAuth('/backup/jobs/run-all/preview');
      if (!response.ok) throw new Error('Failed to check backup readiness');
      const payload = await response.json();
      const preview = payload?.data ?? payload;
      setRunAllPreview(preview);
      runAllDialogRef.current?.showModal();
    } catch (err) {
      console.error('[BackupDashboard] handleRunAllClick:', err);
      setError(err instanceof Error ? err.message : 'Failed to check backup readiness');
    } finally {
      setRunAllLoading(false);
    }
  }, []);

  const handleRunAllConfirm = useCallback(async () => {
    try {
      setRunAllLoading(true);
      runAllDialogRef.current?.close();
      const response = await fetchWithAuth('/backup/jobs/run-all', { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to start backups');
      }
      const payload = await response.json();
      const result = payload?.data ?? payload;
      const parts: string[] = [];
      if (result.created > 0) parts.push(`Started ${result.created} backup job${result.created !== 1 ? 's' : ''}`);
      if (result.skippedRunning > 0) parts.push(`${result.skippedRunning} skipped (already running)`);
      if (result.skippedOffline > 0) parts.push(`${result.skippedOffline} skipped (offline)`);
      if (result.failed > 0) parts.push(`${result.failed} failed to dispatch`);
      setRunAllResult(parts.join('. ') || 'No backup jobs to run.');
      fetchOverview();
    } catch (err) {
      console.error('[BackupDashboard] handleRunAllConfirm:', err);
      setError(err instanceof Error ? err.message : 'Failed to start backups');
    } finally {
      setRunAllLoading(false);
      setRunAllPreview(null);
    }
  }, [fetchOverview]);

  const handleRunAllCancel = useCallback(() => {
    runAllDialogRef.current?.close();
    setRunAllPreview(null);
  }, []);

  const handleRunOverdueClick = useCallback(async () => {
    const overdueIds = overdueDevices.map((device) => device.id).filter((id): id is string => Boolean(id));

    if (overdueIds.length === 0) {
      setRunOverdueResult('No overdue devices are ready to start from this view.');
      return;
    }

    try {
      setRunOverdueLoading(true);
      setRunOverdueResult(undefined);
      setError(undefined);

      let created = 0;
      let skipped = 0;
      let failed = 0;
      const failedDetails: string[] = [];

      for (const deviceId of overdueIds) {
        const response = await fetchWithAuth(`/backup/jobs/run/${deviceId}`, { method: 'POST' });
        if (response.ok) {
          created += 1;
          continue;
        }

        if (response.status === 409) {
          skipped += 1;
          continue;
        }

        const body = await response.json().catch(() => null);
        const deviceName = overdueDevices.find((d) => d.id === deviceId)?.name ?? deviceId;
        failedDetails.push(`${deviceName}: ${body?.error ?? `status ${response.status}`}`);
        failed += 1;
      }

      const parts: string[] = [];
      if (created > 0) parts.push(`Started ${created} overdue backup job${created !== 1 ? 's' : ''}`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      if (failed > 0) parts.push(`${failed} failed (${failedDetails.join('; ')})`);
      setRunOverdueResult(parts.join('. ') || 'No overdue backup jobs were started.');
      await fetchOverview();
    } catch (err) {
      console.error('[BackupDashboard] handleRunOverdueClick:', err);
      setError(err instanceof Error ? err.message : 'Failed to start overdue backups');
    } finally {
      setRunOverdueLoading(false);
    }
  }, [fetchOverview, overdueDevices]);

  const hasData = useMemo(
    () =>
      stats.length > 0 ||
      recentJobs.length > 0 ||
      overdueDevices.length > 0 ||
      storageProviders.length > 0 ||
      usageHistory.length > 0 ||
      attentionItems.length > 0,
    [
      attentionItems.length,
      overdueDevices.length,
      recentJobs.length,
      stats.length,
      storageProviders.length,
      usageHistory.length
    ]
  );

  const resolveChangeType = (stat: BackupStat): StatChangeType => {
    if (stat.changeType) return stat.changeType;
    if (stat.change?.startsWith('-')) return 'negative';
    if (stat.change?.startsWith('+')) return 'positive';
    return 'neutral';
  };

  const resolveStatIcon = (stat: BackupStat) => {
    const rawKey = `${stat.id ?? stat.name ?? ''}`.toLowerCase().replace(/\s+/g, '_');
    return (
      statIconMap[rawKey] ||
      (rawKey.includes('success') ? CheckCircle2 : undefined) ||
      (rawKey.includes('storage') ? HardDrive : undefined) ||
      (rawKey.includes('device') ? ShieldAlert : undefined) ||
      Database
    );
  };

  const resolveJobStatus = (status?: string) => {
    if (!status) return 'warning';
    const normalized = status.toLowerCase();
    if (normalized.includes('success') || normalized.includes('complete')) return 'success';
    if (normalized.includes('run') || normalized.includes('progress')) return 'running';
    if (normalized.includes('fail') || normalized.includes('error')) return 'failed';
    return 'warning';
  };

  const resolveProviderPercent = (provider: StorageProvider) => {
    if (typeof provider.percent === 'number') return provider.percent;
    const usedValue = typeof provider.used === 'number' ? provider.used : parseFloat(`${provider.used ?? ''}`);
    const totalValue = typeof provider.total === 'number' ? provider.total : parseFloat(`${provider.total ?? ''}`);
    if (!Number.isFinite(usedValue) || !Number.isFinite(totalValue) || totalValue <= 0) return 0;
    return Math.round((usedValue / totalValue) * 100);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading backup overview...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-1 overflow-x-auto border-b">
        {ALL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              setActiveTab(tab);
              window.location.hash = tab === 'overview' ? '' : tab;
            }}
            className={cn(
              'flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {TAB_LABELS[tab]}
            {tab !== 'overview' && tab !== 'verification' && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wider text-warning">
                Alpha
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && error && !hasData && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={fetchOverview}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </div>
      )}

      {activeTab === 'overview' && !(error && !hasData) && (
        <BackupOverviewContent
          stats={stats}
          recentJobs={recentJobs}
          overdueDevices={overdueDevices}
          storageProviders={storageProviders}
          usageHistory={usageHistory}
          usageHistoryError={usageHistoryError}
          attentionItems={attentionItems}
          showAllJobs={showAllJobs}
          setShowAllJobs={setShowAllJobs}
          error={error}
          runAllResult={runAllResult}
          runAllLoading={runAllLoading}
          runAllPreview={runAllPreview}
          runOverdueResult={runOverdueResult}
          runOverdueLoading={runOverdueLoading}
          runAllDialogRef={runAllDialogRef}
          handleRunAllClick={handleRunAllClick}
          handleRunAllConfirm={handleRunAllConfirm}
          handleRunAllCancel={handleRunAllCancel}
          handleRunOverdueClick={handleRunOverdueClick}
          resolveChangeType={resolveChangeType}
          resolveStatIcon={resolveStatIcon}
          resolveJobStatus={resolveJobStatus}
          resolveProviderPercent={resolveProviderPercent}
          fetchOverview={fetchOverview}
        />
      )}

      {activeTab === 'verification' && <BackupVerificationOverview />}

      {activeTab === 'snapshots' && (
        <Suspense fallback={<TabFallback />}>
          <SnapshotBrowser />
        </Suspense>
      )}

      {activeTab === 'mssql' && (
        <Suspense fallback={<TabFallback />}>
          <MssqlDashboard />
        </Suspense>
      )}

      {activeTab === 'hyperv' && (
        <Suspense fallback={<TabFallback />}>
          <div className="space-y-6">
            <HypervDashboard />

            <div className="grid gap-6 2xl:grid-cols-[1.2fr,0.8fr]">
              <VMRestoreWizard />

              <div className="space-y-3 rounded-lg border bg-card p-5 shadow-sm">
                <div>
                  <h3 className="text-base font-semibold text-foreground">Active instant boots</h3>
                  <p className="text-sm text-muted-foreground">
                    Monitor instant boot sessions that are still pending or running.
                  </p>
                </div>
                <InstantBootStatus />
              </div>
            </div>
          </div>
        </Suspense>
      )}

      {activeTab === 'vault' && (
        <Suspense fallback={<TabFallback />}>
          <VaultDashboard />
        </Suspense>
      )}

      {activeTab === 'sla' && (
        <Suspense fallback={<TabFallback />}>
          <SLADashboard />
        </Suspense>
      )}

      {activeTab === 'encryption' && (
        <Suspense fallback={<TabFallback />}>
          <EncryptionKeyList />
        </Suspense>
      )}

      {activeTab === 'recovery-bootstrap' && (
        <Suspense fallback={<TabFallback />}>
          <RecoveryBootstrapTab />
        </Suspense>
      )}
    </div>
  );
}
