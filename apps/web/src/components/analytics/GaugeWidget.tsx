import { cn } from '@/lib/utils';

type GaugeThresholds = {
  warning?: number;
  critical?: number;
};

type GaugeWidgetProps = {
  title: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  thresholds?: GaugeThresholds;
  description?: string;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export default function GaugeWidget({
  title,
  value,
  min = 0,
  max = 100,
  unit = '%',
  thresholds,
  description
}: GaugeWidgetProps) {
  const normalized = clamp((value - min) / (max - min), 0, 1);
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - normalized * circumference;

  let status: 'good' | 'warning' | 'critical' = 'good';
  if (thresholds?.critical !== undefined && value >= thresholds.critical) {
    status = 'critical';
  } else if (thresholds?.warning !== undefined && value >= thresholds.warning) {
    status = 'warning';
  }

  const statusColor =
    status === 'critical' ? 'text-destructive' : status === 'warning' ? 'text-warning' : 'text-success';

  return (
    <div className="flex h-full flex-col justify-between rounded-lg border bg-card p-4 shadow-sm">
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="relative mt-4 flex items-center justify-center">
        <svg width="140" height="140" viewBox="0 0 140 140" className="-rotate-90">
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="transparent"
            stroke="hsl(var(--muted))"
            strokeWidth="12"
          />
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="transparent"
            stroke="currentColor"
            strokeWidth="12"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className={statusColor}
          />
        </svg>
        <div className="absolute text-center">
          <div className={cn('text-2xl font-semibold', statusColor)}>
            {Math.round(value)}{unit}
          </div>
          <div className="text-xs text-muted-foreground">
            {min}-{max}{unit}
          </div>
        </div>
      </div>
      {thresholds && (
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>Warn {thresholds.warning ?? '-'}</span>
          <span>Critical {thresholds.critical ?? '-'}</span>
        </div>
      )}
    </div>
  );
}

export type { GaugeWidgetProps, GaugeThresholds };
