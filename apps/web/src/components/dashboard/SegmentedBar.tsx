import { cn } from '@/lib/utils';

export interface BarSegment {
  key: string;
  label: string;
  count: number;
  /** Tailwind bg-* class for the segment fill and its legend dot. */
  colorClass: string;
}

/**
 * Part-to-whole status bar: thin segments separated by surface gaps, with a
 * legend carrying label + count for every segment — identity is never
 * color-alone. Zero-count segments drop out of the bar but stay in the
 * legend (muted) so the vocabulary is stable between refreshes.
 */
export default function SegmentedBar({
  segments,
  ariaLabel,
}: {
  segments: BarSegment[];
  ariaLabel: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  const visible = segments.filter((s) => s.count > 0);

  return (
    <div>
      <div className="flex h-2 w-full gap-[3px]" role="img" aria-label={ariaLabel}>
        {total === 0 ? (
          <div className="h-full flex-1 rounded-[3px] bg-muted" />
        ) : (
          visible.map((s) => (
            <div
              key={s.key}
              className={cn('h-full rounded-[3px]', s.colorClass)}
              style={{ flexGrow: s.count, flexBasis: 8, minWidth: 8 }}
            />
          ))
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span
            key={s.key}
            className={cn(
              'inline-flex items-center gap-1.5 text-xs',
              s.count > 0 ? 'text-foreground/80' : 'text-muted-foreground/60'
            )}
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', s.colorClass)} aria-hidden="true" />
            {s.label}
            <span className="font-medium tabular-nums">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
