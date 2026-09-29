import { useMemo, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { DeliveryStatusChip } from '../DeliveryStatusChip';
import { detachSeriesChild, generateSeriesChild, replaceSeriesTargets } from './seriesApi';
import { canExcludeOrg, targetsAfterExclude, targetsAfterInclude } from './listModel';
import type { SeriesDetail, SeriesOrgStatus } from './types';

type Pending = { kind: 'exclude' | 'detach'; org: SeriesOrgStatus } | null;
const HAS_CHILD_STATES = new Set<SeriesOrgStatus['state']>(['active', 'blocked_no_authority', 'blocked_no_recipients']);

/** The per-org lines of one series (spec §3.7): Run now / Edit recipients / Exclude / Include / Detach. */
export function SeriesDrilldown({ detail, onChanged, timezone }: { detail: SeriesDetail; onChanged: () => void; timezone: string }) {
  const { t } = useTranslation('reports');
  const [pending, setPending] = useState<Pending>(null);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const seriesId = detail.series.id;
  const orgs = useMemo(() => [...detail.orgs].sort((a, b) => a.orgName.localeCompare(b.orgName)), [detail.orgs]);

  const act = async (org: SeriesOrgStatus, action: () => Promise<unknown>, fallback: string) => {
    setBusyOrgId(org.orgId);
    try {
      await action();
      onChanged();
    } catch (err) {
      handleActionError(err, fallback);
    } finally {
      setBusyOrgId(null);
    }
  };

  const exclude = (org: SeriesOrgStatus) =>
    act(org, () => replaceSeriesTargets(seriesId, targetsAfterExclude(detail, org.orgId), {
      errorFallback: t('reports.series.drilldown.updateFailed'),
      successMessage: t('reports.series.drilldown.excluded', { org: org.orgName }),
    }), t('reports.series.drilldown.updateFailed'));
  const include = (org: SeriesOrgStatus) =>
    act(org, () => replaceSeriesTargets(seriesId, targetsAfterInclude(detail, org.orgId), {
      errorFallback: t('reports.series.drilldown.updateFailed'),
      successMessage: t('reports.series.drilldown.included', { org: org.orgName }),
    }), t('reports.series.drilldown.updateFailed'));
  const detach = (org: SeriesOrgStatus) =>
    act(org, () => detachSeriesChild(org.childReportId!, {
      errorFallback: t('reports.series.drilldown.detachFailed'),
      successMessage: t('reports.series.drilldown.detached', { org: org.orgName }),
    }), t('reports.series.drilldown.detachFailed'));
  const runNow = (org: SeriesOrgStatus) =>
    act(org, () => generateSeriesChild(org.childReportId!, {
      errorFallback: t('reports.series.drilldown.generateFailed'),
      successMessage: t('reports.series.drilldown.generated', { org: org.orgName }),
    }), t('reports.series.drilldown.generateFailed'));

  return (
    <div data-testid={`series-drilldown-${seriesId}`} className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.org')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.state')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.lastRun')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.delivery')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.recipients')}</th>
            <th className="px-3 py-2 text-right">{t('reports.series.drilldown.columns.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {orgs.map((org) => {
            const hasChild = Boolean(org.childReportId) && HAS_CHILD_STATES.has(org.state);
            const busy = busyOrgId === org.orgId;
            const excludable = canExcludeOrg(detail, org.orgId);
            const hint =
              org.state === 'blocked_no_authority'
                ? t('reports.series.drilldown.noAuthorityHint')
                : org.state !== 'excluded' && !excludable
                  ? t('reports.series.drilldown.lastOrgHint')
                  : null;
            return (
              <tr key={org.orgId} data-testid={`series-org-row-${org.orgId}`} data-state={org.state}>
                <td className="px-3 py-2 font-medium">{org.orgName}</td>
                <td className="px-3 py-2">
                  {t(/* i18n-dynamic */ `reports.series.drilldown.states.${org.state}`)}
                  {hint && <p data-testid={`series-org-hint-${org.orgId}`} className="text-xs text-muted-foreground">{hint}</p>}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {org.lastRun?.completedAt ? formatDateTime(org.lastRun.completedAt, { timeZone: timezone }) : t('reports.series.drilldown.neverRun')}
                </td>
                <td className="px-3 py-2">
                  {/* W01's chip owns the warning states (no_recipients / partial / failed) and
                      renders nothing for the others, which get a plain label here. */}
                  {org.lastRun?.deliveryStatus === 'sent' || org.lastRun?.deliveryStatus === 'not_scheduled'
                    ? t(/* i18n-dynamic */ `reports.series.drilldown.delivery.${org.lastRun.deliveryStatus}`)
                    : org.lastRun?.deliveryStatus
                      ? <DeliveryStatusChip status={org.lastRun.deliveryStatus} testId={`series-org-delivery-${org.orgId}`} />
                      : '—'}
                </td>
                <td className="px-3 py-2">{org.lastRun?.recipientCount ?? '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {hasChild && (
                      <button
                        type="button"
                        data-testid={`series-org-run-${org.orgId}`}
                        disabled={busy || org.state === 'blocked_no_authority'}
                        onClick={() => void runNow(org)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        {t('reports.series.drilldown.actions.runNow')}
                      </button>
                    )}
                    {hasChild && (
                      <a
                        data-testid={`series-org-recipients-${org.orgId}`}
                        href={`/reports/${org.childReportId}/edit`}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted"
                      >
                        {t('reports.series.drilldown.actions.editRecipients')}
                      </a>
                    )}
                    {org.state === 'excluded' ? (
                      <button
                        type="button"
                        data-testid={`series-org-include-${org.orgId}`}
                        disabled={busy}
                        onClick={() => void include(org)}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t('reports.series.drilldown.actions.include')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`series-org-exclude-${org.orgId}`}
                        disabled={busy || !excludable}
                        onClick={() => setPending({ kind: 'exclude', org })}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t('reports.series.drilldown.actions.exclude')}
                      </button>
                    )}
                    {hasChild && (
                      <button
                        type="button"
                        data-testid={`series-org-detach-${org.orgId}`}
                        disabled={busy}
                        onClick={() => setPending({ kind: 'detach', org })}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t('reports.series.drilldown.actions.detach')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const current = pending;
          setPending(null);
          if (!current) return;
          void (current.kind === 'exclude' ? exclude(current.org) : detach(current.org));
        }}
        title={pending ? t(/* i18n-dynamic */ `reports.series.drilldown.${pending.kind}Title`, { org: pending.org.orgName }) : ''}
        message={pending ? t(/* i18n-dynamic */ `reports.series.drilldown.${pending.kind}Message`, { org: pending.org.orgName }) : ''}
        confirmLabel={pending ? t(/* i18n-dynamic */ `reports.series.drilldown.${pending.kind}Confirm`) : undefined}
        variant={pending?.kind === 'detach' ? 'warning' : 'destructive'}
        confirmTestId={pending?.kind === 'detach' ? 'series-confirm-detach' : 'series-confirm-exclude'}
      />
    </div>
  );
}
