import type { ThreatWeekDto } from '@breeze/shared';

export function WeeklyBars({
  weeks,
  label,
}: {
  weeks: ThreatWeekDto[];
  label: string;
}) {
  const max = Math.max(1, ...weeks.flatMap((week) => [week.detected, week.resolved]));
  return (
    <svg
      viewBox={`0 0 ${Math.max(1, weeks.length) * 28} 100`}
      role="img"
      aria-label={label}
      data-testid="portal-weekly-bars"
      className="h-40 w-full"
    >
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
