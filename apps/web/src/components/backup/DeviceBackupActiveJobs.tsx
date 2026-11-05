import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Loader2, PauseCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ActiveBackupJob } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';
import { formatRelativeTime } from '@/lib/dateTimeFormat';
import { formatBytes } from './backupDashboardHelpers';
import {
  deriveActivePhase,
  estimateRemainingMs,
  formatEta,
  nextSpeedSample,
  stallState,
  type ProgressSample,
} from './backupJobProgress';
import '../../lib/i18n';

const MODE_KEYS = ['file', 'system_image', 'mssql', 'hyperv'] as const;
type KnownMode = (typeof MODE_KEYS)[number];
const isKnownMode = (mode: string | null): mode is KnownMode =>
  mode != null && (MODE_KEYS as readonly string[]).includes(mode);

type DeviceBackupActiveJobsProps = {
  jobs: ActiveBackupJob[];
  /** Omit to hide the Stop button. */
  onStop?: (jobId: string) => void;
  /** The job whose stop request is in flight. Every Stop button is disabled until it ends. */
  stoppingId?: string | null;
};

/**
 * "Backup in progress" cards for the device Backup tab (#11027): one card per
 * in-flight job, in the order the status endpoint returns them (running first).
 */
export default function DeviceBackupActiveJobs({ jobs, onStop, stoppingId }: DeviceBackupActiveJobsProps) {
  const { t } = useTranslation('backup');

  // Speed comes from consecutive polls. The samples a render reads are only
  // committed after it, so a double-invoked memo (StrictMode) cannot measure a
  // zero delta against its own sample.
  const committedSamples = useRef<Map<string, ProgressSample>>(new Map());
  const progress = useMemo(() => {
    const now = Date.now();
    const samples = new Map<string, ProgressSample>();
    const speeds = new Map<string, number>();
    for (const job of jobs) {
      if (job.status !== 'running') continue;
      const { bps, sample } = nextSpeedSample(committedSamples.current.get(job.id), job, now);
      if (sample) samples.set(job.id, sample);
      if (bps != null) speeds.set(job.id, bps);
    }
    return { now, samples, speeds };
  }, [jobs]);
  useEffect(() => {
    committedSamples.current = progress.samples;
  }, [progress]);

  if (jobs.length === 0) return null;

  return (
    <div data-testid="device-backup-active-jobs" className="rounded-lg border bg-card p-5 shadow-xs">
      <h3 className="mb-4 font-semibold">{t('deviceBackupTab.activeJobs.title')}</h3>
      <ul className="space-y-3">
        {jobs.map((job) => {
          const phase = deriveActivePhase(job);
          const { stalled, minutes } = stallState(job, progress.now);
          const bps = stalled ? undefined : progress.speeds.get(job.id);
          // No speed means no ETA: stalled above, and a resuming run has moved no bytes.
          const etaMs = estimateRemainingMs(job, bps);
          const total = job.totalSize ?? 0;
          const done = job.transferredSize ?? 0;
          const percent = job.status === 'running' && total > 0 ? Math.min(100, (done / total) * 100) : null;
          const heardAt = job.lastKeepaliveAt ?? job.lastProgressAt;
          const mode = job.backupMode ?? job.backupType;
          return (
            <li
              key={job.id}
              data-testid="device-backup-active-job"
              data-phase={phase}
              className="rounded-md border bg-background p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Loader2
                      className={cn('h-4 w-4 text-primary', job.status === 'running' && !stalled && 'animate-spin')}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-medium">{t(/* i18n-dynamic */ `deviceBackupTab.activePhase.${phase}`)}</span>
                    {stalled && (
                      <span
                        data-testid="device-backup-active-job-stalled"
                        title={t('backupJobList.stalledTooltip', { minutes })}
                        className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('backupJobList.stalled')}
                      </span>
                    )}
                  </div>
                  {isKnownMode(mode) && (
                    <p className="text-xs text-muted-foreground">
                      {t(/* i18n-dynamic */ `deviceBackupTab.activeJobs.mode.${mode}`)}
                    </p>
                  )}
                </div>
                {onStop && (
                  <button
                    type="button"
                    data-testid="device-backup-active-job-stop"
                    onClick={() => onStop(job.id)}
                    disabled={stoppingId != null}
                    className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                  >
                    {stoppingId === job.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {t('backupJobList.stop')}
                  </button>
                )}
              </div>

              <div
                data-testid="device-backup-active-job-progress"
                data-indeterminate={percent == null ? 'true' : 'false'}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent == null ? undefined : Math.round(percent)}
                className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn('h-full rounded-full bg-primary', percent == null && 'w-1/3 animate-pulse')}
                  style={percent == null ? undefined : { width: `${percent}%` }}
                />
              </div>

              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {percent != null && <span>{`${formatNumber(percent, { maximumFractionDigits: 0 })}%`}</span>}
                {job.transferredSize != null && job.status === 'running' && (
                  <span>
                    {total > 0
                      ? t('deviceBackupTab.activeJobs.processedOfTotal', {
                          done: formatBytes(done),
                          total: formatBytes(total),
                        })
                      : t('deviceBackupTab.activeJobs.processed', { done: formatBytes(done) })}
                  </span>
                )}
                {job.fileCount != null && job.totalFiles != null && (
                  <span>{t('backupJobList.filesProgress', { done: job.fileCount, total: job.totalFiles })}</span>
                )}
                {bps != null && <span>{t('backupJobList.speedValue', { value: formatBytes(bps) })}</span>}
                {etaMs != null && (
                  <span data-testid="device-backup-active-job-eta">
                    {t('backupJobList.etaValue', { value: formatEta(etaMs) })}
                  </span>
                )}
                {heardAt && (
                  <span data-testid="device-backup-active-job-heard">
                    {t('deviceBackupTab.activeJobs.lastHeard', {
                      relative: formatRelativeTime(heardAt, { now: new Date(progress.now) }),
                    })}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
