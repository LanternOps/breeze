import type { RefObject } from 'react';
import {
  AlertTriangle,
  Clock,
  Database,
  Loader2,
  PlayCircle,
  TrendingUp
} from 'lucide-react';
import { cn, widthPercentClass } from '@/lib/utils';
import BackupJobList from './BackupJobList';
import {
  type AttentionItem,
  type BackupJob,
  type BackupStat,
  type OverdueDevice,
  type StatChangeType,
  type StatusConfigKey,
  type StorageProvider,
  type UsageHistoryPoint,
  attentionIconMap,
  buildLinePath,
  formatBytes,
  resolveJobConfig,
  resolveJobDevice,
  resolveJobDuration,
  resolveJobSize,
  resolveJobStarted,
  resolveProviderColor,
  resolveProviderStroke,
  statIconMap,
  statusConfig
} from './backupDashboardHelpers';

function UsageHistoryChart({ points }: { points: UsageHistoryPoint[] }) {
  const providers = Array.from(
    new Set(points.flatMap((point) => point.providers.map((provider) => provider.provider)))
  );

  if (providers.length === 0 || points.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
        No provider timeline available yet.
      </div>
    );
  }

  const normalized = points.map((point) => {
    const byProvider = new Map(point.providers.map((provider) => [provider.provider, provider.bytes]));
    const totalBytes = typeof point.totalBytes === 'number'
      ? point.totalBytes
      : providers.reduce((sum, providerName) => sum + (byProvider.get(providerName) ?? 0), 0);

    return {
      timestamp: point.timestamp,
      totalBytes,
      byProvider
    };
  });

  const maxValue = Math.max(
    1,
    ...normalized.flatMap((point) => [
      point.totalBytes,
      ...providers.map((provider) => point.byProvider.get(provider) ?? 0)
    ])
  );

  const first = normalized[0];
  const last = normalized[normalized.length - 1];

  return (
    <div className="space-y-3">
      <div className="h-28 rounded-md border bg-muted/20 p-2">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label="Storage usage trend by provider over time"
        >
          <title>Provider usage history chart</title>
          <polyline
            fill="none"
            stroke="hsl(var(--muted-foreground))"
            strokeWidth="2"
            strokeDasharray="4 3"
            points={buildLinePath(normalized.map((point) => point.totalBytes), maxValue)}
          />
          {providers.map((provider) => (
            <polyline
              key={provider}
              fill="none"
              stroke={resolveProviderStroke(provider)}
              strokeWidth="3"
              points={buildLinePath(normalized.map((point) => point.byProvider.get(provider) ?? 0), maxValue)}
            />
          ))}
        </svg>
      </div>
      <div className="grid gap-2 text-xs">
        <div className="flex flex-wrap gap-2">
          {providers.map((provider) => (
            <span
              key={provider}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-muted-foreground"
            >
              <span className={cn('h-2 w-2 rounded-full', resolveProviderColor(provider))} />
              {provider}
            </span>
          ))}
          <span className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-muted-foreground" />
            Total
          </span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <span>{new Date(first.timestamp).toLocaleDateString()}</span>
          <span className="font-medium text-foreground">{formatBytes(last.totalBytes)}</span>
          <span>{new Date(last.timestamp).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}

export type BackupOverviewContentProps = {
  stats: BackupStat[];
  recentJobs: BackupJob[];
  overdueDevices: OverdueDevice[];
  storageProviders: StorageProvider[];
  usageHistory: UsageHistoryPoint[];
  usageHistoryError?: string;
  attentionItems: AttentionItem[];
  showAllJobs: boolean;
  setShowAllJobs: (value: boolean) => void;
  error?: string;
  runAllResult?: string;
  runAllLoading: boolean;
  runAllPreview: { deviceCount: number; alreadyRunning: number; offline: number } | null;
  runOverdueResult?: string;
  runOverdueLoading: boolean;
  runAllDialogRef: RefObject<HTMLDialogElement | null>;
  handleRunAllClick: () => void;
  handleRunAllConfirm: () => void;
  handleRunAllCancel: () => void;
  handleRunOverdueClick: () => void;
  resolveChangeType: (stat: BackupStat) => StatChangeType;
  resolveStatIcon: (stat: BackupStat) => typeof Database;
  resolveJobStatus: (status?: string) => string;
  resolveProviderPercent: (provider: StorageProvider) => number;
  fetchOverview: () => void;
};

export default function BackupOverviewContent(props: BackupOverviewContentProps) {
  const {
    stats, recentJobs, overdueDevices, storageProviders, usageHistory,
    usageHistoryError, attentionItems, showAllJobs, setShowAllJobs, error,
    runAllResult, runAllLoading, runAllPreview, runOverdueResult, runOverdueLoading, runAllDialogRef,
    handleRunAllClick, handleRunAllConfirm, handleRunAllCancel, handleRunOverdueClick,
    resolveChangeType, resolveStatIcon, resolveJobStatus, resolveProviderPercent,
    fetchOverview
  } = props;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Backup Overview</h2>
          <p className="text-sm text-muted-foreground">
            Monitor protection coverage, storage trends, and recent activity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleRunAllClick}
            disabled={runAllLoading}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent disabled:opacity-50"
          >
            {runAllLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Run all backups
          </button>
        </div>
      </div>

      {runAllResult && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {runAllResult}
        </div>
      )}

      {runOverdueResult && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {runOverdueResult}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground lg:col-span-4">
            No backup metrics yet. Configure a backup policy to start tracking protection coverage.
          </div>
        ) : (
          stats.map((stat, index) => {
            const StatIcon = resolveStatIcon(stat);
            const changeType = resolveChangeType(stat);
            return (
              <div
                key={`${stat.id ?? stat.name ?? 'stat'}-${index}`}
                className="rounded-lg border bg-card px-5 py-4"
              >
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <StatIcon className="h-4 w-4" />
                  {stat.name ?? 'Metric'}
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold text-foreground">
                    {stat.value ?? '--'}
                  </span>
                  <span
                    className={cn(
                      'text-xs font-medium',
                      changeType === 'positive' && 'text-success',
                      changeType === 'negative' && 'text-destructive',
                      changeType === 'neutral' && 'text-muted-foreground'
                    )}
                  >
                    {stat.change ?? ''}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Recent Jobs</h3>
              <p className="text-sm text-muted-foreground">Latest backup activity across sites.</p>
            </div>
            <button
              onClick={() => setShowAllJobs(!showAllJobs)}
              className="text-sm font-medium text-primary hover:text-primary/80"
            >
              {showAllJobs ? 'Show recent' : 'View all'}
            </button>
          </div>
          {showAllJobs ? (
            <div className="mt-4">
              <BackupJobList />
            </div>
          ) : (
          <div className="mt-4 space-y-3">
            {recentJobs.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No recent activity. Jobs will appear here once a backup configuration runs.
              </div>
            ) : (
              recentJobs.map((job) => {
                const normalizedStatus = resolveJobStatus(job.status);
                const status = statusConfig[normalizedStatus as StatusConfigKey];
                const StatusIcon = status.icon;
                return (
                  <div
                    key={job.id}
                    className="rounded-md border px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn('flex h-9 w-9 items-center justify-center rounded-full', status.className)}
                        >
                          <StatusIcon className="h-4 w-4" />
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{resolveJobDevice(job)}</p>
                          <p className="text-xs text-muted-foreground">{resolveJobConfig(job)}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" /> {resolveJobStarted(job)}
                        </span>
                        <span>Duration: {resolveJobDuration(job)}</span>
                        <span>Size: {resolveJobSize(job)}</span>
                        <span className="text-foreground">{status.label}</span>
                      </div>
                    </div>
                    {job.errorLog ? (
                      <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="line-clamp-2">{job.errorLog}</span>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Storage by Provider</h3>
              <p className="text-sm text-muted-foreground">Current usage and capacity.</p>
            </div>
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-4 space-y-4">
            {storageProviders.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No storage providers configured yet. Add a backup config to track usage.
              </div>
            ) : (
              storageProviders.map((provider) => {
                const percent = resolveProviderPercent(provider);
                const color = resolveProviderColor(provider.name);
                return (
                  <div key={provider.id ?? provider.name} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground">{provider.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {provider.used ?? '--'} / {provider.total ?? '--'}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted">
                      <div className={cn('h-2 rounded-full', color, widthPercentClass(percent))} />
                    </div>
                  </div>
                );
              })
            )}
            {usageHistoryError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {usageHistoryError}
              </div>
            ) : usageHistory.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                Usage history will appear after the first few backup runs.
              </div>
            ) : (
              <UsageHistoryChart points={usageHistory} />
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Devices Needing Backup</h3>
              <p className="text-sm text-muted-foreground">Overdue based on schedule.</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-warning" />
          </div>
          <div className="mt-4 space-y-3">
            {overdueDevices.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                All devices are on schedule. Nothing overdue.
              </div>
            ) : (
              overdueDevices.map((device) => (
                <div
                  key={device.id ?? device.name}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-foreground">{device.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {device.owner ?? 'Unassigned'} {device.schedule ? `- ${device.schedule}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Last backup</p>
                    <p className="text-sm font-medium text-destructive">
                      {device.lastBackup ?? '--'}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            onClick={handleRunOverdueClick}
            disabled={runOverdueLoading || overdueDevices.length === 0}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {runOverdueLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Run overdue backups
          </button>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Attention Needed</h3>
              <p className="text-sm text-muted-foreground">
                Alerts for backup performance and coverage.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {attentionItems.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground md:col-span-2">
                No active alerts. Backup health looks good.
              </div>
            ) : (
              attentionItems.map((item) => {
                const severity = item.severity ?? 'warning';
                const Icon = attentionIconMap[severity] ?? AlertTriangle;
                return (
                  <div
                    key={item.id ?? item.title}
                    className={cn(
                      'rounded-md border p-4',
                      severity === 'critical' && 'border-destructive/30 bg-destructive/5',
                      severity === 'warning' && 'border-warning/30 bg-warning/5',
                      (severity === 'info' || severity === 'success') && 'bg-muted/20'
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Icon
                        className={cn(
                          'h-4 w-4',
                          severity === 'critical' && 'text-destructive',
                          severity === 'warning' && 'text-warning',
                          severity === 'info' && 'text-muted-foreground',
                          severity === 'success' && 'text-success'
                        )}
                      />
                      {item.title}
                    </div>
                    {item.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <dialog
        ref={runAllDialogRef}
        className="rounded-lg border bg-card p-6 shadow-lg backdrop:bg-black/40"
        onClose={handleRunAllCancel}
      >
        <h3 className="text-base font-semibold text-foreground">Run all backups</h3>
        {runAllPreview && runAllPreview.deviceCount === 0 ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              No eligible devices are ready for a manual backup run.
            </p>
            <div className="mt-3 space-y-1 text-sm text-muted-foreground">
              {runAllPreview.alreadyRunning > 0 && (
                <p>{runAllPreview.alreadyRunning} device{runAllPreview.alreadyRunning !== 1 ? 's are' : ' is'} already running a backup.</p>
              )}
              {runAllPreview.offline > 0 && (
                <p>{runAllPreview.offline} device{runAllPreview.offline !== 1 ? 's are' : ' is'} offline.</p>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={handleRunAllCancel}
                className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              This will start manual backup jobs for{' '}
              <span className="font-medium text-foreground">{runAllPreview?.deviceCount ?? 0} device{(runAllPreview?.deviceCount ?? 0) !== 1 ? 's' : ''}</span>.
            </p>
            {((runAllPreview?.alreadyRunning ?? 0) > 0 || (runAllPreview?.offline ?? 0) > 0) && (
              <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                {(runAllPreview?.alreadyRunning ?? 0) > 0 && (
                  <p>{runAllPreview?.alreadyRunning} already running {runAllPreview?.alreadyRunning === 1 ? 'device will' : 'devices will'} be skipped.</p>
                )}
                {(runAllPreview?.offline ?? 0) > 0 && (
                  <p>{runAllPreview?.offline} offline {runAllPreview?.offline === 1 ? 'device will' : 'devices will'} be skipped.</p>
                )}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleRunAllCancel}
                className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRunAllConfirm}
                disabled={runAllLoading}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {runAllLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                Run backups
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
