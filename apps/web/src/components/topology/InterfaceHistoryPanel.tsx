import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TopologyInterfaceHistoryResponse, TopologyInterfaceHistorySeries } from '@breeze/shared';
import type { InterfaceHistoryParams } from './topologyApi';
import { useTopologyInterfaceHistory } from './useTopologyInterfaceHistory';
import { chartSegments, formatMetric, formatTime } from './topologyOperationsFormat';

/**
 * Bounded history of one canonical port (M3 Task 11). Passive: one GET per
 * explicit range/metric choice, no polling, and a read never starts telemetry.
 * Every series is one interface generation × one source × one producer epoch;
 * a generation change is a break between series, never a joined line. A null
 * bucket is a gap ("Not measured"), a measured zero stays zero, and the table
 * shows exactly the values the chart draws.
 */
export const HISTORY_METRICS = {
  throughput: ['in_bps', 'out_bps'],
  utilization: ['in_utilization_pct', 'out_utilization_pct'],
  errors: ['in_errors_per_second', 'out_errors_per_second', 'in_discards_per_second', 'out_discards_per_second'],
} as const satisfies Record<string, InterfaceHistoryParams['series']>;
export type HistoryMetric = keyof typeof HISTORY_METRICS;
export const HISTORY_RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
const WIDTH = 280, HEIGHT = 80;

const seriesKey = (series: TopologyInterfaceHistorySeries) => `${series.name}/${series.interfaceEpoch}/${series.sourceId}/${series.producerEpoch}`;

