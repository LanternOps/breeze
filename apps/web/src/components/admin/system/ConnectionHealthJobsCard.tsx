import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

/**
 * System → Connections: are the connection-health background jobs alive?
 * Read-only. Fetches independently of the connections list so a failure here
 * never affects it. 401/403 renders nothing (the tab handles platform-admin
 * gating).
 */

type JobState = 'ok' | 'stale' | 'missing';
type KindState = JobState | 'failing';

interface JobView {
  lastRunAt: string | null;
  state: JobState;
}
interface KindView {
  kind: string;
  intervalMinutes: number;
  lastOkAt: string | null;
  failureStreak: number;
  state: KindState;
}
interface JobsReport {
  redis: 'ok' | 'unavailable';
  reconcile: JobView;
  digest: JobView;
  kinds: KindView[];
}

const JOB_STATES: readonly string[] = ['ok', 'stale', 'missing'];
const KIND_STATES: readonly string[] = ['ok', 'stale', 'missing', 'failing'];

const STATE_CLASSES: Record<KindState, string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  stale: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  failing: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  missing: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function isDateOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
}
function isJob(v: unknown): v is JobView {
  return isObject(v) && isDateOrNull(v.lastRunAt) && typeof v.state === 'string' && JOB_STATES.includes(v.state);
}
function isKind(v: unknown): v is KindView {
  return (
    isObject(v) &&
    typeof v.kind === 'string' &&
    isDateOrNull(v.lastOkAt) &&
    typeof v.failureStreak === 'number' &&
    typeof v.state === 'string' &&
    KIND_STATES.includes(v.state)
  );
}
function isJobsReport(v: unknown): v is JobsReport {
  return (
    isObject(v) &&
    (v.redis === 'ok' || v.redis === 'unavailable') &&
    isJob(v.reconcile) &&
    isJob(v.digest) &&
    Array.isArray(v.kinds) &&
    v.kinds.every(isKind)
  );
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

function relativeTime(iso: string, locale: string): string {
  const diff = Date.parse(iso) - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'minute');
}

export default function ConnectionHealthJobsCard() {
  const { t, i18n } = useTranslation('admin');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [report, setReport] = useState<JobsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/system/connection-health');
      if (response.status === 401 || response.status === 403) {
        setHidden(true);
        setReport(null);
        return;
      }
      if (!response.ok) throw new Error(`GET /admin/system/connection-health returned ${response.status}`);
      const body = (await response.json()) as { data?: unknown } | null;
      if (!isJobsReport(body?.data)) {
        throw new Error('GET /admin/system/connection-health returned a malformed report');
      }
      setHidden(false);
      setReport(body.data);
    } catch (err) {
      console.error('[ConnectionHealthJobsCard] failed to load job status', err);
      setReport(null);
      setError(stableT('admin.systemPage.connectionHealthJobs.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;

  const badge = (state: KindState, testId?: string) => (
    <span
      {...(testId ? { 'data-testid': testId } : {})}
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${STATE_CLASSES[state]}`}
    >
      {t(/* i18n-dynamic */ `admin.systemPage.connectionHealthJobs.state.${state}`)}
    </span>
  );

  const jobRow = (id: 'reconcile' | 'digest', job: JobView) => (
    <div
      key={id}
      data-testid={`connection-health-job-${id}`}
      className="flex items-center justify-between gap-3 px-3 py-2"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {t(/* i18n-dynamic */ `admin.systemPage.connectionHealthJobs.jobs.${id}.label`)}
        </div>
        <div className="text-xs text-muted-foreground">
          {t(/* i18n-dynamic */ `admin.systemPage.connectionHealthJobs.jobs.${id}.description`)}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span
          className="text-xs text-muted-foreground"
          title={job.lastRunAt ? new Date(job.lastRunAt).toLocaleString(i18n.language) : undefined}
        >
          {job.lastRunAt
            ? t('admin.systemPage.connectionHealthJobs.lastRun', { relative: relativeTime(job.lastRunAt, i18n.language) })
            : t('admin.systemPage.connectionHealthJobs.neverRun')}
        </span>
        {badge(job.state, 'connection-health-job-state')}
      </div>
    </div>
  );

  if (loading && !report && !error) return null;

  return (
    <section data-testid={report ? 'connection-health-jobs-card' : undefined} className="border rounded-md p-4 space-y-3">
      <header>
        <h2 className="text-lg font-semibold">{t('admin.systemPage.connectionHealthJobs.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('admin.systemPage.connectionHealthJobs.description')}</p>
      </header>

      {error && (
        <div data-testid="connection-health-jobs-error" className="flex items-center justify-between gap-3 text-sm">
          <span className="text-red-800 dark:text-red-200">{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="px-3 py-1 text-sm border rounded-md hover:bg-muted shrink-0"
          >
            {t('admin.systemPage.connectionHealthJobs.retry')}
          </button>
        </div>
      )}

      {report?.redis === 'unavailable' && (
        <p data-testid="connection-health-jobs-redis-unavailable" className="text-sm text-amber-900 dark:text-amber-200">
          {t('admin.systemPage.connectionHealthJobs.redisUnavailable')}
        </p>
      )}

      {report && report.redis === 'ok' && (
        <>
          <div className="border rounded divide-y">
            {jobRow('reconcile', report.reconcile)}
            {jobRow('digest', report.digest)}
          </div>
          {report.kinds.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{t('admin.systemPage.connectionHealthJobs.kindsHeading')}</h3>
              <ul className="border rounded divide-y">
                {report.kinds.map((k) => (
                  <li
                    key={k.kind}
                    data-testid={`connection-health-kind-${k.kind}`}
                    className="flex items-center justify-between gap-3 px-3 py-1.5"
                  >
                    <code className="font-mono text-xs break-all">{k.kind}</code>
                    <div className="flex items-center gap-3 shrink-0">
                      {k.state === 'failing' && (
                        <span className="text-xs text-red-800 dark:text-red-200">
                          {t('admin.systemPage.connectionHealthJobs.failureStreak', { count: k.failureStreak })}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {k.lastOkAt
                          ? t('admin.systemPage.connectionHealthJobs.lastOk', {
                              relative: relativeTime(k.lastOkAt, i18n.language),
                            })
                          : t('admin.systemPage.connectionHealthJobs.neverOk')}
                      </span>
                      {badge(k.state)}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
