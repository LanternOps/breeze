import { useEffect, useState } from 'react';
import { Layers, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useJwtClaims } from '@/lib/authScope';
import { handleActionError } from '@/lib/runAction';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { useDefaultReportOwnerScope } from '../ReportOwnerScopeField';
import type { Report } from '../ReportsList';
import { SeriesChildRecipients } from './SeriesChildRecipients';
import { detachSeriesChild, fetchSeriesDetail } from './seriesApi';
import type { SeriesRecipientRule } from './types';

export type SeriesChildAccess = 'msp' | 'readonly' | 'managed';

/** msp = may administer the series; readonly = MSP staff without partner-wide
 *  rights; managed = an organization user. Unresolved fails closed (managed). */
export function useSeriesChildAccess(): SeriesChildAccess {
  const { canChoose } = useDefaultReportOwnerScope();
  const claims = useJwtClaims();
  if (canChoose) return 'msp';
  if (claims.status === 'resolved' && claims.claims.scope === 'partner') return 'readonly';
  return 'managed';
}

export function SeriesChildLockBanner({ report, access, onDetached }: { report: Report; access: SeriesChildAccess; onDetached: () => void }) {
  const { t } = useTranslation('reports');
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const archived = Boolean(report.archivedAt);

  const detach = async () => {
    setDetaching(true);
    try {
      await detachSeriesChild(report.id, {
        errorFallback: t('reports.series.drilldown.detachFailed'),
        successMessage: t('reports.series.drilldown.detached', { org: report.name }),
      });
      onDetached();
    } catch (err) {
      handleActionError(err, t('reports.series.drilldown.detachFailed'));
    } finally {
      setDetaching(false);
    }
  };

  return (
    <div data-testid="series-child-lock-banner" data-variant={access} className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {access === 'managed' ? (
          <span data-testid="series-child-managed-badge" className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            <Lock className="h-3 w-3" />
            {t('reports.series.child.managedByMsp')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm font-medium">
            <Layers className="h-4 w-4" />
            {report.seriesName
              ? t('reports.series.child.partOf', { name: report.seriesName })
              : t('reports.series.child.partOfUnnamed')}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {access === 'managed' ? t('reports.series.child.managedExplanation') : t('reports.series.child.lockedExplanation')}
      </p>
      {archived && (
        <p data-testid="series-child-archived" role="status" className="text-sm text-warning">{t('reports.series.child.archived')}</p>
      )}
      {access === 'msp' && (
        <div className="flex flex-wrap gap-2">
          <a
            data-testid="series-child-edit-series"
            href={`/reports/series/${report.seriesId}`}
            className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-sm hover:bg-muted"
          >
            {t('reports.series.child.editSeries')}
          </a>
          {!archived && (
            <button
              type="button"
              data-testid="series-child-detach"
              disabled={detaching}
              onClick={() => setConfirmDetach(true)}
              className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
            >
              {t('reports.series.child.detach')}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDetach}
        onClose={() => setConfirmDetach(false)}
        onConfirm={() => {
          setConfirmDetach(false);
          void detach();
        }}
        title={t('reports.series.drilldown.detachTitle', { org: report.name })}
        message={t('reports.series.drilldown.detachMessage', { org: report.name })}
        confirmLabel={t('reports.series.drilldown.detachConfirm')}
        variant="warning"
        confirmTestId="series-confirm-child-detach"
      />
    </div>
  );
}

/** Read-only view of the series-owned fields (spec §3.7 "shown locked"). */
export function SeriesChildSummary({ report }: { report: Report }) {
  const { t } = useTranslation('reports');
  const rows: [string, string][] = [
    [t('reports.series.child.summary.type'), t(/* i18n-dynamic */ `reports.reportsList.reportTypes.${report.type}`)],
    [t('reports.series.child.summary.schedule'), t(/* i18n-dynamic */ `reports.reportsList.schedules.${report.schedule}`)],
    [t('reports.series.child.summary.format'), t(/* i18n-dynamic */ `reports.reportsList.formats.${report.format}`)],
  ];
  return (
    <dl data-testid="series-child-summary" className="grid gap-3 rounded-lg border bg-card p-6 text-sm shadow-xs sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium uppercase text-muted-foreground">{label}</dt>
          <dd className="mt-1">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The whole edit page body for a series child: banner, locked summary, and the
 * per-org recipient overrides. Never renders ReportBuilder — every other write
 * would answer 409 series_managed.
 */
export function SeriesChildView({ report, onChanged }: { report: Report; onChanged: () => void }) {
  const access = useSeriesChildAccess();
  const [rule, setRule] = useState<SeriesRecipientRule | null>(null);

  useEffect(() => {
    // Only a user who may read report_series asks for it (Review Focus 5).
    if (access !== 'msp' || !report.seriesId) return;
    let live = true;
    fetchSeriesDetail(report.seriesId)
      .then((detail) => {
        if (live && detail) setRule(detail.series.recipientRule);
      })
      .catch((err: unknown) => {
        // The rule only powers the "Included by rule" hint; editing still works.
        console.warn('[SeriesChildView] series rule unavailable', err);
      });
    return () => {
      live = false;
    };
  }, [access, report.seriesId]);

  return (
    <div className="space-y-6">
      <SeriesChildLockBanner report={report} access={access} onDetached={onChanged} />
      <SeriesChildSummary report={report} />
      {!report.archivedAt && report.orgId && (
        <SeriesChildRecipients reportId={report.id} orgId={report.orgId} rule={rule} />
      )}
    </div>
  );
}