function HistoryChart({ series, from, to }: { series: TopologyInterfaceHistorySeries; from: number; to: number }) {
  const { t } = useTranslation('topology');
  const segments = chartSegments(series.points, from, to, WIDTH, HEIGHT);
  const measured = series.points.filter((point) => point.value !== null);
  const summary = measured.length
    ? t('operations.history.chartSummary', { series: t(/* i18n-dynamic */ `operations.history.series.${series.name}`), min: formatMetric(Math.min(...measured.map((p) => p.value!)), series.unit), max: formatMetric(Math.max(...measured.map((p) => p.value!)), series.unit) })
    : t('operations.history.noMeasurements');
  return <svg data-testid="topology-history-chart" role="img" aria-label={summary} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-20 w-full rounded border bg-background">
    {segments.map((segment, index) => segment.length === 1
      ? <circle key={index} cx={segment[0]![0]} cy={segment[0]![1]} r={2} className="fill-primary" />
      : <polyline key={index} points={segment.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" strokeWidth={1.5} className="stroke-primary" />)}
  </svg>;
}

export default function InterfaceHistoryPanel({ siteId, interfaceId, label, onClose }: { siteId: string; interfaceId: string; label: string; onClose?: () => void }) {
  const { t } = useTranslation('topology');
  const [metric, setMetric] = useState<HistoryMetric>('throughput');
  const [range, setRange] = useState<HistoryRange>('1h');
  const [reload, setReload] = useState(0);
  // The window is fixed when the user picks it (or reloads); no timer ever moves it.
  const query = useMemo<InterfaceHistoryParams>(() => {
    const to = Date.now();
    return { series: [...HISTORY_METRICS[metric]], from: new Date(to - HISTORY_RANGES[range]).toISOString(), to: new Date(to).toISOString() };
  }, [metric, range, reload]);
  const { history, loading, error } = useTopologyInterfaceHistory({ siteId }, interfaceId, query);
  return <section data-testid="topology-history" aria-labelledby="topology-history-heading" className="space-y-3 border-t pt-3">
    <div className="flex items-start justify-between gap-2">
      <h4 id="topology-history-heading" className="break-words font-medium">{t('operations.history.heading', { port: label })}</h4>
      {onClose && <button data-testid="topology-history-close" className="text-sm underline" onClick={onClose}>{t('close')}</button>}
    </div>
    <p className="text-xs text-muted-foreground">{t('operations.history.direction', { port: label })}</p>
    <div className="flex flex-wrap gap-2 text-sm">
      <label>{t('operations.history.metric')}<select data-testid="topology-history-metric" className="ml-1 rounded border bg-background p-1" value={metric} onChange={(event) => setMetric(event.target.value as HistoryMetric)}>
        {(Object.keys(HISTORY_METRICS) as HistoryMetric[]).map((key) => <option key={key} value={key}>{t(/* i18n-dynamic */ `operations.history.metrics.${key}`)}</option>)}
      </select></label>
      <label>{t('operations.history.range')}<select data-testid="topology-history-range" className="ml-1 rounded border bg-background p-1" value={range} onChange={(event) => setRange(event.target.value as HistoryRange)}>
        {(Object.keys(HISTORY_RANGES) as HistoryRange[]).map((key) => <option key={key} value={key}>{t(/* i18n-dynamic */ `operations.history.ranges.${key}`)}</option>)}
      </select></label>
      <button data-testid="topology-history-reload" className="rounded border px-2 py-1" onClick={() => setReload((n) => n + 1)}>{t('refresh')}</button>
    </div>
    {loading && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
    {error && <p data-testid="topology-history-error" role="alert" className="text-sm text-destructive">{error}</p>}
    {history && <HistoryBody history={history} />}
  </section>;
}

function HistoryBody({ history }: { history: TopologyInterfaceHistoryResponse }) {
  const { t } = useTranslation('topology');
  const from = Date.parse(history.interval.from), to = Date.parse(history.interval.to);
  const generations = new Set(history.epochs.map((epoch) => epoch.interfaceEpoch));
  const epochLabel = (series: TopologyInterfaceHistorySeries) => {
    const epoch = history.epochs.find((e) => e.interfaceEpoch === series.interfaceEpoch && e.sourceId === series.sourceId && e.producerEpoch === series.producerEpoch);
    return [t(/* i18n-dynamic */ `operations.history.source.${series.sourceKind}`),
      epoch?.current ? t('operations.history.currentGeneration') : t('operations.history.previousGeneration'),
      ...(epoch?.sourceState === 'stopped' ? [t('operations.history.sourceStopped')] : [])].join(' · ');
  };
  return <div className="space-y-3">
    <p data-testid="topology-history-coverage" className="text-sm">{t(/* i18n-dynamic */ `operations.coverage.${history.coverage}`)} · {t('operations.history.resolution', { resolution: history.resolution, seconds: history.interval.bucketSeconds })}</p>
    {generations.size > 1 && <p data-testid="topology-history-generation-break" role="note" className="rounded border border-amber-500/50 p-2 text-sm">{t('operations.history.generationBreak', { count: generations.size })}</p>}
    {!history.series.length && <p data-testid="topology-history-empty" className="text-sm text-muted-foreground">{t('notMeasured')}</p>}
    {history.series.map((series) => <div key={seriesKey(series)} data-testid="topology-history-series" data-series={series.name} data-epoch={series.interfaceEpoch} className="space-y-1">
      <p className="text-sm font-medium">{t(/* i18n-dynamic */ `operations.history.series.${series.name}`)} <span className="font-normal text-muted-foreground">({t(/* i18n-dynamic */ `operations.history.units.${series.unit}`)})</span></p>
      <p className="text-xs text-muted-foreground">{epochLabel(series)} · {t(/* i18n-dynamic */ `operations.coverage.${series.coverage}`)}</p>
      <HistoryChart series={series} from={from} to={to} />
      {series.gaps.length > 0 && <ul data-testid="topology-history-gaps" className="text-xs text-muted-foreground">{series.gaps.slice(0, 5).map((gap) =>
        <li key={`${gap.from}/${gap.reason}`}>{t('operations.history.gap', { from: formatTime(gap.from), to: formatTime(gap.to), reason: gap.reason.replaceAll('_', ' ') })}</li>)}
        {series.gaps.length > 5 && <li>{t('operations.history.moreGaps', { count: series.gaps.length - 5 })}</li>}</ul>}
    </div>)}
    {history.series.length > 0 && <details data-testid="topology-history-table-toggle"><summary className="cursor-pointer text-sm underline">{t('operations.history.table')}</summary>
      <div className="max-h-64 overflow-auto"><table data-testid="topology-history-table" className="w-full text-left text-xs">
        <thead><tr><th scope="col">{t('operations.history.time')}</th><th scope="col">{t('operations.history.seriesColumn')}</th><th scope="col">{t('operations.history.value')}</th></tr></thead>
        <tbody>{history.series.flatMap((series) => series.points.map((point) => <tr key={`${seriesKey(series)}/${point.at}`} data-testid="topology-history-row">
          <td>{formatTime(point.at)}</td><td>{t(/* i18n-dynamic */ `operations.history.series.${series.name}`)}</td>
          <td data-testid="topology-history-value">{point.value === null ? t('notMeasured') : formatMetric(point.value, series.unit)}</td>
        </tr>))}</tbody>
      </table></div></details>}
    {history.reasons.length > 0 && <p className="text-xs text-muted-foreground">{history.reasons.map((reason) => reason.replaceAll('_', ' ')).join(', ')}</p>}
  </div>;
}
