import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { History, ShieldCheck, Timer, Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import {
  type ElevationRequest,
  FLOW_LABELS,
  decisionAttribution,
  requestTarget,
} from './types';
import {
  EmptyState,
  ErrorAlert,
  StatusBadge,
  TableSkeleton,
  tableClass,
  tableWrapClass,
  tbodyClass,
  tdClass,
  thClass,
  theadClass,
  theadRowClass,
  rowClass,
} from './ui';

interface OverviewData {
  active: ElevationRequest[];
  pendingTotal: number;
  recent: ElevationRequest[];
}

export default function PamOverviewTab({ liveTick }: { liveTick: number }) {
  const { t } = useTranslation('security');
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const [activeRes, pendingRes, recentRes] = await Promise.all([
        fetchWithAuth('/pam/active', { signal }),
        fetchWithAuth('/pam/elevation-requests?status=pending&limit=1', { signal }),
        fetchWithAuth('/pam/elevation-requests?limit=10', { signal }),
      ]);
      for (const res of [activeRes, pendingRes, recentRes]) {
        if (!res.ok) {
          if (res.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          throw new Error(
            t('pamPamOverviewTab.errors.loadWithStatus', {
              defaultValue: 'Failed to load overview (HTTP {{status}})',
              status: res.status,
            }),
          );
        }
      }
      const activeBody = await activeRes.json();
      const pendingBody = await pendingRes.json();
      const recentBody = await recentRes.json();
      setData({
        active: (activeBody.active ?? []) as ElevationRequest[],
        pendingTotal: Number(pendingBody.pagination?.total ?? 0),
        recent: ((recentBody.requests ?? []) as ElevationRequest[]).filter(
          (r) => r.status !== 'pending',
        ),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(
        err instanceof Error
          ? err.message
          : t('pamPamOverviewTab.errors.load', { defaultValue: 'Failed to load overview' }),
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchOverview(controller.signal);
    return () => controller.abort();
  }, [fetchOverview, liveTick]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border bg-card p-4 shadow-xs">
              <div className="skeleton h-3 w-28" />
              <div className="skeleton mt-3 h-8 w-12" />
            </div>
          ))}
        </div>
        <TableSkeleton
          rows={4}
          label={t('pamPamOverviewTab.loading', { defaultValue: 'Loading overview…' })}
        />
      </div>
    );
  }

  const isFirstRun =
    !!data && data.active.length === 0 && data.pendingTotal === 0 && data.recent.length === 0;

  return (
    <div className="space-y-6">
      {error && <ErrorAlert>{error}</ErrorAlert>}

      {isFirstRun && (
        <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="pam-setup-steps">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <ShieldCheck className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold">
              {t('pamPamOverviewTab.setup.title', {
                defaultValue: 'Getting started with Privileged Access',
              })}
            </p>
          </div>
          <ol className="mt-3 list-decimal space-y-1.5 pl-10 text-sm text-muted-foreground marker:font-medium marker:text-foreground">
            <li>
              {t('pamPamOverviewTab.setup.step1BeforeLink', {
                defaultValue: 'UAC prompt capture is on by default. Scope it per device with a',
              })}{' '}
              <a
                href="/configuration-policies"
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                {t('pamPamOverviewTab.setup.configurationPolicyLink', {
                  defaultValue: 'Configuration Policy → Privileged Access',
                })}
              </a>{' '}
              {t('pamPamOverviewTab.setup.step1AfterLink', { defaultValue: 'feature link.' })}
            </li>
            <li>
              {t('pamPamOverviewTab.setup.step2', {
                defaultValue:
                  'Elevation prompts, JIT admin requests, and AI tool actions queue in the Requests tab.',
              })}
            </li>
            <li>
              {t('pamPamOverviewTab.setup.step3', {
                defaultValue:
                  'Approve or deny each request — or create a rule from it so the decision is automatic next time.',
              })}
            </li>
          </ol>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={ShieldCheck}
          iconClass="bg-green-500/10 text-green-600 dark:text-green-400"
          label={t('pamPamOverviewTab.stats.activeElevations', { defaultValue: 'Active elevations' })}
          value={data?.active.length ?? 0}
          testId="pam-stat-active"
        />
        <StatCard
          icon={Inbox}
          iconClass="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          label={t('pamPamOverviewTab.stats.pendingRequests', { defaultValue: 'Pending requests' })}
          value={data?.pendingTotal ?? 0}
          testId="pam-stat-pending"
        />
        <StatCard
          icon={Timer}
          iconClass="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          label={t('pamPamOverviewTab.stats.recentDecisions', { defaultValue: 'Recent decisions' })}
          value={data?.recent.length ?? 0}
          testId="pam-stat-recent"
        />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">
          {t('pamPamOverviewTab.active.title', { defaultValue: 'Active elevations' })}
        </h2>
        {!data || data.active.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={t('pamPamOverviewTab.active.emptyTitle', { defaultValue: 'No active elevations' })}
            description={t('pamPamOverviewTab.active.emptyDescription', {
              defaultValue:
                'Approved elevation windows will appear here until they expire or are revoked.',
            })}
          />
        ) : (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr className={theadRowClass}>
                  <th className={thClass}>{t('pamPamOverviewTab.table.device', { defaultValue: 'Device' })}</th>
                  <th className={thClass}>{t('pamPamOverviewTab.table.user', { defaultValue: 'User' })}</th>
                  <th className={thClass}>{t('pamPamOverviewTab.table.target', { defaultValue: 'Target' })}</th>
                  <th className={thClass}>{t('pamPamOverviewTab.table.flow', { defaultValue: 'Flow' })}</th>
                  <th className={thClass}>{t('pamPamOverviewTab.table.status', { defaultValue: 'Status' })}</th>
                  <th className={thClass}>{t('pamPamOverviewTab.table.expires', { defaultValue: 'Expires' })}</th>
                </tr>
              </thead>
              <tbody className={tbodyClass}>
                {data.active.map((r) => (
                  <tr key={r.id} className={rowClass} data-testid={`pam-active-row-${r.id}`}>
                    <td className={`${tdClass} font-medium`}>{r.deviceHostname ?? r.deviceId}</td>
                    <td className={tdClass}>{r.subjectUsername}</td>
                    <td className={`${tdClass} max-w-[280px] truncate`} title={requestTarget(r)}>
                      {requestTarget(r)}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap`}>{FLOW_LABELS[r.flowType]}</td>
                    <td className={tdClass}>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className={`${tdClass} whitespace-nowrap tabular-nums text-muted-foreground`}>
                      {r.expiresAt ? <ExpiresIn at={r.expiresAt} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">
          {t('pamPamOverviewTab.recent.title', { defaultValue: 'Recent decisions' })}
        </h2>
        {!data || data.recent.length === 0 ? (
          <EmptyState
            icon={History}
            title={t('pamPamOverviewTab.recent.empty', { defaultValue: 'No decided requests yet.' })}
          />
        ) : (
          <ul className="divide-y rounded-lg border bg-card shadow-xs">
            {data.recent.map((r) => {
              const attribution = decisionAttribution(r);
              return (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40"
                >
                  <span className="min-w-0 flex-1 truncate" title={requestTarget(r)}>
                    <span className="font-medium">{r.deviceHostname ?? r.deviceId}</span>
                    <span className="text-muted-foreground"> · {r.subjectUsername} · </span>
                    <span className="text-muted-foreground">{requestTarget(r)}</span>
                  </span>
                  {attribution && (
                    <span
                      className="shrink-0 text-xs text-muted-foreground"
                      data-testid={`pam-decided-by-${r.id}`}
                      title={attribution}
                    >
                      {attribution}
                    </span>
                  )}
                  <StatusBadge status={r.status} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  iconClass,
  label,
  value,
  testId,
}: {
  icon: typeof ShieldCheck;
  iconClass: string;
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-lg border bg-card p-4 shadow-xs"
      data-testid={testId}
    >
      <div>
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1.5 text-3xl font-bold tabular-nums tracking-tight">{value}</div>
      </div>
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${iconClass}`}>
        <Icon className="h-4.5 w-4.5" aria-hidden="true" />
      </div>
    </div>
  );
}

function ExpiresIn({ at }: { at: string }) {
  const { t } = useTranslation('security');
  const ms = new Date(at).getTime() - Date.now();
  if (Number.isNaN(ms)) return <>—</>;
  if (ms <= 0) return <>{t('pamPamOverviewTab.expires.expired', { defaultValue: 'expired' })}</>;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return <>{mins}m</>;
  const hours = Math.floor(mins / 60);
  return (
    <>
      {hours}h {mins % 60}m
    </>
  );
}
