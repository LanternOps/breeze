import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { Drawer } from '../shared/Drawer';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';
import type { PatchJobStatus } from './PatchJobsList';

type PatchJobResultRow = {
  id: string;
  deviceId: string;
  deviceHostname: string | null;
  patchId: string | null;
  patchTitle: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  rebootRequired: boolean;
  rebootedAt: string | null;
};

type PatchJobDetailPayload = {
  id: string;
  name: string;
  status: PatchJobStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdByName: string | null;
  results: PatchJobResultRow[];
};

function normalizeResult(row: Record<string, unknown>): PatchJobResultRow {
  return {
    id: String(row.id ?? ''),
    deviceId: String(row.deviceId ?? ''),
    deviceHostname: typeof row.deviceHostname === 'string' ? row.deviceHostname : null,
    patchId: typeof row.patchId === 'string' ? row.patchId : null,
    patchTitle: typeof row.patchTitle === 'string' ? row.patchTitle : null,
    status: typeof row.status === 'string' ? row.status : 'pending',
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    completedAt: typeof row.completedAt === 'string' ? row.completedAt : null,
    rebootRequired: Boolean(row.rebootRequired),
    rebootedAt: typeof row.rebootedAt === 'string' ? row.rebootedAt : null,
  };
}

function normalizeJob(row: Record<string, unknown>): PatchJobDetailPayload {
  const rawResults = Array.isArray(row.results) ? row.results : [];
  return {
    id: String(row.id ?? ''),
    name: typeof row.name === 'string' ? row.name : '',
    status: (typeof row.status === 'string' ? row.status : 'scheduled') as PatchJobStatus,
    scheduledAt: typeof row.scheduledAt === 'string' ? row.scheduledAt : null,
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    completedAt: typeof row.completedAt === 'string' ? row.completedAt : null,
    createdByName: typeof row.createdByName === 'string' ? row.createdByName : null,
    results: rawResults.map((r) => normalizeResult(r as Record<string, unknown>)),
  };
}

type PatchJobDetailProps = {
  jobId: string;
  onClose: () => void;
};

export default function PatchJobDetail({ jobId, onClose }: PatchJobDetailProps) {
  const { t } = useTranslation('patches');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [job, setJob] = useState<PatchJobDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setNotFound(false);
    try {
      const response = await fetchWithAuth(`/patches/jobs/${jobId}`);
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        if (response.status === 404) { setNotFound(true); return; }
        throw new Error(stableT('patchJobDetail.errors.load'));
      }
      const data = await response.json();
      const row = data && typeof data === 'object' ? (data as { data?: unknown }).data : null;
      setJob(row && typeof row === 'object' ? normalizeJob(row as Record<string, unknown>) : null);
    } catch (err) {
      setJob(null);
      setError(err instanceof Error ? err.message : stableT('patchJobDetail.errors.load'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stableT is effect-safe (#3632)
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Drawer open onClose={onClose} title={job?.name ?? t('patchJobDetail.title')} width="max-w-xl" dataTestId="patch-job-detail-drawer">
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
              <p className="mt-4 text-sm text-muted-foreground">{t('patchJobDetail.loading')}</p>
            </div>
          </div>
        )}

        {!loading && notFound && (
          <div data-testid="patch-job-detail-not-found" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('patchJobDetail.notFound')}
          </div>
        )}

        {!loading && error && !notFound && (
          <div
            data-testid="patch-job-detail-error"
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
          >
            <p>{error}</p>
            <button type="button" data-testid="patch-job-detail-retry" className="mt-2 text-sm font-medium underline" onClick={() => void load()}>
              {t('common:actions.retry')}
            </button>
          </div>
        )}

        {!loading && job && (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t('patchJobDetail.summary.status')}</dt>
              <dd className="text-right font-medium">{t(`patchJobsList.status.${job.status}`)}</dd>
              <dt className="text-muted-foreground">{t('patchJobDetail.summary.createdBy')}</dt>
              <dd className="text-right">{job.createdByName ?? t('patchJobsList.createdBySystem')}</dd>
              <dt className="text-muted-foreground">{t('patchJobDetail.summary.scheduled')}</dt>
              <dd className="text-right">{job.scheduledAt ? formatDateTime(job.scheduledAt) : t('patchJobsList.notScheduled')}</dd>
              <dt className="text-muted-foreground">{t('patchJobDetail.summary.started')}</dt>
              <dd className="text-right">{job.startedAt ? formatDateTime(job.startedAt) : t('patchJobsList.notScheduled')}</dd>
              <dt className="text-muted-foreground">{t('patchJobDetail.summary.completed')}</dt>
              <dd className="text-right">{job.completedAt ? formatDateTime(job.completedAt) : t('patchJobsList.notScheduled')}</dd>
            </dl>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('patchJobDetail.resultsTitle', { count: job.results.length })}
              </h3>
              {job.results.length === 0 ? (
                <p data-testid="patch-job-detail-results-empty" className="mt-2 rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  {t('patchJobDetail.resultsEmpty')}
                </p>
              ) : (
                <ul className="mt-2 divide-y rounded-md border" data-testid="patch-job-detail-results">
                  {job.results.map((result) => (
                    <li key={result.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{result.deviceHostname ?? result.deviceId}</span>
                        <span
                          className={cn(
                            'shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium',
                            result.status === 'completed' && 'border-green-500/40 bg-green-500/20 text-green-700',
                            result.status === 'failed' && 'border-red-500/40 bg-red-500/20 text-red-700',
                            (result.status === 'running' || result.status === 'queued') && 'border-amber-500/40 bg-amber-500/20 text-amber-700',
                            (result.status === 'pending' || result.status === 'skipped') && 'border-border bg-muted text-muted-foreground',
                          )}
                        >
                          {result.status}
                        </span>
                      </div>
                      <span className="truncate text-xs text-muted-foreground">{result.patchTitle ?? '—'}</span>
                      <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                        <span>{t('patchJobDetail.columns.started')}: {result.startedAt ? formatDateTime(result.startedAt) : t('patchJobsList.notScheduled')}</span>
                        <span>{t('patchJobDetail.columns.completed')}: {result.completedAt ? formatDateTime(result.completedAt) : t('patchJobsList.notScheduled')}</span>
                        {result.rebootRequired && (
                          <span>
                            {t('patchJobDetail.columns.reboot')}: {result.rebootedAt ? t('patchJobDetail.rebootDone') : t('patchJobDetail.rebootRequired')}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}
