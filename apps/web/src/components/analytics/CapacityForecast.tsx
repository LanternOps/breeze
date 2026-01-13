import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine
} from 'recharts';
import { cn } from '@/lib/utils';

type ForecastPoint = {
  timestamp: string;
  value: number;
  trend?: number;
};

type Thresholds = {
  warning?: number;
  critical?: number;
};

type CapacityForecastProps = {
  title: string;
  currentValue: number;
  unit?: string;
  data: ForecastPoint[];
  thresholds?: Thresholds;
};

const tooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '12px'
};

export default function CapacityForecast({
  title,
  currentValue,
  unit = '%',
  data,
  thresholds
}: CapacityForecastProps) {
  return (
    <div className="flex h-full flex-col rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">Capacity projection based on recent usage</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Current</p>
          <p className="text-lg font-semibold">
            {Math.round(currentValue)}{unit}
          </p>
        </div>
      </div>
      <div className="flex-1" style={{ minHeight: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="timestamp" tick={{ fontSize: 10 }} className="text-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" />
            <Tooltip contentStyle={tooltipStyle} />
            {thresholds?.warning !== undefined && (
              <ReferenceLine
                y={thresholds.warning}
                stroke="hsl(var(--warning))"
                strokeDasharray="4 4"
                label={{ value: 'Warning', position: 'right', fontSize: 10 }}
              />
            )}
            {thresholds?.critical !== undefined && (
              <ReferenceLine
                y={thresholds.critical}
                stroke="hsl(var(--destructive))"
                strokeDasharray="4 4"
                label={{ value: 'Critical', position: 'right', fontSize: 10 }}
              />
            )}
            <Line
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              name="Actual"
            />
            <Line
              type="monotone"
              dataKey="trend"
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="6 4"
              strokeWidth={2}
              dot={false}
              name="Trend"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {thresholds && (
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          {thresholds.warning !== undefined && (
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-warning" />
              Warn {thresholds.warning}{unit}
            </span>
          )}
          {thresholds.critical !== undefined && (
            <span className={cn('inline-flex items-center gap-1', 'text-destructive')}>
              <span className="h-2 w-2 rounded-full bg-destructive" />
              Critical {thresholds.critical}{unit}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export type { CapacityForecastProps, ForecastPoint, Thresholds };
