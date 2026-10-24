// The only way a number (or a card title) renders on a dashboard card. The
// registry (`DASHBOARD_METRICS`) decides whether it is a link, where it goes and
// who may follow it; an unregistered `metric` is a type error (spec §3.1).
//
//   <DashboardMetric metric="fleet.legend.offline" label="Offline" data={{ devices }}>{12}</DashboardMetric>
//
// - Link: `<a>` whose accessible name is label + number ("Offline 12"), with a
//   resting underline (#9033) and a focus-visible ring.
// - Text: a `<span>` with no disabled styling and no tooltip, when the entry is
//   exempt, has no destination for this data, the caller forces `linked={false}`,
//   or the viewer cannot open the destination (R4).
// Both carry `data-metric` so the inventory test can prove no digit run on a card
// sits outside the helper.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useNavViewer } from '../../lib/navVisibility';
import { DASHBOARD_METRICS, type DashboardData, type MetricDef, type MetricKey } from './dashboardLinks';

export interface DashboardMetricProps {
  metric: MetricKey;
  /** Visible label; becomes part of the link text so the name reads "Label 12". */
  label?: string;
  children: ReactNode;
  /** Data the href builder may read (e.g. the device stats for the "Other" legend). */
  data?: DashboardData;
  /** Force plain text (e.g. the backing summary failed to load). */
  linked?: boolean;
  className?: string;
  /** Class for the number when `label` is given. */
  valueClassName?: string;
  /** Overrides the registry's default `data-testid`. */
  testId?: string;
}

const LINK_CLASS =
  'underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-current ' +
  'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';

export function DashboardMetric({
  metric,
  label,
  children,
  data,
  linked = true,
  className,
  valueClassName,
  testId,
}: DashboardMetricProps) {
  const viewer = useNavViewer();
  const def: MetricDef = DASHBOARD_METRICS[metric];

  const href = linked && def.kind !== 'exempt' && def.href ? def.href(data ?? {}) : null;
  const allowed = def.visible ? def.visible(viewer) : true;

  // The text variant keeps only an explicit id (a tile's own test hook): the
  // registry's default ids name links, and a span must not impersonate one.
  const explicitTestId = testId;

  const body =
    label === undefined ? (
      children
    ) : (
      <>
        {label} <span className={valueClassName}>{children}</span>
      </>
    );

  if (href && allowed) {
    return (
      <a
        href={href}
        data-metric={metric}
        data-testid={testId ?? def.testId}
        className={cn(LINK_CLASS, className)}
      >
        {body}
      </a>
    );
  }

  return (
    <span data-metric={metric} data-testid={explicitTestId} className={className}>
      {body}
    </span>
  );
}

export default DashboardMetric;
