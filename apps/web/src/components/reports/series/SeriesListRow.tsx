import { useState } from 'react';
import { AlertTriangle, ArrowRightLeft, ChevronDown, ChevronRight, Layers, Pencil, Trash2 } from 'lucide-react';
import { handleActionError } from '@/lib/runAction';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/lib/dateTimeFormat';
import { CoversCell } from '../CoversCell';
import { SeriesDrilldown } from './SeriesDrilldown';
import { SeriesPauseButton, SeriesPausedBadge } from './SeriesPauseButton';
import { TransferOwnerDialog } from './TransferOwnerDialog';
import { deleteSeries } from './seriesApi';
import { SAVED_REPORTS_COLUMN_COUNT, seriesCoveredOrgCount, summarizeSeriesDelivery } from './listModel';
import type { SeriesDetail } from './types';

export interface SeriesListRowProps {
  detail: SeriesDetail;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  timezone: string;
}

/** One series as one expandable row of the Saved Reports table (spec §3.7). */
export function SeriesListRow({ detail, expanded, onToggle, onChanged, timezone }: SeriesListRowProps) {
  const { t } = useTranslation('reports');
  const { series } = detail;
  const summary = summarizeSeriesDelivery(detail.orgs);
  const warn = summary.noRecipient > 0 || summary.blocked > 0;
  const paused = series.enabled === false;
  const [transferOpen, setTransferOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteSeries(series.id, {
        errorFallback: t('reports.series.list.deleteFailed'),
        successMessage: t('reports.series.list.deleted', { name: series.name }),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t('reports.series.list.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <tr data-testid={`report-series-row-${series.id}`} className="hover:bg-muted/30">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid={`report-series-toggle-${series.id}`}
              aria-expanded={expanded}
              aria-controls={`series-drilldown-${series.id}`}
              aria-label={expanded ? t('reports.series.list.collapse') : t('reports.series.list.expand')}
              onClick={onToggle}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            <Layers className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{series.name}</span>
          </div>
        </td>
        <td className="px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <CoversCell
              testId={`report-series-covers-${series.id}`}
              orgId={null}
              series={{ seriesId: series.id, targetMode: series.targetMode, orgCount: seriesCoveredOrgCount(detail) }}
            />
            {paused && <SeriesPausedBadge testId={`report-series-paused-covers-${series.id}`} />}
          </div>
        </td>
        <td className="px-4 py-3 text-sm">{t(/* i18n-dynamic */ `reports.reportsList.reportTypes.${series.type}`)}</td>
        <td className="px-4 py-3 text-sm">{t(/* i18n-dynamic */ `reports.reportsList.schedules.${series.schedule}`)}</td>
        <td className="px-4 py-3 text-sm">{t(/* i18n-dynamic */ `reports.reportsList.formats.${series.format}`)}</td>
        <td data-testid={`report-series-summary-${series.id}`} className="px-4 py-3 text-sm text-muted-foreground">
          {/* Paused is shown once, in the Covers cell. */}
          {summary.lastRunAt ? (
            <span className="inline-flex items-center gap-1">
              {[
                t('reports.series.list.summary', {
                  date: formatDate(summary.lastRunAt, { timeZone: timezone, month: 'short', day: 'numeric' }),
                  delivered: summary.delivered,
                  total: summary.total,
                }),
                ...(summary.noRecipient > 0 ? [t('reports.series.list.summaryNoRecipient', { count: summary.noRecipient })] : []),
                ...(summary.blocked > 0 ? [t('reports.series.list.summaryBlocked', { count: summary.blocked })] : []),
              ].join(' · ')}
              {warn && <AlertTriangle className="h-3 w-3 text-warning" aria-hidden="true" />}
            </span>
          ) : (
            t('reports.series.list.summaryNever')
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1" data-testid={`report-series-actions-${series.id}`}>
            <a
              data-testid={`report-series-edit-${series.id}`}
              href={`/reports/series/${series.id}`}
              title={t('reports.series.list.actions.edit')}
              aria-label={t('reports.series.list.actions.edit')}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <Pencil className="h-4 w-4" />
            </a>
            <SeriesPauseButton detail={detail} onChanged={onChanged} testId={`report-series-pause-${series.id}`} />
            <button
              type="button"
              data-testid={`report-series-transfer-${series.id}`}
              title={t('reports.series.list.actions.transferOwner')}
              aria-label={t('reports.series.list.actions.transferOwner')}
              onClick={() => setTransferOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <ArrowRightLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={`report-series-delete-${series.id}`}
              title={t('reports.series.list.actions.delete')}
              aria-label={t('reports.series.list.actions.delete')}
              disabled={deleting}
              onClick={() => setConfirmDelete(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-muted disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td id={`series-drilldown-${series.id}`} colSpan={SAVED_REPORTS_COLUMN_COUNT} className="bg-muted/20 px-4 py-3">
            <SeriesDrilldown detail={detail} onChanged={onChanged} timezone={timezone} />
          </td>
        </tr>
      )}
      <TransferOwnerDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        seriesId={series.id}
        currentOwnerId={series.ownerUserId}
        onTransferred={onChanged}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void handleDelete();
        }}
        title={t('reports.series.list.deleteTitle')}
        message={t('reports.series.list.deleteMessage', { name: series.name })}
        confirmLabel={t('reports.series.list.deleteConfirm')}
        confirmTestId="series-confirm-delete"
      />
    </>
  );
}
