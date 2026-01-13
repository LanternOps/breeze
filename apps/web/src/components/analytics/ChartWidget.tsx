import { useMemo } from 'react';
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
  Tooltip,
  Legend
} from 'recharts';

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

const defaultColors = ['#2563eb', '#22c55e', '#f97316', '#0ea5e9', '#a855f7', '#ef4444'];

const tooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '12px'
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
  const derivedSeries = useMemo(() => {
    if (series && series.length > 0) return series;
    const first = data[0];
    if (!first || type === 'pie') return [];
    return Object.keys(first)
      .filter(key => key !== xKey && typeof first[key] === 'number')
      .map((key, index) => ({ key, label: key, color: defaultColors[index % defaultColors.length] }));
  }, [data, series, type, xKey]);

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex-1" style={{ minHeight: height }}>
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
            No data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {type === 'line' ? (
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey={xKey} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
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
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey={xKey} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
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
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey={xKey} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
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
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Pie
                  data={data}
                  dataKey={valueKey}
                  nameKey={nameKey}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={4}
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
    </div>
  );
}

export type { ChartWidgetProps, ChartType, ChartSeries };
