import { useTranslation } from 'react-i18next';
import {
  formatSlaMinutes,
  isTicketSlaPerformanceSummary,
  type SlaPriority,
  type TicketSlaPerformanceRow,
} from '@breeze/shared';

const NOT_MEASURED = 'N/A';

function percent(ratio: number | null): string {
  return ratio === null ? NOT_MEASURED : `${(ratio * 100).toFixed(1)}%`;
}

function PriorityRow({ row, label }: { row: TicketSlaPerformanceRow; label: string }) {
  const { t } = useTranslation('reports');
  const target = (minutes: number | null, varies: boolean) =>
    varies ? `${formatSlaMinutes(minutes)} (${t('reports.reportPreview.slaPerformance.varies')})` : formatSlaMinutes(minutes);
  const cells = [
    String(row.ticketsOpened),
    target(row.responseTargetMinutes, row.responseTargetVaries),
    String(row.responseMeasured),
    percent(row.responseAttainment),
    formatSlaMinutes(row.responseMedianMinutes),
    formatSlaMinutes(row.responseMeanMinutes),
    target(row.resolutionTargetMinutes, row.resolutionTargetVaries),
    String(row.resolutionMeasured),
    percent(row.resolutionAttainment),
    formatSlaMinutes(row.resolutionMedianMinutes),
    formatSlaMinutes(row.resolutionMeanMinutes),
  ];
  return (
    <tr data-testid="sla-performance-priority-row" className="border-t">
      <td className="px-3 py-2 font-medium">{label}</td>
      {cells.map((cell, i) => (<td key={i} className="px-3 py-2">{cell}</td>))}
    </tr>
  );
}

/**
 * The designed preview for `ticket_sla_performance` (#11018). Its summary nests
 * objects and its rows have 23 columns, so the generic cards and row table would
 * print noise. An unmeasured (site-restricted) summary shows only its reason:
 * a table of zeros would read as a month with no tickets.
 */
export function TicketSlaPerformancePreview({ summary }: { summary: unknown }) {
  const { t } = useTranslation('reports');
  if (!isTicketSlaPerformanceSummary(summary)) {
    // Never a blank panel: the generic cards and table are suppressed for this type.
    console.warn('[ReportPreview] ticket_sla_performance summary has an unexpected shape', {
      reason: summary ? 'summary_shape_mismatch' : 'summary_missing',
    });
    return (
      <p data-testid="sla-performance-unavailable" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {t('reports.reportPreview.slaPerformance.unavailable')}
      </p>
    );
  }

  const notes = (
    <div className="rounded-lg border bg-card p-4">
      <h4 className="mb-1 text-sm font-semibold">{t('reports.reportPreview.slaPerformance.notes')}</h4>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {summary.notes.map((note, i) => (<li key={i}>{note}</li>))}
      </ul>
    </div>
  );
  if (summary.period.start === '') return <div data-testid="sla-performance-summary">{notes}</div>;

  const priorityLabel = (priority: SlaPriority) => t(/* i18n-dynamic */ `reports.reportPreview.slaPerformance.priorities.${priority}`);
  const columns = ['target', 'measured', 'withinSla', 'median', 'mean'] as const;
  const available = summary.breaches.available;
  return (
    <div className="space-y-4" data-testid="sla-performance-summary">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th colSpan={2} />
              <th colSpan={5} className="px-3 pt-2 text-center">{t('reports.reportPreview.slaPerformance.firstResponse')}</th>
              <th colSpan={5} className="px-3 pt-2 text-center">{t('reports.reportPreview.slaPerformance.resolution')}</th>
            </tr>
            <tr>
              <th className="px-3 py-2">{t('reports.reportPreview.slaPerformance.priority')}</th>
              <th className="px-3 py-2">{t('reports.reportPreview.slaPerformance.ticketsOpened')}</th>
              {[...columns, ...columns].map((column, i) => (
                <th key={i} className="px-3 py-2">{t(/* i18n-dynamic */ `reports.reportPreview.slaPerformance.${column}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.priorities.map((row) => (
              <PriorityRow key={row.priority} row={row} label={priorityLabel(row.priority as SlaPriority)} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">{t('reports.reportPreview.slaPerformance.breaches')}</p>
        <p data-testid="sla-performance-breach-count" className="mt-1 text-2xl font-bold">
          {t('reports.reportPreview.slaPerformance.breachCount', { count: available })}
        </p>
      </div>
      {notes}
    </div>
  );
}
