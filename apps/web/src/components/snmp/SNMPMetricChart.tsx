import { useState, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { Download, Clock } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type TimeRange = '1h' | '6h' | '24h' | '7d';

type SnmpDeviceOption = {
  id: string;
  name: string;
  ipAddress: string;
  templateId: string | null;
};

type OidOption = {
  oid: string;
  name: string;
  label?: string;
  unit?: string;
};

type DataPoint = {
  timestamp: string;
  value: number | null;
};

const timeRangeLabels: Record<TimeRange, string> = {
  '1h': 'Last Hour',
  '6h': 'Last 6 Hours',
  '24h': 'Last 24 Hours',
  '7d': 'Last 7 Days'
};

const intervalMap: Record<TimeRange, string> = {
  '1h': '5m',
  '6h': '15m',
  '24h': '1h',
  '7d': '6h'
};

function formatTimestamp(ts: string, range: TimeRange): string {
  const d = new Date(ts);
  if (range === '1h' || range === '6h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (range === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
}

type Props = {
  deviceId?: string;
};

export default function SNMPMetricChart({ deviceId: initialDeviceId }: Props) {
  const [devices, setDevices] = useState<SnmpDeviceOption[]>([]);
  const [selectedDevice, setSelectedDevice] = useState(initialDeviceId ?? '');
  const [oids, setOids] = useState<OidOption[]>([]);
  const [selectedOid, setSelectedOid] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [data, setData] = useState<DataPoint[]>([]);
  const [loading, setLoading] = useState(false);

  // Load devices
  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithAuth('/snmp/devices');
        if (res.ok) {
          const json = await res.json();
          const list = json.data ?? [];
          setDevices(list);
          if (!selectedDevice && list.length > 0) setSelectedDevice(list[0].id);
        }
      } catch (err) {
        console.error('Failed to load SNMP devices:', err);
      }
    })();
  }, []);

  // Load template OIDs when device changes
  useEffect(() => {
    if (!selectedDevice) return;
    (async () => {
      try {
        const res = await fetchWithAuth(`/snmp/devices/${selectedDevice}`);
        if (res.ok) {
          const json = await res.json();
          const template = json.data?.template;
          if (template?.oids && Array.isArray(template.oids)) {
            setOids(template.oids);
            if (template.oids.length > 0) setSelectedOid(template.oids[0].oid);
          } else {
            setOids([]);
            setSelectedOid('');
          }
        }
      } catch (err) {
        console.error('Failed to load SNMP device OIDs:', err);
      }
    })();
  }, [selectedDevice]);

  // Fetch metric history
  const fetchHistory = useCallback(async () => {
    if (!selectedDevice || !selectedOid) return;
    setLoading(true);
    try {
      const now = new Date();
      const msMap: Record<TimeRange, number> = {
        '1h': 3600000,
        '6h': 21600000,
        '24h': 86400000,
        '7d': 604800000
      };
      const start = new Date(now.getTime() - msMap[timeRange]).toISOString();
      const end = now.toISOString();
      const interval = intervalMap[timeRange];

      const res = await fetchWithAuth(
        `/snmp/metrics/${selectedDevice}/${encodeURIComponent(selectedOid)}?start=${start}&end=${end}&interval=${interval}`
      );
      if (res.ok) {
        const json = await res.json();
        const series = json.data?.series ?? [];
        setData(series.map((p: any) => ({
          timestamp: p.timestamp,
          value: p.value !== null && p.value !== undefined ? Number(p.value) : null
        })));
      }
    } catch (err) {
      console.error('Failed to fetch SNMP metric history:', err);
    }
    setLoading(false);
  }, [selectedDevice, selectedOid, timeRange]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Compute stats
  const numericValues = data.filter((d) => d.value !== null).map((d) => d.value as number);
  const current = numericValues.length > 0 ? numericValues[numericValues.length - 1] : null;
  const min = numericValues.length > 0 ? Math.min(...numericValues) : null;
  const max = numericValues.length > 0 ? Math.max(...numericValues) : null;
  const avg = numericValues.length > 0 ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length : null;

  const selectedOidInfo = oids.find((o) => o.oid === selectedOid);
  const unit = selectedOidInfo?.unit ?? '';

  const stats = [
    { label: 'Current', value: current !== null ? `${current.toLocaleString()} ${unit}` : '—' },
    { label: 'Min', value: min !== null ? `${min.toLocaleString()} ${unit}` : '—' },
    { label: 'Max', value: max !== null ? `${max.toLocaleString()} ${unit}` : '—' },
    { label: 'Avg', value: avg !== null ? `${Math.round(avg).toLocaleString()} ${unit}` : '—' }
  ];

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">SNMP Metric Explorer</h2>
          <p className="text-sm text-muted-foreground">Track historical values for a single OID.</p>
        </div>
        <div className="flex items-center gap-2">
          {(Object.keys(timeRangeLabels) as TimeRange[]).map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setTimeRange(range)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                timeRange === range
                  ? 'bg-primary text-primary-foreground'
                  : 'border text-muted-foreground hover:bg-muted'
              }`}
            >
              {timeRangeLabels[range]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label className="text-sm font-medium">Device</label>
          <select
            className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.ipAddress})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">OID</label>
          <select
            className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={selectedOid}
            onChange={(e) => setSelectedOid(e.target.value)}
          >
            {oids.map((o) => (
              <option key={o.oid} value={o.oid}>
                {o.label ?? o.name} {o.unit ? `(${o.unit})` : ''}
              </option>
            ))}
            {oids.length === 0 && <option value="">No OIDs available</option>}
          </select>
        </div>
      </div>

      <div className="mt-6 h-60">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading metrics...
          </div>
        ) : data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={(ts) => formatTimestamp(ts, timeRange)}
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
                tickFormatter={(v) => v.toLocaleString()}
              />
              <Tooltip
                labelFormatter={(ts) => new Date(ts as string).toLocaleString()}
                formatter={(v: number) => [`${v.toLocaleString()} ${unit}`, selectedOidInfo?.name ?? 'Value']}
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                  fontSize: '12px'
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#6366f1"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed bg-muted/40 text-sm text-muted-foreground">
            <Clock className="mr-2 h-4 w-4" />
            {selectedOid ? 'No metric data available for this time range' : 'Select a device and OID to view metrics'}
          </div>
        )}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        {stats.map((item) => (
          <div key={item.label} className="rounded-md border bg-background p-4 text-center">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="mt-2 text-lg font-semibold">{item.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
