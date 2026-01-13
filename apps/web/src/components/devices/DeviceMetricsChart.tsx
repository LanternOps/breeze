import { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';

type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d';

type DeviceMetricsChartProps = {
  compact?: boolean;
  deviceId?: string;
};

type MetricDataPoint = {
  timestamp: string;
  cpu: number;
  ram: number;
  disk: number;
};

// Generate mock data for the chart
function generateMockData(range: TimeRange): MetricDataPoint[] {
  const points: MetricDataPoint[] = [];
  const now = new Date();
  let count: number;
  let intervalMs: number;

  switch (range) {
    case '1h':
      count = 60;
      intervalMs = 60 * 1000; // 1 minute
      break;
    case '6h':
      count = 72;
      intervalMs = 5 * 60 * 1000; // 5 minutes
      break;
    case '24h':
      count = 96;
      intervalMs = 15 * 60 * 1000; // 15 minutes
      break;
    case '7d':
      count = 168;
      intervalMs = 60 * 60 * 1000; // 1 hour
      break;
    case '30d':
      count = 180;
      intervalMs = 4 * 60 * 60 * 1000; // 4 hours
      break;
    default:
      count = 60;
      intervalMs = 60 * 1000;
  }

  let cpuBase = 35;
  let ramBase = 55;
  let diskBase = 45;

  for (let i = count - 1; i >= 0; i--) {
    const timestamp = new Date(now.getTime() - i * intervalMs);

    // Add some variation to the data
    cpuBase += (Math.random() - 0.5) * 10;
    cpuBase = Math.max(10, Math.min(95, cpuBase));

    ramBase += (Math.random() - 0.5) * 5;
    ramBase = Math.max(30, Math.min(90, ramBase));

    diskBase += (Math.random() - 0.5) * 0.5;
    diskBase = Math.max(40, Math.min(70, diskBase));

    points.push({
      timestamp: timestamp.toISOString(),
      cpu: Math.round(cpuBase),
      ram: Math.round(ramBase),
      disk: Math.round(diskBase * 10) / 10
    });
  }

  return points;
}

function formatTimestamp(timestamp: string, range: TimeRange): string {
  const date = new Date(timestamp);

  switch (range) {
    case '1h':
    case '6h':
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    case '24h':
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    case '7d':
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
    case '30d':
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    default:
      return date.toLocaleTimeString();
  }
}

const timeRangeLabels: Record<TimeRange, string> = {
  '1h': 'Last Hour',
  '6h': 'Last 6 Hours',
  '24h': 'Last 24 Hours',
  '7d': 'Last 7 Days',
  '30d': 'Last 30 Days'
};

export default function DeviceMetricsChart({ compact = false, deviceId }: DeviceMetricsChartProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [visibleMetrics, setVisibleMetrics] = useState({
    cpu: true,
    ram: true,
    disk: true
  });

  const data = useMemo(() => generateMockData(timeRange), [timeRange]);

  const toggleMetric = (metric: 'cpu' | 'ram' | 'disk') => {
    setVisibleMetrics(prev => ({ ...prev, [metric]: !prev[metric] }));
  };

  if (compact) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">Performance</h3>
          <select
            value={timeRange}
            onChange={e => setTimeRange(e.target.value as TimeRange)}
            className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {Object.entries(timeRangeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={(value) => formatTimestamp(value, timeRange)}
                tick={{ fontSize: 10 }}
                className="text-muted-foreground"
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10 }}
                className="text-muted-foreground"
                width={30}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '0.5rem',
                  fontSize: '12px'
                }}
                labelFormatter={(value) => new Date(value).toLocaleString()}
              />
              <Line
                type="monotone"
                dataKey="cpu"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                name="CPU"
              />
              <Line
                type="monotone"
                dataKey="ram"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
                name="RAM"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold">Performance Metrics</h3>
          <p className="text-sm text-muted-foreground">
            Real-time system resource utilization
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => toggleMetric('cpu')}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                visibleMetrics.cpu
                  ? 'border-blue-500 bg-blue-500/10 text-blue-700'
                  : 'border-muted text-muted-foreground hover:border-blue-500/50'
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              CPU
            </button>
            <button
              type="button"
              onClick={() => toggleMetric('ram')}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                visibleMetrics.ram
                  ? 'border-green-500 bg-green-500/10 text-green-700'
                  : 'border-muted text-muted-foreground hover:border-green-500/50'
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-green-500" />
              RAM
            </button>
            <button
              type="button"
              onClick={() => toggleMetric('disk')}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                visibleMetrics.disk
                  ? 'border-purple-500 bg-purple-500/10 text-purple-700'
                  : 'border-muted text-muted-foreground hover:border-purple-500/50'
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-purple-500" />
              Disk
            </button>
          </div>
          <select
            value={timeRange}
            onChange={e => setTimeRange(e.target.value as TimeRange)}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {Object.entries(timeRangeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(value) => formatTimestamp(value, timeRange)}
              tick={{ fontSize: 12 }}
              className="text-muted-foreground"
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 12 }}
              className="text-muted-foreground"
              tickFormatter={(value) => `${value}%`}
              width={45}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '0.5rem'
              }}
              labelFormatter={(value) => new Date(value).toLocaleString()}
              formatter={(value: number, name: string) => [`${value}%`, name]}
            />
            <Legend />
            {visibleMetrics.cpu && (
              <Line
                type="monotone"
                dataKey="cpu"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                name="CPU"
                activeDot={{ r: 4 }}
              />
            )}
            {visibleMetrics.ram && (
              <Line
                type="monotone"
                dataKey="ram"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
                name="RAM"
                activeDot={{ r: 4 }}
              />
            )}
            {visibleMetrics.disk && (
              <Line
                type="monotone"
                dataKey="disk"
                stroke="#a855f7"
                strokeWidth={2}
                dot={false}
                name="Disk"
                activeDot={{ r: 4 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-blue-500" />
            <span className="text-sm font-medium">CPU</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold">{data[data.length - 1]?.cpu ?? 0}%</span>
            <span className="text-xs text-muted-foreground">current</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Avg: {Math.round(data.reduce((sum, d) => sum + d.cpu, 0) / data.length)}% |
            Max: {Math.max(...data.map(d => d.cpu))}%
          </div>
        </div>

        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-green-500" />
            <span className="text-sm font-medium">RAM</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold">{data[data.length - 1]?.ram ?? 0}%</span>
            <span className="text-xs text-muted-foreground">current</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Avg: {Math.round(data.reduce((sum, d) => sum + d.ram, 0) / data.length)}% |
            Max: {Math.max(...data.map(d => d.ram))}%
          </div>
        </div>

        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-purple-500" />
            <span className="text-sm font-medium">Disk</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold">{data[data.length - 1]?.disk ?? 0}%</span>
            <span className="text-xs text-muted-foreground">current</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Avg: {Math.round(data.reduce((sum, d) => sum + d.disk, 0) / data.length * 10) / 10}% |
            Max: {Math.max(...data.map(d => d.disk))}%
          </div>
        </div>
      </div>
    </div>
  );
}
