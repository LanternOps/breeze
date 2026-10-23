import { useTranslation } from 'react-i18next';
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
  /** Nothing to evaluate: render an empty state, not a (green) 0%. */
  empty?: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export default function GaugeWidget({
  title,
  value,
  min = 0,
  max = 100,
  unit = '%',
  thresholds,
  description,
  empty = false
}: GaugeWidgetProps) {
  const { t } = useTranslation('reports');
  if (empty) {
    return (
      <div className="flex h-full flex-col rounded-lg border bg-card p-4 shadow-xs">
        <p className="text-sm font-semibold">{title}</p>
        <div className="mt-4 flex flex-1 items-center justify-center rounded-md border border-dashed py-10 text-xs text-muted-foreground">
          {t('analytics.gaugeWidget.noData')}
        </div>
      </div>
    );
  }
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
    <div className="flex h-full flex-col justify-between rounded-lg border bg-card p-4 shadow-xs">
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
          <span>{t('analytics.gaugeWidget.warnValue', { value: thresholds.warning ?? '-' })}</span>
          <span>{t('analytics.gaugeWidget.criticalValue', { value: thresholds.critical ?? '-' })}</span>
        </div>
      )}
    </div>
  );
}

export type { GaugeWidgetProps, GaugeThresholds };
