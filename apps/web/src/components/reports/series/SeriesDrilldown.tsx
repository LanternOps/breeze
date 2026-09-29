import type { SeriesDetail } from './types';

/** Placeholder until Task 8 renders the per-org drill-down. */
export function SeriesDrilldown(props: { detail: SeriesDetail; onChanged: () => void; timezone: string }) {
  return <div data-testid={`series-drilldown-${props.detail.series.id}`} />;
}
