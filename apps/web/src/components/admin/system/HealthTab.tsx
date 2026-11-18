import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

/**
 * System → Health: shared background-processing observations (spec
 * 2026-10-30-system-health-admin-design §7). Read-only. Manual refresh only;
 * there is no background polling. Shows no overall verdict (§12.1).
 */

type Status = 'operational' | 'degraded' | 'unavailable' | 'unknown' | 'disabled';
type DetailCode = 'redis_unavailable' | 'read_failed' | 'timeout' | 'stale' | 'missing' | 'no_threshold';
type QueueCountKey = 'waiting' | 'prioritized' | 'delayed' | 'active';

interface QueueView {
  id: string;
  status: Status;
  checkedAt: string;
  detailCode: DetailCode | null;
  counts: Partial<Record<QueueCountKey, number>> | null;
}
interface JobView {
  id: 'reconcile' | 'digest' | 'kind';
  kind: string | null;
  status: Status;
  checkedAt: string;
  lastRunAt: string | null;
  failureStreak?: number;
  detailCode: DetailCode | null;
}
interface HealthReport {
  generatedAt: string;
  queues: QueueView[];
  jobs: JobView[];
}

const STATUSES: readonly string[] = ['operational', 'degraded', 'unavailable', 'unknown', 'disabled'];
const DETAIL_CODES: readonly string[] = ['redis_unavailable', 'read_failed', 'timeout', 'stale', 'missing', 'no_threshold'];
const COUNT_KEYS: readonly QueueCountKey[] = ['waiting', 'prioritized', 'delayed', 'active'];

const STATUS_CLASSES: Record<Status, string> = {
  operational: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  degraded: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  unavailable: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  unknown: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  disabled: 'bg-muted text-muted-foreground',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function isDateOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
}
function isQueue(v: unknown): v is QueueView {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.status === 'string' && STATUSES.includes(v.status) &&
    isDateOrNull(v.checkedAt) &&
    (v.detailCode === null || (typeof v.detailCode === 'string' && DETAIL_CODES.includes(v.detailCode))) &&
    (v.counts === null || isObject(v.counts))
  );
}
function isJob(v: unknown): v is JobView {
  return (
    isObject(v) &&
    (v.id === 'reconcile' || v.id === 'digest' || v.id === 'kind') &&
    typeof v.status === 'string' && STATUSES.includes(v.status) &&
    isDateOrNull(v.checkedAt) &&
    isDateOrNull(v.lastRunAt) &&
    (v.detailCode === null || (typeof v.detailCode === 'string' && DETAIL_CODES.includes(v.detailCode)))
  );
}
function isHealthReport(v: unknown): v is HealthReport {
  return (
    isObject(v) &&
    isDateOrNull(v.generatedAt) &&
    Array.isArray(v.queues) && v.queues.every(isQueue) &&
    Array.isArray(v.jobs) && v.jobs.every(isJob)
  );
}

function relativeTime(iso: string, locale: string): string {
  const diff = Date.parse(iso) - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'minute');
}

export default function HealthTab() {
  const { t, i18n } = useTranslation('admin');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/system/health');
      if (!response.ok) throw new Error(`GET /admin/system/health returned ${response.status}`);
      const body = (await response.json()) as { data?: unknown } | null;
      if (!isHealthReport(body?.data)) throw new Error('GET /admin/system/health returned a malformed report');
      setReport(body.data);
    } catch (err) {
      console.error('[HealthTab] failed to load background-work status', err);
      setReport(null);
      setError(stableT('admin.systemPage.health.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshButton = (
    <button
      type="button"
      data-testid="health-refresh"
      onClick={() => void load()}
      disabled={loading}
      className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded border hover:bg-muted disabled:opacity-50"
    >
      <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t('admin.systemPage.health.refresh')}
    </button>
  );

  const badge = (status: Status, testId?: string) => (
    <span
      {...(testId ? { 'data-testid': testId } : {})}
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${STATUS_CLASSES[status]}`}
    >
      {t(/* i18n-dynamic */ `admin.systemPage.health.status.${status}`)}
    </span>
  );

  const detail = (code: DetailCode | null) =>
    code ? (
      <div className="text-xs text-muted-foreground">
        {t(/* i18n-dynamic */ `admin.systemPage.health.detail.${code}`)}
      </div>
    ) : null;

  const when = (iso: string | null) =>
    iso ? relativeTime(iso, i18n.language) : t('admin.systemPage.health.never');

  return (
    <div className="space-y-6" data-testid="health-tab">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground max-w-3xl">{t('admin.systemPage.health.coverage')}</p>
        {refreshButton}
      </div>

      {loading && !report ? (
        <div className="text-center py-12 text-muted-foreground">{t('admin.systemPage.health.loading')}</div>
      ) : error ? (
        <div data-testid="health-error" role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      ) : report ? (
        <>
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">{t('admin.systemPage.health.queues.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('admin.systemPage.health.queues.description')}</p>
            <div className="rounded border divide-y" data-testid="health-queues">
              {report.queues.map((q) => (
                <div key={q.id} data-testid={`health-queue-${q.id}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {t(/* i18n-dynamic */ `admin.systemPage.health.queues.items.${q.id}`)}
                    </div>
                    {detail(q.detailCode)}
                  </div>
                  <div className="flex items-center gap-3">
                    {q.counts ? (
                      <dl className="flex gap-3 text-xs text-muted-foreground">
                        {COUNT_KEYS.map((k) => (
                          <div key={k}>
                            <dt className="inline">{t(/* i18n-dynamic */ `admin.systemPage.health.queues.counts.${k}`)}: </dt>
                            <dd className="inline font-mono text-foreground">{q.counts?.[k] ?? '—'}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {badge(q.status)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">{t('admin.systemPage.health.jobs.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('admin.systemPage.health.jobs.description')}</p>
            <div className="rounded border divide-y" data-testid="health-jobs">
              {report.jobs.map((j, i) => (
                <div key={`${j.id}-${j.kind ?? i}`} data-testid={`health-job-${j.id}${j.kind ? `-${j.kind}` : ''}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {j.id === 'kind'
                        ? t('admin.systemPage.health.jobs.kind', { kind: j.kind ?? '' })
                        : t(/* i18n-dynamic */ `admin.systemPage.health.jobs.items.${j.id}`)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('admin.systemPage.health.jobs.lastRun', { when: when(j.lastRunAt) })}
                      {j.failureStreak ? ` · ${t('admin.systemPage.health.jobs.failureStreak', { count: j.failureStreak })}` : ''}
                    </div>
                    {detail(j.detailCode)}
                  </div>
                  {badge(j.status)}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
