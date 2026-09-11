import type { ThreatWeekDto } from '@breeze/shared';

/**
 * Eight quiet weeks of "what did we find, and did we clear it". When every
 * week is zero there is nothing to draw — a 160px-tall empty chart reads as a
 * loading failure to the customer, so the register says so in one ruled line
 * instead (the EmptyState band, kept local because this sits inside a section
 * that already has its own heading).
 */
export function WeeklyBars({
  weeks,
  label,
}: {
  weeks: ThreatWeekDto[];
  label: string;
}) {
  const total = weeks.reduce((sum, week) => sum + week.detected + week.resolved, 0);

  if (total === 0) {
    return (
      <p
        className="border-y border-border/70 py-6 text-center text-sm text-muted-foreground"
        data-testid="portal-weekly-bars-empty"
      >
        {weeks.length === 0
          ? 'No history yet.'
          : `Nothing harmful found in the last ${weeks.length} ${
              weeks.length === 1 ? 'week' : 'weeks'
            }.`}
      </p>
    );
  }

  const max = Math.max(1, ...weeks.flatMap((week) => [week.detected, week.resolved]));
  return (
    <svg
      viewBox={`0 0 ${Math.max(1, weeks.length) * 28} 100`}
      role="img"
      aria-label={label}
      data-testid="portal-weekly-bars"
      className="h-40 w-full"
    >
      {/* The register's rule the bars stand on. */}
      <line x1="0" y1="85.5" x2={Math.max(1, weeks.length) * 28} y2="85.5" className="stroke-border" strokeWidth="1" />
      {weeks.map((week, index) => {
        const detectedHeight = week.detected / max * 80;
        const resolvedHeight = week.resolved / max * 80;
        return (
          <g key={week.weekStart} transform={`translate(${index * 28},0)`}>
            <rect
              x="2"
              y={85 - detectedHeight}
              width="10"
              height={detectedHeight}
              data-testid="portal-weekly-detected"
              className="fill-warning"
            />
            <rect
              x="14"
              y={85 - resolvedHeight}
              width="10"
              height={resolvedHeight}
              data-testid="portal-weekly-resolved"
              className="fill-success"
            />
          </g>
        );
      })}
    </svg>
  );
}
