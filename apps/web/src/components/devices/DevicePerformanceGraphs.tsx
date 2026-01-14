import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
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

type TimeRange = '24h' | '7d' | '30d';

type MetricPoint = {
  timestamp: string;
  cpu: number;
  ram: number;
  disk: number;
};

type DevicePerformanceGraphsProps = {
  deviceId: string;
  compact?: boolean;
};

const rangeLabels: Record<TimeRange, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d'
};

const rangeIntervals: Record<TimeRange, string> = {
  '24h': '5m',
  '7d': '1h',
  '30d': '1d'
};

function formatTimestamp(value: string, range: TimeRange) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (range === '24h') {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (range === '7d') {
    return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function DevicePerformanceGraphs({ deviceId, compact = false }: DevicePerformanceGraphsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [data, setData] = useState<MetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - (
        timeRange === '24h' ? 24 * 60 * 60 * 1000 :
        timeRange === '7d' ? 7 * 24 * 60 * 60 * 1000 :
        30 * 24 * 60 * 60 * 1000
      ));

      const params = new URLSearchParams({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        interval: rangeIntervals[timeRange]
      });

      const response = await fetch(`/api/devices/${deviceId}/metrics?${params}`);
      if (!response.ok) throw new Error('Failed to fetch performance metrics');
      const json = await response.json();
      const payload = json?.data ?? json;
      const normalized = Array.isArray(payload)
        ? payload.map((point: Record<string, unknown>) => ({
            timestamp: String(point.timestamp ?? point.time ?? point.ts ?? ''),
            cpu: Number(point.cpu ?? point.cpuPercent ?? 0),
            ram: Number(point.ram ?? point.ramPercent ?? 0),
            disk: Number(point.disk ?? point.diskPercent ?? 0)
          }))
        : [];
      setData(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch performance metrics');
    } finally {
      setLoading(false);
    }
  }, [deviceId, timeRange]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const latest = useMemo(() => data[data.length - 1], [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading performance graphs...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchMetrics}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border bg-card shadow-sm ${compact ? 'p-4' : 'p-6'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold">Performance Graphs</h3>
            {!compact && (
              <p className="text-sm text-muted-foreground">CPU, RAM, and disk usage over time</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(Object.keys(rangeLabels) as TimeRange[]).map(range => (
            <button
              key={range}
              type="button"
              onClick={() => setTimeRange(range)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                timeRange === range
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:border-muted-foreground hover:text-foreground'
              }`}
            >
              {rangeLabels[range]}
            </button>
          ))}
        </div>
      </div>

      <div className={compact ? 'mt-4 h-56' : 'mt-6 h-80'}>
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
              tickFormatter={(value) => `${value}%`}
              className="text-muted-foreground"
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
            {!compact && <Legend />}
            <Line type="monotone" dataKey="cpu" stroke="#3b82f6" strokeWidth={2} dot={false} name="CPU" />
            <Line type="monotone" dataKey="ram" stroke="#22c55e" strokeWidth={2} dot={false} name="RAM" />
            <Line type="monotone" dataKey="disk" stroke="#a855f7" strokeWidth={2} dot={false} name="Disk" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {!compact && latest && (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border p-4">
            <div className="text-xs text-muted-foreground">CPU (latest)</div>
            <div className="mt-1 text-2xl font-bold">{Math.round(latest.cpu)}%</div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-xs text-muted-foreground">RAM (latest)</div>
            <div className="mt-1 text-2xl font-bold">{Math.round(latest.ram)}%</div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-xs text-muted-foreground">Disk (latest)</div>
            <div className="mt-1 text-2xl font-bold">{Math.round(latest.disk)}%</div>
          </div>
        </div>
      )}
    </div>
  );
}
