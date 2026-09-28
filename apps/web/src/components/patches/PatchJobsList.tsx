import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { ResponsiveTable, DataCard, CardField } from '../shared/ResponsiveTable';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { asList } from '@/lib/asList';
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

export type PatchJobStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

export type PatchJobRow = {
  id: string;
  name: string;
  status: PatchJobStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  devicesTotal: number;
  devicesCompleted: number;
  devicesFailed: number;
  createdByName: string | null;
};

const JOBS_PAGE_LIMIT = 25;

const STATUS_STYLES: Record<PatchJobStatus, string> = {
  scheduled: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  running: 'bg-amber-500/20 text-amber-700 border-amber-500/40',
  completed: 'bg-green-500/20 text-green-700 border-green-500/40',
  failed: 'bg-red-500/20 text-red-700 border-red-500/40',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

function normalizeJob(row: Record<string, unknown>): PatchJobRow {
  return {
    id: String(row.id ?? ''),
    name: typeof row.name === 'string' ? row.name : '',
    status: (typeof row.status === 'string' ? row.status : 'scheduled') as PatchJobStatus,
    scheduledAt: typeof row.scheduledAt === 'string' ? row.scheduledAt : null,
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    completedAt: typeof row.completedAt === 'string' ? row.completedAt : null,
    devicesTotal: Number(row.devicesTotal ?? 0),
    devicesCompleted: Number(row.devicesCompleted ?? 0),
    devicesFailed: Number(row.devicesFailed ?? 0),
    createdByName: typeof row.createdByName === 'string' ? row.createdByName : null,
  };
}

type PatchJobsListProps = {
  onSelectJob: (jobId: string) => void;
};

export default function PatchJobsList({ onSelectJob }: PatchJobsListProps) {
  const { t } = useTranslation('patches');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [jobs, setJobs] = useState<PatchJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchJobs = useCallback(async (requestedPage: number) => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/patches/jobs?page=${requestedPage}&limit=${JOBS_PAGE_LIMIT}`);
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw new Error(stableT('patchesPage.errors.fetchJobs'));
      }
      const data = await response.json();
      const rows = asList(data, 'jobs', 'items');
      setJobs(Array.isArray(rows) ? rows.map((r) => normalizeJob(r as Record<string, unknown>)) : []);
      const pagination = (data?.pagination ?? {}) as { total?: unknown };
      setTotal(Number(pagination.total) || 0);
    } catch (err) {
      setJobs([]);
      setError(err instanceof Error ? err.message : stableT('patchesPage.errors.fetchJobs'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stableT is effect-safe (#3632)
  }, []);

  useEffect(() => {
    void fetchJobs(page);
  }, [fetchJobs, page]);

  const totalPages = Math.max(1, Math.ceil(total / JOBS_PAGE_LIMIT));

  const renderDevices = (job: PatchJobRow) =>
    job.devicesFailed > 0
      ? t('patchJobsList.devicesSummaryWithFailed', {
          completed: job.devicesCompleted,
          total: job.devicesTotal,
          failed: job.devicesFailed,
        })
      : t('patchJobsList.devicesSummary', { completed: job.devicesCompleted, total: job.devicesTotal });

  const renderDate = (value: string | null) => (value ? formatDateTime(value) : t('patchJobsList.notScheduled'));

  if (loading && jobs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">{t('patchJobsList.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && jobs.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => void fetchJobs(page)}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('patchJobsList.actions.tryAgain')}
        </button>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div data-testid="patch-jobs-empty" className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('patchJobsList.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ResponsiveTable
        table={
          <table className="w-full text-sm" data-testid="patch-jobs-table">
            <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t('patchJobsList.columns.name')}</th>
                <th className="px-4 py-3">{t('patchJobsList.columns.status')}</th>
                <th className="px-4 py-3">{t('patchJobsList.columns.devices')}</th>
                <th className="px-4 py-3">{t('patchJobsList.columns.createdBy')}</th>
                <th className="px-4 py-3">{t('patchJobsList.columns.scheduled')}</th>
                <th className="px-4 py-3">{t('patchJobsList.columns.started')}</th>
                <th className="px-4 py-3">{t('patchJobsList.columns.completed')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  data-testid={`patch-job-row-${job.id}`}
                  onClick={() => onSelectJob(job.id)}
                  className="cursor-pointer transition hover:bg-muted/40"
                >
                  <td className="max-w-xs truncate px-4 py-3 font-medium">{job.name}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-xs font-medium', STATUS_STYLES[job.status])}>
                      {t(`patchJobsList.status.${job.status}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3">{renderDevices(job)}</td>
                  <td className="px-4 py-3">{job.createdByName ?? t('patchJobsList.createdBySystem')}</td>
                  <td className="px-4 py-3">{renderDate(job.scheduledAt)}</td>
                  <td className="px-4 py-3">{renderDate(job.startedAt)}</td>
                  <td className="px-4 py-3">{renderDate(job.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        cards={
          <>
            {jobs.map((job) => (
              <DataCard key={job.id} onClick={() => onSelectJob(job.id)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{job.name}</span>
                  <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium', STATUS_STYLES[job.status])}>
                    {t(`patchJobsList.status.${job.status}`)}
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  <CardField label={t('patchJobsList.columns.devices')}>{renderDevices(job)}</CardField>
                  <CardField label={t('patchJobsList.columns.createdBy')}>{job.createdByName ?? t('patchJobsList.createdBySystem')}</CardField>
                  <CardField label={t('patchJobsList.columns.scheduled')}>{renderDate(job.scheduledAt)}</CardField>
                </div>
              </DataCard>
            ))}
          </>
        }
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <button
            type="button"
            data-testid="patch-jobs-prev-page"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('patchJobsList.actions.previousPage')}
          </button>
          <span>{t('patchJobsList.pagination', { page, totalPages })}</span>
          <button
            type="button"
            data-testid="patch-jobs-next-page"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('patchJobsList.actions.nextPage')}
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
