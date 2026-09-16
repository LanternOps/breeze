// OID history (spec §11 Monitoring tab). One chart per selected OID, never two
// measures on one chart and never a second y-axis: the OIDs on one device span
// percentages, octet counters and timeticks, and a shared axis would make every
// small series invisible. Each chart owns its own request so one failure is one
// chart's error, not the tab's.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChartWidget from '../../analytics/ChartWidget';
import EmptyState from '../../shared/EmptyState';
import { Section } from './primitives';
import {
  MAX_SELECTED_OIDS,
  RANGE_BUCKET,
  useAssetMetrics,
  type MetricRange,
} from './useAssetMetrics';
import type { Collection, CollectionOid } from './types';

const RANGES: MetricRange[] = ['24h', '7d', '30d'];

const BUCKET_LABEL_KEYS: Record<string, string> = {
  '5m': 'networkDeviceDetailPage.charts.bucket.fiveMinutes',
  '1h': 'networkDeviceDetailPage.charts.bucket.hour',
  '1d': 'networkDeviceDetailPage.charts.bucket.day',
};

/**
 * Counters are cumulative, so the useful chart is the per-bucket delta, drawn
 * as bars. The value type comes from the stored metric rows (processPollResults
 * writes the template entry's type); with no row yet, treat the OID as a gauge
 * — a counter drawn as a line is merely dull, a gauge drawn as delta bars is
 * wrong.
 */
export function isCounterOid(entry: CollectionOid): boolean {
  return entry.instances.some((row) => (row.valueType ?? '').toLowerCase().startsWith('counter'));
}

/** Only an OID that has produced (or recently produced) a value can be charted. */
export function chartableOids(collection: Collection | null): CollectionOid[] {
  return (collection?.oids ?? []).filter((entry) => entry.state === 'collecting' || entry.state === 'stale');
}

function OidChart({
  assetId,
  entry,
  range,
}: {
  assetId: string;
  entry: CollectionOid;
  range: MetricRange;
}) {
  const { t } = useTranslation('devices');
  const counter = isCounterOid(entry);
  // The instance OID when the walk produced exactly one row, else the base OID
  // (the server fans a base OID out to its instances, capped at 64 series).
  const oid = entry.instances.length === 1 ? entry.instances[0].oid : entry.baseOid;
  const { series, truncatedSeries, loading, error, reload } = useAssetMetrics({
    assetId,
    oid,
    range,
    delta: counter,
  });

  const data = useMemo(() => {
    const rows = new Map<string, Record<string, string | number>>();
    for (const metric of series) {
      for (const [timestamp, value] of metric.points) {
        const row = rows.get(timestamp) ?? { timestamp };
        row[metric.instance || 'value'] = value;
        rows.set(timestamp, row);
      }
    }
    return [...rows.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }, [series]);
  const chartSeries = useMemo(() => series.map((metric) => ({
    key: metric.instance || 'value',
    label: metric.instance ? `${metric.name || entry.name} / ${metric.instance}` : metric.name || entry.name,
  })), [series, entry.name]);

  if (error) {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        data-testid={`network-detail-chart-error-${entry.baseOid}`}
      >
        <p>{error}</p>
        <button
          type="button"
          data-testid={`network-detail-chart-retry-${entry.baseOid}`}
          onClick={reload}
          className="mt-1 text-xs underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div data-testid={`network-detail-chart-${entry.baseOid}`} aria-busy={loading || undefined}>
      <ChartWidget
        title={entry.name}
        subtitle={
          counter
            ? t('networkDeviceDetailPage.charts.perBucket', {
                bucket: t(/* i18n-dynamic */ BUCKET_LABEL_KEYS[RANGE_BUCKET[range]]),
              })
            : entry.baseOid
        }
        type={counter ? 'bar' : 'line'}
        data={data}
        xKey="timestamp"
        series={chartSeries}
        height={220}
      />
      {truncatedSeries && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`network-detail-chart-truncated-${entry.baseOid}`}>
          {t('networkDeviceDetailPage.charts.truncated')}
        </p>
      )}
    </div>
  );
}

export function MetricHistoryCharts({
  assetId,
  collection,
  timezone: _timezone,
}: {
  assetId: string;
  collection: Collection | null;
  /** Reserved: the bucketed axis is already localised by ChartWidget. */
  timezone: string;
}) {
  const { t } = useTranslation('devices');
  const options = useMemo(() => chartableOids(collection), [collection]);
  const [range, setRange] = useState<MetricRange>('24h');
  const [selected, setSelected] = useState<string[]>([]);

  // Seed the selection once the collection arrives; never clobber a choice the
  // operator has already made.
  useEffect(() => {
    setSelected((current) => {
      const stillValid = current.filter((oid) => options.some((entry) => entry.baseOid === oid));
      if (stillValid.length > 0) return stillValid;
      return options.slice(0, 1).map((entry) => entry.baseOid);
    });
  }, [options]);

  if (options.length === 0) {
    return (
      <Section title={t('networkDeviceDetailPage.sections.history')} testId="network-detail-charts">
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-charts-empty"
          title={t('networkDeviceDetailPage.charts.emptyTitle')}
          description={t('networkDeviceDetailPage.charts.emptyDescription')}
        />
      </Section>
    );
  }

  const atCap = selected.length >= MAX_SELECTED_OIDS;
  const toggle = (baseOid: string) =>
    setSelected((current) =>
      current.includes(baseOid)
        ? current.filter((oid) => oid !== baseOid)
        : current.length >= MAX_SELECTED_OIDS
          ? current
          : [...current, baseOid],
    );

  return (
    <Section title={t('networkDeviceDetailPage.sections.history')} testId="network-detail-charts">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`network-detail-chart-range-${option}`}
            aria-pressed={range === option}
            onClick={() => setRange(option)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
              range === option
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-muted text-muted-foreground hover:border-muted-foreground hover:text-foreground'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <fieldset className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        <legend className="text-xs font-medium text-muted-foreground">
          {t('networkDeviceDetailPage.charts.pickOids')}
        </legend>
        {options.map((entry) => {
          const checked = selected.includes(entry.baseOid);
          return (
            <label key={entry.baseOid} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid={`network-detail-chart-pick-${entry.baseOid}`}
                checked={checked}
                disabled={!checked && atCap}
                onChange={() => toggle(entry.baseOid)}
                className="focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
              {entry.name}
            </label>
          );
        })}
      </fieldset>
      {atCap && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="network-detail-chart-cap">
          {t('networkDeviceDetailPage.charts.cap', { count: MAX_SELECTED_OIDS })}
        </p>
      )}

      <div className="mt-3 grid gap-4 xl:grid-cols-2">
        {options
          .filter((entry) => selected.includes(entry.baseOid))
          .map((entry) => (
            <OidChart key={entry.baseOid} assetId={assetId} entry={entry} range={range} />
          ))}
      </div>
    </Section>
  );
}
