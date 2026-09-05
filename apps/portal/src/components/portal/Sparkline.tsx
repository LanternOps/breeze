import { cn } from '@/lib/utils';

/** The tones a reading may take. Default is the portal's one working accent —
 *  a sparkline left on `currentColor` picks up whatever ink surrounds it and
 *  disappears into muted body copy. */
export type SparklineTone = 'primary' | 'success' | 'warning' | 'destructive';

/* The base status tokens are tuned as fills; as a 3px line on the plaster
   ground they read thin, so a toned reading takes the darker `-on-tint`
   variant. Service green is dark enough to stand as-is. */
const TONE_INK: Record<SparklineTone, string> = {
  primary: 'text-primary',
  success: 'text-success-on-tint',
  warning: 'text-warning-on-tint',
  destructive: 'text-destructive-on-tint',
};

export function Sparkline({
  values,
  label,
  tone = 'primary',
}: {
  values: number[];
  label: string;
  tone?: SparklineTone;
}) {
  const width = 160;
  const height = 48;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : index * width / (values.length - 1);
      const y = height - ((value - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      data-testid="portal-sparkline"
      className={cn('h-12 w-full', TONE_INK[tone])}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
