import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip
} from 'recharts';
import { minHeightPxClass } from '@/lib/utils';
import { formatNumber } from '@/lib/utils';
import { formatPercent } from '@/lib/i18n/format';

type ChartType = 'line' | 'bar' | 'area' | 'pie';

type ChartSeries = {
  key: string;
  label: string;
  color?: string;
};

type ChartWidgetProps = {
  title: string;
  subtitle?: string;
  type: ChartType;
  data: Array<Record<string, number | string>>;
  xKey?: string;
  series?: ChartSeries[];
  nameKey?: string;
  valueKey?: string;
  height?: number;
};

// Theme-token palette so both light and dark mode resolve per-theme values;
// order mirrors the dashboard's series precedence (brand, then status hues).
const defaultColors = [
  'hsl(var(--primary))',
  'hsl(var(--success))',
  'hsl(var(--warning-strong))',
  'hsl(var(--info))',
  'hsl(var(--destructive))',
  'hsl(var(--chart-neutral))'
];

const axisTick = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' };

/** ISO timestamps render as short localized dates; anything else passes through. */
const formatAxisLabel = (value: unknown): string => {
  const raw = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export default function ChartWidget({
  title,
  subtitle,
  type,
  data,
  xKey = 'timestamp',
  series,
  nameKey = 'name',
  valueKey = 'value',
  height = 280
}: ChartWidgetProps) {
  const { t } = useTranslation('reports');
  const derivedSeries = useMemo(() => {
    if (series && series.length > 0) return series;
    const first = data[0];
    if (!first || type === 'pie') return [];
    return Object.keys(first)
      .filter(key => key !== xKey && typeof first[key] === 'number')
      .map((key, index) => ({ key, label: key, color: defaultColors[index % defaultColors.length] }));
  }, [data, series, type, xKey]);

  const pieTotal = useMemo(
    () => (type === 'pie' ? data.reduce((sum, entry) => sum + Number(entry[valueKey] ?? 0), 0) : 0),
    [data, type, valueKey]
  );

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-4 flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <div className={`flex flex-1 ${minHeightPxClass(height)}`}>
        {data.length === 0 ? (
          <div className="flex w-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
            {t('analytics.chartWidget.noData')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {type === 'line' ? (
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey={xKey} tick={axisTick} tickFormatter={formatAxisLabel} tickLine={false} axisLine={false} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} width={32} />
                <Tooltip wrapperClassName="chart-tooltip" labelFormatter={formatAxisLabel} />
                {derivedSeries.map((item, index) => (
                  <Line
                    key={item.key}
                    type="monotone"
                    dataKey={item.key}
                    name={item.label}
                    stroke={item.color || defaultColors[index % defaultColors.length]}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            ) : type === 'bar' ? (
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey={xKey} tick={axisTick} tickFormatter={formatAxisLabel} tickLine={false} axisLine={false} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} width={32} />
                <Tooltip wrapperClassName="chart-tooltip" labelFormatter={formatAxisLabel} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
                {derivedSeries.map((item, index) => (
                  <Bar
                    key={item.key}
                    dataKey={item.key}
                    name={item.label}
                    fill={item.color || defaultColors[index % defaultColors.length]}
                    radius={[4, 4, 0, 0]}
                  />
                ))}
              </BarChart>
            ) : type === 'area' ? (
              <AreaChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey={xKey} tick={axisTick} tickFormatter={formatAxisLabel} tickLine={false} axisLine={false} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} width={32} />
                <Tooltip wrapperClassName="chart-tooltip" labelFormatter={formatAxisLabel} />
                {derivedSeries.map((item, index) => (
                  <Area
                    key={item.key}
                    type="monotone"
                    dataKey={item.key}
                    name={item.label}
                    stroke={item.color || defaultColors[index % defaultColors.length]}
                    fill={item.color || defaultColors[index % defaultColors.length]}
                    fillOpacity={0.2}
                  />
                ))}
              </AreaChart>
            ) : (
              <PieChart>
                <Tooltip wrapperClassName="chart-tooltip" />
                <Pie
                  data={data}
                  dataKey={valueKey}
                  nameKey={nameKey}
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="90%"
                  paddingAngle={3}
                  strokeWidth={0}
                >
                  {data.map((entry, index) => (
                    <Cell key={`${entry[nameKey]}-${index}`} fill={defaultColors[index % defaultColors.length]} />
                  ))}
                </Pie>
              </PieChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
      {(type === 'line' || type === 'area' || type === 'bar') && derivedSeries.length > 1 && data.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {derivedSeries.map((item, index) => (
            <span key={item.key} className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: item.color || defaultColors[index % defaultColors.length] }}
                aria-hidden="true"
              />
              {item.label}
            </span>
          ))}
        </div>
      )}
      {type === 'pie' && data.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-xs">
          {data.map((entry, index) => {
            const value = Number(entry[valueKey] ?? 0);
            return (
              <li key={`${entry[nameKey]}-${index}`} className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: defaultColors[index % defaultColors.length] }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{String(entry[nameKey])}</span>
                <span className="font-medium tabular-nums">{formatNumber(value)}</span>
                <span className="w-10 text-right text-muted-foreground tabular-nums">
                  {pieTotal > 0 ? formatPercent(value / pieTotal, { maximumFractionDigits: 0 }) : '–'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export type { ChartWidgetProps, ChartType, ChartSeries };
