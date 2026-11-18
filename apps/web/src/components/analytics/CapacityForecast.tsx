import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { formatAxisLabel } from './ChartWidget';

type ForecastPoint = {
  timestamp: string;
  value: number;
  trend?: number;
};

type CapacityForecastProps = {
  title: string;
  currentValue: number;
  unit?: string;
  data: ForecastPoint[];
};

export default function CapacityForecast({
  title,
  currentValue,
  unit = '%',
  data
}: CapacityForecastProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card p-4 shadow-xs">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{t('analytics.capacityForecast.description')}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">{t('analytics.capacityForecast.current')}</p>
          <p className="text-lg font-semibold">
            {Math.round(currentValue)}{unit}
          </p>
        </div>
      </div>
      <div className="flex flex-1 u-min-h-px-240">
        {data.length === 0 ? (
          <div className="flex w-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
            {t('analytics.chartWidget.noData')}
          </div>
        ) : (
        <ResponsiveContainer width="100%" height="100%" minHeight={240}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="timestamp" tick={{ fontSize: 10 }} tickFormatter={formatAxisLabel} className="text-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" />
            <Tooltip wrapperClassName="chart-tooltip" labelFormatter={formatAxisLabel} />
            <Line
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              name={t('analytics.capacityForecast.actual')}
            />
            <Line
              type="monotone"
              dataKey="trend"
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="6 4"
              strokeWidth={2}
              dot={false}
              name={t('analytics.capacityForecast.trend')}
            />
          </LineChart>
        </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

export type { CapacityForecastProps, ForecastPoint };
